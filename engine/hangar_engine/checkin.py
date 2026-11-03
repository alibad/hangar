"""A check-in on a past session: was its work finished, is something left, or did other work finish it later.

Hangar works this out from evidence, for one session or a whole list at once, without running an agent:
  - what was asked (the conversation's first request) and how it ended (its last reply, the Claude app's status line,
    or a turn that never finished);
  - what it committed, and whether those commits reached a remote;
  - which files it edited are still uncommitted in the project's checkout;
  - which later commits, by other sessions, changed the files it edited.
The verdict is done, left, elsewhere (finished by later work), unclear or working, with the reasons in plain words.
"Ask Claude" goes further: a read-only Claude Code job reads the whole conversation and the project and gives its own
verdict, kept beside Hangar's. Check-ins describe private work: local engine storage only.
"""
import json
import re
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

from . import activity, codex_library, config, session_index, session_library, work

VERDICTS = ("done", "left", "elsewhere", "unclear", "working")
_lock = threading.Lock()
_TAG = re.compile(r"<(system-reminder|command-[a-z-]+|local-command-[a-z-]+|environment_context|user_instructions)>.*?</\1>", re.S)


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def path():
    return config.LOCAL / "checkins.json"


def read():
    return config.read_json(path(), {}) or {}


def current(saved, row):
    """The saved check-in for a session row, while nothing has happened in the session since."""
    found = saved.get(row["key"])
    return found if found and found.get("activityAt") == row["activityAt"] else None


# --- the conversation: what was asked and how it ended ---------------------------------------------------------------

def _text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") in ("text", "input_text", "output_text"))
    return ""


def _clean(text, limit):
    task = re.match(r'\s*<scheduled-task name="([^"]+)"', text or "")
    if task:
        return f"Scheduled task: {task.group(1)}"
    text = _TAG.sub("", text or "")
    text = re.sub(r"<[a-z_-]+>.*?</[a-z_-]+>", "", text, flags=re.S) if text.lstrip().startswith("<") else text
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit] + ("…" if len(text) > limit else "")


def _lines(file, tail=False, size=262144):
    try:
        with open(file, "rb") as f:
            if tail:
                f.seek(0, 2)
                end = f.tell()
                f.seek(max(0, end - size))
            raw = f.read(size)
    except OSError:
        return []
    lines = raw.decode("utf-8", errors="replace").splitlines()
    return lines[1:] if tail and len(lines) > 1 else lines


def _record(line):
    try:
        record = json.loads(line)
        return record if isinstance(record, dict) else None
    except ValueError:
        return None


def _said(record, who):
    """The text of a person's request (who="user") or the agent's reply (who="agent") in one transcript line, else ""."""
    if record.get("type") in ("user", "assistant"):  # Claude Code
        if record.get("isMeta") or record.get("isSidechain") or (record["type"] == "user") != (who == "user"):
            return ""
        message = record.get("message") or {}
        content = message.get("content")
        if who == "user" and isinstance(content, list) and any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content):
            return ""
        return _text(content)
    payload = record.get("payload") or {}
    if record.get("type") == "event_msg":  # Codex
        if who == "user" and payload.get("type") == "user_message":
            return payload.get("message") or ""
        if who == "agent" and payload.get("type") == "agent_message":
            return payload.get("message") or ""
    return ""


def conversation(file):
    """{"asked": the first request, "answer": the last reply}, each cut short, from the start and end of a transcript."""
    if not file:
        return {"asked": "", "answer": ""}
    asked = next((t for line in _lines(file) if (r := _record(line)) and (t := _clean(_said(r, "user"), 400))), "")
    answer = ""
    for size in (262144, 4194304):  # the last reply can sit behind long tool output
        answer = next((t for line in reversed(_lines(file, tail=True, size=size)) if (r := _record(line)) and (t := _clean(_said(r, "agent"), 600))), "")
        if answer:
            break
    return {"asked": asked, "answer": answer}


# --- the project: commits, pushes, leftovers and later work ------------------------------------------------------------

