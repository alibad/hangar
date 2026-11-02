"""Cross-agent code review: one coding agent reviews what another agent's session changed, read-only.

A Claude Code session goes to Codex, a Codex session to Claude Code. Hangar finds the commits the session made in its
project (the same evidence as "who changed what"), or the project's uncommitted changes when it made none, and packs
them with the cross-review skill. The reviewer reads the packet and the project and replies with a verdict and
findings, which stay linked to the session. The method and the reply format live in the skill (claude-config), so a
review from Hangar reads the same as one sent from a terminal. Reviews describe private code: local engine storage only.
"""
import json
import os
import shutil
import subprocess
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from . import activity, config, session_library, work

SKILL_DIRS = (".claude/skills/cross-review", ".agents/skills/cross-review", ".codex/skills/cross-review")
NAMES = {"claude": "Claude Code", "codex": "Codex"}
KEEP = 200

_lock = threading.Lock()


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def store():
    return config.LOCAL / "reviews"


def skill():
    """The cross-review skill folder on this machine, or None."""
    env = os.environ.get("HANGAR_CROSS_REVIEW")
    bases = [Path(env)] if env else [Path.home() / d for d in SKILL_DIRS]
    return next((b for b in bases if (b / "scripts" / "cross-review.mjs").is_file()), None)


def read():
    return config.read_json(store() / "index.json", {"reviews": []}) or {"reviews": []}


def save(record):
    with _lock:
        data = read()
        rows = [r for r in data["reviews"] if r.get("id") != record["id"]]
        data["reviews"] = ([record] + rows)[:KEEP]
        config.write_json(store() / "index.json", data)


def update(rid, **fields):
    with _lock:
        data = read()
        for r in data["reviews"]:
            if r.get("id") == rid:
                r.update(fields)
        config.write_json(store() / "index.json", data)


def listing(session=None, review=None):
    """Reviews newest first: of one session (its key, "claude:<id>"), one review by id, or the latest 50."""
    rows = read()["reviews"]
    if review:
        rows = [r for r in rows if r.get("id") == review]
    elif session:
        rows = [r for r in rows if r.get("session") == session]
    return {"reviews": rows[:50], "skill": bool(skill())}