def _repo_state(folder):
    """Uncommitted paths (lower case, relative) and the commits on no remote, for one checkout."""
    dirty = set()
    for line in activity.git(folder, "status", "--porcelain=v1", "-uall").splitlines():
        name = line[3:].strip().strip('"')
        if " -> " in name:
            name = name.split(" -> ")[-1]
        if name:
            dirty.add(name.replace("\\", "/").lower())
    unpushed = set(activity.git(folder, "rev-list", "--branches", "--not", "--remotes", "--max-count=2000").split())
    tracked = {n.replace("\\", "/").lower() for n in activity.git(folder, "ls-files", "-z").split("\0") if n}
    return {"dirty": dirty, "unpushed": unpushed, "tracked": tracked}


def assess(doc, overlay, rows, titles, now_at=None):
    """{session key: check-in} for these session rows (from the session library), worked out together so each project
    is read once. titles names every session, for the later work found."""
    now_at = time.time() if now_at is None else now_at
    index = session_index.collect()["files"]
    by_key = {e["provider"] + ":" + e["id"]: (p, e) for p, e in index.items()}
    repos = {r["id"]: r for r in doc["repos"]}
    wanted = {p["id"] for row in rows for p in row["projects"] if p["id"] in repos}
    oldest = min((session_library.stamp(row["activityAt"]) for row in rows), default=now_at)
    days = max(30, min(400, int((now_at - oldest) // 86400) + 2))
    made = activity.claimed(doc, overlay, wanted, days=days, now=now_at)
    checkouts = {rid: folders[0] for rid in wanted if (folders := activity.folders_of(repos[rid], overlay))}
    with ThreadPoolExecutor(max_workers=8) as pool:
        states = dict(zip(checkouts, pool.map(_repo_state, checkouts.values())))
        histories = dict(zip(checkouts, pool.map(lambda f: activity.log(f, oldest - 60, now_at), checkouts.values())))
    entries = list(index.values())
    prefixes = {rid: sorted({session_index.norm(str(f)) for f in activity.folders_of(repos[rid], overlay)}, key=len, reverse=True) for rid in checkouts}
    claims = {rid: activity.attribute(histories[rid]["commits"], entries, prefixes[rid]) for rid in checkouts}
    threads = codex_library.snapshot()["threads"] if any(row["provider"] == "codex" for row in rows) else {}
    out = {}
    for row in rows:
        file, entry = by_key.get(row["key"], (None, None))
        talk = conversation(file)
        if not file and row["provider"] == "codex":  # Codex compresses older transcripts; its database keeps the first request
            talk["asked"] = _clean((threads.get(row["id"]) or {}).get("first_user_message") or "", 400)
        out[row["key"]] = verdict(row, entry, talk, made.get(row["key"], []), checkouts, states, histories, claims, prefixes, titles)
    return out


def verdict(row, entry, talk, own, checkouts, states, histories, claims, prefixes, titles):
    end = session_library.stamp(row["activityAt"])
    edited, leftovers, later, unpushed = 0, [], [], []
    for project in row["projects"]:
        rid = project["id"]
        if rid not in checkouts or project.get("evidence") != "edit-tool":
            continue
        # Files git ignores (build output, local notes) can never be committed, so they say nothing about what is left.
        mine = {f.lower() for f in project["files"]} & (states[rid]["tracked"] | states[rid]["dirty"])
        edited += len(mine)
        leftovers += sorted(f for f in mine if f in states[rid]["dirty"])
        unpushed += [c for c in own if c["repoId"] == rid and any(s.startswith(c["sha"]) for s in states[rid]["unpushed"])]
        for commit in histories[rid]["commits"]:
            claim = claims[rid].get(commit["sha"])
            if commit["at"] <= end + 60 or (claim and claim["session"] == row["key"]):
                continue
            if mine & {f.lower() for f in commit["files"]}:
                who = claim["session"] if claim else None
                later.append({"sha": commit["short"], "subject": commit["subject"], "at": session_library.iso(commit["at"]),
                              "project": project["name"], "session": who, "sessionTitle": titles.get(who, "") if who else ""})
    later.sort(key=lambda c: c["at"])
    status = row.get("status") or {}
    waiting = status.get("category") == "blocked" or bool(status.get("needsAction"))
    stopped = row.get("state") in ("working", "interrupted") and not row.get("working")
    pushed = [c for c in own if c not in unpushed]
    reasons = []
    if own:
        reasons.append(f"Committed {len(own)} {'change' if len(own) == 1 else 'changes'}" + (f"; {len(unpushed)} not pushed" if unpushed else ", all pushed"))
    if leftovers:
        reasons.append(f"{len(leftovers)} of the files it edited {'is' if len(leftovers) == 1 else 'are'} still uncommitted")
    if later:
        others = sorted({c["sessionTitle"] for c in later if c["sessionTitle"]})
        reasons.append(f"{len(later)} later {'commit' if len(later) == 1 else 'commits'} changed its files" + (f" (in “{others[0]}”{f' and {len(others) - 1} more' if len(others) > 1 else ''})" if others else ""))
    if waiting:
        reasons.append("It ended waiting on you" + (f": {status.get('needsAction') or status.get('detail')}" if status.get("needsAction") or status.get("detail") else ""))
    if stopped:
        reasons.append("Its last turn never finished")
    if row.get("working"):
        result, headline = "working", "It is working right now."
    elif unpushed:
        result, headline = "left", f"{len(unpushed)} of its commits never reached the remote."
    elif leftovers and not later:
        result, headline = "left", "It left edits uncommitted."
    elif leftovers:
        result, headline = "left", "Its files are still uncommitted, though later work touched them too."
    elif waiting:
        result, headline = "left", "It stopped to ask you something."
    elif (stopped or (edited and not own)) and later:
        result, headline = "elsewhere", "Later work picked up where it stopped."
    elif stopped:
        result, headline = "unclear", "It stopped mid-turn; nothing shows it was finished."
    elif edited and not own:
        result, headline = "unclear", "It edited files, but no commit carries its changes."
    elif own:
        result, headline = "done", "Its work is committed and pushed."
    elif talk["answer"]:
        result, headline = "done", "It answered and edited no project files."
    elif row["provider"] == "codex" and talk["asked"]:
        result, headline = "unclear", "Codex has compressed this conversation, so only its first request is readable here. Open it in Codex to see how it ended."
    else:
        result, headline = "unclear", "Hangar has too little to go on."
    return {"verdict": result, "headline": headline, "reasons": reasons, "asked": talk["asked"], "answer": talk["answer"],
            "commits": len(own), "pushed": len(pushed), "unpushed": [c["sha"] for c in unpushed], "leftovers": leftovers[:20],
            "later": later[-8:], "activityAt": row["activityAt"], "checkedAt": now(), "by": "hangar"}


def run(doc, overlay, keys):
    """Check these sessions now and keep the results; returns {key: check-in}."""
    rows = {r["key"]: r for r in session_library.snapshot(doc, overlay)["sessions"]}
    if not isinstance(keys, list) or not 1 <= len(keys) <= 600 or any(k not in rows for k in keys):
        raise ValueError("Choose 1–600 known sessions on this machine.")
    found = assess(doc, overlay, [rows[k] for k in keys], {k: r["title"] for k, r in rows.items()})
    with _lock:
        saved = read()
        for key, result in found.items():
            deep = (saved.get(key) or {}).get("claude")
            saved[key] = {**result, **({"claude": deep} if deep and deep.get("activityAt") == result["activityAt"] else {})}
        config.write_json(path(), saved)
    return {"checkins": found}


# --- Ask Claude: a read-only job reads the whole conversation ---------------------------------------------------------

def ask(doc, overlay, body):
    key = body.get("ask") or body.get("session")
    row = next((r for r in session_library.snapshot(doc, overlay)["sessions"] if r["key"] == key), None)
    if not row:
        raise ValueError("That session is not indexed on this machine.")
    file = next((p for p, e in session_index.collect()["files"].items() if e["provider"] + ":" + e["id"] == key), None)
    if not file:
        raise ValueError("Hangar has no transcript for this session, so there is nothing for Claude to read.")
    rid = next((p["id"] for p in row["projects"] if _has_checkout(doc, overlay, p["id"])), None)
    if not rid:
        raise ValueError("None of this session's projects has a checkout on this machine to check against.")
    hangar = run(doc, overlay, [key])["checkins"][key]
    cid = uuid.uuid4().hex[:12]
    out = config.LOCAL / "checkins" / cid
    out.mkdir(parents=True, exist_ok=True)
    (out / "evidence.json").write_text(json.dumps({k: hangar[k] for k in ("verdict", "headline", "reasons", "asked", "leftovers", "later", "unpushed")}, indent=2), encoding="utf-8")
    agent = "Codex" if row["provider"] == "codex" else "Claude Code"
    text = (f"You are checking in on a past {agent} session titled “{row['title'][:200]}”, read-only.\n"
            f"Its conversation is {file} (one JSON object per line; it can be very large, so search it and read the "
            "first request and the last replies rather than all of it). Hangar's evidence about it is in "
            f"{out / 'evidence.json'}. The project is the current folder, as it is now.\n"
            "Decide whether what the person asked for is finished: done (finished and committed or answered), left "
            "(something remains: name it), elsewhere (later work finished it: say where) or unclear. Do not edit, create "
            "or delete any file and do not run anything that changes the project. End your reply with one ```json block: "
            '{"verdict": "done|left|elsewhere|unclear", "summary": "one or two sentences", "left": ["what remains"], "where": "where it was finished, if elsewhere"}')
    record = {"state": "running", "startedAt": now(), "activityAt": row["activityAt"], "id": cid}
    _keep_claude(key, record)
    started = work.begin(doc, overlay, rid, "claude", text, kind="checkin", read_dirs=[Path(file).parent, out],
                         label=f"Check in on: {row['title'][:80]}", meta={"checkin": cid, "checkinOf": key},
                         on_finish=lambda job, reply: _finish(key, cid, job, reply))
    _keep_claude(key, {**record, "job": started["id"]})
    return {"job": started["id"], "id": cid}


def _has_checkout(doc, overlay, rid):
    repo = next((r for r in doc["repos"] if r["id"] == rid), None)
    return bool(repo and activity.folders_of(repo, overlay))


def _keep_claude(key, record):
    with _lock:
        saved = read()
        saved.setdefault(key, {"activityAt": record.get("activityAt")})["claude"] = record
        config.write_json(path(), saved)


def _finish(key, cid, job, reply):
    base = {"id": cid, "endedAt": now(), "activityAt": (read().get(key, {}).get("claude") or {}).get("activityAt")}
    try:
        if job["state"] != "completed":
            failed = " ".join(o["text"] for o in job["output"])
            return _keep_claude(key, {**base, "state": "failed", "message": work.failure_hint(failed) or "Claude stopped before replying."})
        found = parse(reply)
        if not found:
            return _keep_claude(key, {**base, "state": "failed", "message": "Claude replied without a verdict in the agreed format."})
        _keep_claude(key, {**base, "state": "done", **found})
        work.note(job["id"], f"Check-in saved: {found['verdict']}.")
    except Exception as error:  # a crashed parse must not leave the check-in looking busy forever
        _keep_claude(key, {**base, "state": "failed", "message": f"Hangar could not read the check-in: {error}"})


def parse(reply):
    for block in reversed(re.findall(r"```json\s*(.*?)```", reply or "", flags=re.S)):
        try:
            found = json.loads(block)
        except ValueError:
            continue
        if isinstance(found, dict) and found.get("verdict") in VERDICTS[:4]:
            return {"verdict": found["verdict"], "summary": str(found.get("summary") or "")[:1200],
                    "left": [str(x)[:300] for x in (found.get("left") or []) if x][:10], "where": str(found.get("where") or "")[:400]}
    return None