def pack(sk, folder, out, commits, uncommitted, title, author):
    node = shutil.which("node")
    if not node:
        raise ValueError("Install Node.js on this machine: the cross-review skill needs it to pack the changes.")
    argv = [node, str(sk / "scripts" / "cross-review.mjs"), "pack", "--repo", str(folder), "--author", author,
            "--title", title, "--out", str(out / "packet.md")]
    argv += ["--commits", ",".join(commits)] if commits else []
    argv += ["--uncommitted"] if uncommitted else []
    try:
        run = subprocess.run(argv, cwd=folder, stdin=subprocess.DEVNULL, capture_output=True, timeout=120, encoding="utf-8",
                             errors="replace", creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except subprocess.TimeoutExpired:
        raise ValueError("Packing the changes took over two minutes; the diff may be too large to review at once.")
    try:
        return json.loads(run.stdout)
    except ValueError:
        raise ValueError(f"The cross-review skill could not pack the changes: {(run.stderr or run.stdout).strip()[:400]}")


def start(doc, overlay, body):
    sk = skill()
    if not sk:
        raise ValueError("Install the cross-review skill first: it lives in claude-config (~/.claude/skills/cross-review).")
    key = body.get("session")
    found = next((s for s in session_library.snapshot(doc, overlay)["sessions"] if s["key"] == key), None)
    if not found:
        raise ValueError("That session is not indexed on this machine.")
    author = found["provider"] if found["provider"] in NAMES else "claude"
    reviewer = body.get("reviewer") or ("codex" if author == "claude" else "claude")
    if reviewer not in NAMES:
        raise ValueError("Choose Claude Code or Codex to review.")
    # The project to review: the one asked for, else where the session committed most recently, else its first project
    # with a checkout here (its uncommitted changes).
    checkouts = []
    for pid in [body["repo"]] if body.get("repo") else [p["id"] for p in found["projects"]]:
        try:
            checkouts.append(work.checkout(doc, overlay, pid))
        except ValueError:
            continue
    if not checkouts:
        raise ValueError("None of this session's projects has a main checkout on this machine.")
    made = activity.claimed(doc, overlay, [r["id"] for r, _ in checkouts], days=30).get(key, [])  # newest first
    repo, folder = next((c for c in checkouts if made and c[0]["id"] == made[0]["repoId"]), checkouts[0])
    commits = [c["sha"] for c in reversed(made) if c["repoId"] == repo["id"]]  # oldest first
    title = (found.get("title") or "")[:200]
    rid = uuid.uuid4().hex[:12]
    out = store() / rid
    out.mkdir(parents=True, exist_ok=True)
    packed = pack(sk, folder, out, commits, not commits, title, author)
    if packed.get("empty"):
        shutil.rmtree(out, ignore_errors=True)
        raise ValueError(f"Nothing to review: this session made no commits in {repo['name']} in the last 30 days, and the checkout has no uncommitted changes.")
    record = {"id": rid, "session": key, "sessionTitle": title, "author": author, "reviewer": reviewer,
              "repo": repo["id"], "project": repo["name"], "commits": [c[:7] for c in commits], "uncommitted": not commits,
              "files": len(packed.get("files") or []), "state": "running", "startedAt": now(), "endedAt": None, "job": None}
    save(record)
    text = (f"You are reviewing {NAMES[author]}'s work, read-only. Read the \"Reviewing\" section of {sk / 'SKILL.md'} and follow it.\n"
            f"The work to review is described in {out / 'packet.md'}. The project is the current folder.\n"
            "Do not edit, create or delete any file, and do not run anything that changes the project. "
            "End your reply with the JSON block the skill describes.")
    try:
        started = work.begin(doc, overlay, repo["id"], reviewer, text, kind="review", read_dirs=[sk, out],
                             label=f"Review {NAMES[author]}'s work: {title or repo['name']}",
                             meta={"review": rid, "reviewOf": {"session": key, "provider": found["provider"], "id": found["id"], "title": title}},
                             on_finish=lambda job, reply: finish(rid, job, reply))
    except ValueError as error:
        update(rid, state="failed", endedAt=now(), message=str(error))
        raise
    update(rid, job=started["id"])
    return {"id": rid, "job": started["id"], "reviewer": reviewer, "commits": len(commits), "uncommitted": not commits}


def finish(rid, job, reply):
    try:
        (store() / rid / "reply.md").write_text(reply or "", encoding="utf-8")
        if job["state"] != "completed":
            failed = " ".join(o["text"] for o in job["output"])
            return update(rid, state="failed", endedAt=now(), message=work.failure_hint(failed) or "The reviewer stopped before replying.")
        result = parse(reply)
        if not result:
            return update(rid, state="failed", endedAt=now(), message="The reviewer replied without findings in the agreed format.")
        update(rid, state="done", endedAt=now(), **result)
        high = sum(f["severity"] == "high" for f in result["findings"])
        work.note(job["id"], f"Review saved: {len(result['findings'])} findings{f', {high} high' if high else ''}.")
    except Exception as error:  # a crashed parse must not leave the review looking busy forever
        update(rid, state="failed", endedAt=now(), message=f"Hangar could not read the review: {error}")


def parse(reply):
    """The verdict and findings from the last ```json block of the reply (the skill's format), or None."""
    import re
    blocks = re.findall(r"```json\s*(.*?)```", reply or "", flags=re.S)
    for block in reversed(blocks):
        try:
            r = json.loads(block)
        except ValueError:
            continue
        if not isinstance(r, dict) or not isinstance(r.get("findings"), list):
            continue
        sev = ("high", "medium", "low")
        findings = [{"severity": f.get("severity") if f.get("severity") in sev else "low", "file": str(f.get("file") or ""),
                     "line": f["line"] if isinstance(f.get("line"), int) and f["line"] > 0 else (int(f["line"]) if str(f.get("line") or "").isdigit() else None),
                     "title": str(f.get("title") or "")[:300], "detail": str(f.get("detail") or "")[:2000], "fix": str(f.get("fix") or "")[:1200]}
                    for f in r["findings"] if isinstance(f, dict)]
        findings.sort(key=lambda f: sev.index(f["severity"]))
        return {"verdict": r.get("verdict") if r.get("verdict") in ("ship", "fix", "rethink") else "fix",
                "summary": str(r.get("summary") or "")[:1500], "findings": findings[:60],
                "checked": [str(c)[:300] for c in (r.get("checked") or []) if c][:20], "notChecked": str(r.get("notChecked") or "")[:600]}
    return None
