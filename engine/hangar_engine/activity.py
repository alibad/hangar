"""Who changed what in one project, and whether two sessions worked on it at the same time.

Each main-branch commit in the window is joined to the Claude Code or Codex session that most likely made it. The
evidence, strongest first:
  printed  the session's output carries git's own confirmation line for the commit ("[main 1a2b3c4] …");
  seen     the session printed the hash within five minutes after the commit (a quiet commit, then git log);
  files    the session edited the commit's files in the three hours before it.
The agent is that session's agent. With no session, a Co-Authored-By: Claude trailer still says Claude; anything else is
unknown. Two sessions with work in the project within two hours of each other overlap. Nothing here reads a transcript:
it joins Git with the session index's edit times and printed hashes.
"""
import re
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

from . import codex_library, local, session_index

HOUR = 3600
SEEN_AFTER = 300           # a quiet commit's hash printed by the same session this soon after
SKEW = 60                  # clocks and commit timestamps disagree by seconds, not minutes
EDITS_BEFORE = 3 * HOUR    # how long before a commit an edit to its files still counts
SPAN_GAP = HOUR            # work in one project closer than this is one stretch
OVERLAP = 2 * HOUR         # two stretches this close are two sessions on the project at once
MAX_COMMITS = 500
EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"  # what a first commit is compared with
PATCH_LINES = 400        # per file: enough to read the change, not a whole generated file
PATCH_BYTES = 200_000    # per commit
_cache = {}
_cache_lock = threading.Lock()


def iso(value):
    return datetime.fromtimestamp(value, timezone.utc).isoformat(timespec="seconds")


def git(folder, *args):
    try:
        result = subprocess.run(["git", "-C", str(folder), *args], stdin=subprocess.DEVNULL, capture_output=True,
                                timeout=25, encoding="utf-8", errors="replace",
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return result.stdout if result.returncode == 0 else ""
    except (OSError, subprocess.TimeoutExpired):
        return ""


def main_branch(folder):
    """The branch that ships: origin's default when known, else main or master, else whatever is checked out."""
    remote = git(folder, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD").strip()
    names = ([remote.split("/", 1)[1]] if "/" in remote else []) + ["main", "master"]
    for name in names:
        if git(folder, "rev-parse", "--verify", "--quiet", f"refs/heads/{name}").strip():
            return name
    return git(folder, "symbolic-ref", "--quiet", "--short", "HEAD").strip() or "HEAD"


def log(folder, since, until):
    """Main-branch commits in [since, until] with their files and Co-Authored-By trailers. Cached for two minutes."""
    key = (str(folder), int(since) // 120, int(until) // 120)
    with _cache_lock:
        hit = _cache.get(key)
    if hit:
        return hit
    branch = main_branch(folder)
    raw = git(folder, "log", branch, f"--since={iso(since)}", f"--until={iso(until)}", f"--max-count={MAX_COMMITS + 1}",
              "--name-only", "--format=%x00%H%x1f%cI%x1f%aI%x1f%s%x1f%(trailers:key=Co-Authored-By,valueonly,separator=%x3b)")
    commits = []
    for chunk in raw.split("\0")[1:]:
        head, _, names = chunk.partition("\n")
        parts = head.split("\x1f")
        if len(parts) != 5:
            continue
        sha, committed, authored, subject, trailers = parts
        at = session_index.stamp(committed) or session_index.stamp(authored)
        if at is None:
            continue
        commits.append({"sha": sha, "short": sha[:7], "at": at, "subject": subject[:200],
                        "files": [n.strip() for n in names.splitlines() if n.strip()][:400],
                        "trailer": "claude" if "claude" in trailers.lower() else "codex" if "codex" in trailers.lower() else None})
    result = {"branch": branch, "commits": commits[:MAX_COMMITS], "truncated": len(commits) > MAX_COMMITS}
    with _cache_lock:
        if len(_cache) > 200:
            _cache.clear()
        _cache[key] = result
    return result


def key_of(entry):
    return entry["provider"] + ":" + entry["id"]


def repo_edits(entry, prefixes):
    """This session's confirmed edits inside the project's folders, as {relative path: [times]}."""
    out = {}
    for path, times in (entry.get("edits") or {}).items():
        for prefix in prefixes:
            if path.startswith(prefix + "/"):
                out.setdefault(path[len(prefix) + 1:], []).extend(times)
                break
    return out


def attribute(commits, entries, prefixes):
    """{sha: claim} for every commit some session can be tied to. A claim names the session, the kind of evidence and
    why, in plain words."""
    hashes = {}
    for entry in entries:
        for printed, value in (entry.get("commits") or {}).items():
            hashes.setdefault(printed[:7], []).append((entry, printed, value))
    edited = [(entry, edits) for entry in entries if (edits := repo_edits(entry, prefixes))]
    claims = {}
    for commit in commits:
        sha, at = commit["sha"], commit["at"]
        best = None
        for entry, printed, (seen_at, made, _subject) in hashes.get(sha[:7], []):
            if not sha.startswith(printed):
                continue
            if made:
                rank = (3, -abs(seen_at - at))
                why = "printed git's own line for this commit"
            elif -SKEW <= seen_at - at <= SEEN_AFTER:
                rank = (2, -(seen_at - at))
                why = f"printed this commit's hash {max(0, seen_at - at)} s after it was made"
            else:
                continue
            if best is None or rank > best[0]:
                best = (rank, entry, "printed" if made else "seen", why)
        if best is None and commit["files"]:
            wanted = set(commit["files"])
            for entry, edits in edited:
                if commit["trailer"] == "claude" and entry["provider"] != "claude":
                    continue  # the commit says Claude wrote it; a Codex session touching the same files did not
                times = [t for f in wanted & set(edits) for t in edits[f] if at - EDITS_BEFORE <= t <= at + SKEW]
                if not times:
                    continue
                count = sum(1 for f in wanted & set(edits) if any(at - EDITS_BEFORE <= t <= at + SKEW for t in edits[f]))
                minutes = max(1, round((at - max(times)) / 60)) if max(times) < at else 0
                why = f"edited {count} of its {len(wanted)} files" + (f", the last {minutes} min before it" if minutes else " just before it")
                rank = (1, count, max(times))
                if best is None or rank > best[0]:
                    best = (rank, entry, "files", why)
        if best:
            claims[sha] = {"session": key_of(best[1]), "evidence": best[2], "why": best[3]}
    return claims


def spans(times):
    """Stretches of work: times closer than SPAN_GAP are one stretch."""
    out = []
    for t in sorted(times):
        if out and t - out[-1][1] <= SPAN_GAP:
            out[-1][1] = t
        else:
            out.append([t, t])
    return out


def overlaps(sessions):
    """Bands of time when two or more sessions worked on the project within OVERLAP of each other."""
    pairs = []
    for i, a in enumerate(sessions):
        for b in sessions[i + 1:]:
            for sa in a["_spans"]:
                for sb in b["_spans"]:
                    if sa[0] - OVERLAP <= sb[1] and sb[0] - OVERLAP <= sa[1]:
                        pairs.append([min(sa[0], sb[0]), max(sa[1], sb[1]), {a["key"], b["key"]}])
    pairs.sort(key=lambda p: p[0])
    bands = []
    for start, end, keys in pairs:
        if bands and start <= bands[-1][1]:
            bands[-1][1] = max(bands[-1][1], end)
            bands[-1][2] |= keys
        else:
            bands.append([start, end, set(keys)])
    by_key = {s["key"]: s for s in sessions}
    out = []
    for start, end, keys in bands:
        members = [by_key[k] for k in sorted(keys, key=lambda k: by_key[k]["_first"])]
        touched = {}
        for s in members:
            for path, t in s["_touches"]:
                if start - SKEW <= t <= end + SKEW:
                    touched.setdefault(path, set()).add(s["key"])
        agents = sorted({s["provider"] for s in members})
        out.append({"from": iso(start), "to": iso(end), "sessions": [s["key"] for s in members], "agents": agents,
                    "crossAgent": len(agents) > 1, "sharedFiles": sorted(p for p, ks in touched.items() if len(ks) > 1)[:20]})
    return out


def titles():
    """Codex keeps thread names in its own database; Claude's live in the session index."""
    try:
        return {tid: thread.get("title") or "" for tid, thread in codex_library.snapshot()["threads"].items()}
    except Exception:  # an unreadable Codex database leaves titles blank, never the timeline
        return {}


def folders_of(repo, overlay):
    sites = sorted(repo.get("sites", []), key=lambda s: s.get("role") != "canonical")
    paths = [p for s in sites if (p := local.site_path(overlay, s)) and p.is_dir()]
    return paths


BASIS = ("Main-branch Git history joined with Claude Code and Codex session evidence on this machine: git's own "
         "commit line or a hash printed just after the commit, else edits to the commit's files in the 3 hours "
         "before it. A Claude session's helper agents count as the session. Edits made through shell commands are "
         "invisible to the index.")


def window(days, now):
    if type(days) is not int or not 1 <= days <= 30:
        raise ValueError("Choose 1 to 30 days.")
    now = int(time.time() if now is None else now)
    return now - days * 86400, now


def recent_entries(since):
    """Sessions that could have worked in the window: anything older cannot have made, seen or prepared its commits."""
    return [e for e in session_index.collect()["files"].values()
            if (session_index.stamp(e.get("lastEvent") or "") or 0) >= since - EDITS_BEFORE]


def activity(doc, overlay, rid, days=7, now=None):
    repo = next((r for r in doc["repos"] if r["id"] == rid), None)
    if not repo:
        raise ValueError("Choose an indexed project.")
    since, now = window(days, now)
    folders = folders_of(repo, overlay)
    if not folders:
        return {"available": False, "reason": "This project is not on this machine.", "repo": rid}
    return {"available": True, "days": days, "from": iso(since), "to": iso(now),
            **join(repo, folders, since, now, recent_entries(since), titles()), "basis": BASIS}


def board(doc, overlay, days=7, now=None):
    """Every project on this machine with commits on main or session work in the window, busiest collisions first."""
    since, now = window(days, now)
    repos = [(repo, folders) for repo in doc["repos"] if not repo.get("hidden") and (folders := folders_of(repo, overlay))]
    with ThreadPoolExecutor(max_workers=8) as pool:  # warms the git log cache in parallel
        list(pool.map(lambda item: log(item[1][0], since, now), repos))
    entries, names = recent_entries(since), titles()
    projects = [p for repo, folders in repos if (p := join(repo, folders, since, now, entries, names))["commits"] or p["sessions"]]
    projects.sort(key=lambda p: (-sum(o["crossAgent"] for o in p["overlaps"]), -len(p["overlaps"]), -len(p["commits"]), p["name"].lower()))
    return {"available": True, "days": days, "from": iso(since), "to": iso(now), "projects": projects,
            "truncated": any(p["truncated"] for p in projects), "basis": BASIS}


def join(repo, folders, since, now, entries, names):
    """One project's commits in the window, each with the session behind it, its sessions and their overlaps."""
    history = log(folders[0], since, now)
    prefixes = sorted({session_index.norm(str(f)) for f in folders}, key=len, reverse=True)
    claims = attribute(history["commits"], entries, prefixes)
    by_key = {key_of(e): e for e in entries}
    rows = {}

    def row(entry):
        k = key_of(entry)
        if k not in rows:
            title = names.get(entry["id"]) if entry["provider"] == "codex" else entry.get("title")
            rows[k] = {"key": k, "provider": entry["provider"], "id": entry["id"], "title": (title or "")[:240],
                       "commits": [], "edits": 0, "_times": [], "_touches": []}
        return rows[k]

    commits = []
    for commit in history["commits"]:
        claim = claims.get(commit["sha"])
        entry = by_key.get(claim["session"]) if claim else None
        agent = entry["provider"] if entry else commit["trailer"] or "unknown"
        commits.append({"sha": commit["sha"], "short": commit["short"], "at": iso(commit["at"]), "subject": commit["subject"],
                        "files": commit["files"][:40], "fileCount": len(commit["files"]), "agent": agent,
                        "trailer": commit["trailer"], "session": claim["session"] if claim else None,
                        "evidence": claim["evidence"] if claim else ("trailer" if commit["trailer"] else None),
                        "why": claim["why"] if claim else ("its Co-Authored-By trailer names Claude; no session found" if commit["trailer"] == "claude" else "no session evidence")})
        if entry:
            r = row(entry)
            r["commits"].append(commit["sha"])
            r["_times"].append(commit["at"])
            r["_touches"].extend((f, commit["at"]) for f in commit["files"])
    for entry in entries:
        for path, times in repo_edits(entry, prefixes).items():
            inside = [t for t in times if since <= t <= now]
            if inside:
                r = row(entry)
                r["edits"] += len(inside)
                r["_times"].extend(inside)
                r["_touches"].extend((path, t) for t in inside)
    sessions = []
    for r in rows.values():
        r["_spans"] = spans(r["_times"])
        r["_first"] = r["_spans"][0][0]
        r["spans"] = [{"from": iso(a), "to": iso(b)} for a, b in r["_spans"]]
        r["files"] = sorted({p for p, _ in r["_touches"]})[:60]
        sessions.append(r)
    sessions.sort(key=lambda s: s["_first"])
    bands = overlaps(sessions)
    for s in sessions:
        for k in [k for k in s if k.startswith("_")]:
            del s[k]
    commits.sort(key=lambda c: c["at"])
    return {"repo": repo["id"], "name": repo["name"], "branch": history["branch"], "commits": commits, "sessions": sessions,
            "overlaps": bands, "truncated": history["truncated"]}


def claimed(doc, overlay, repo_ids, days=30, now=None):
    """{session key: [commit, …]}, newest first: what each session changed in these projects, for the session list."""
    now = int(time.time() if now is None else now)
    since = now - days * 86400
    entries = [e for e in session_index.collect()["files"].values()
               if (session_index.stamp(e.get("lastEvent") or "") or 0) >= since and (e.get("edits") or e.get("commits"))]
    if not entries:
        return {}
    repos = []
    for repo in doc["repos"]:
        if repo["id"] in repo_ids and (folders := folders_of(repo, overlay)):
            repos.append((repo, folders, sorted({session_index.norm(str(f)) for f in folders}, key=len, reverse=True)))
    with ThreadPoolExecutor(max_workers=8) as pool:
        logs = list(pool.map(lambda item: log(item[1][0], since, now), repos))
    out = {}
    for (repo, _, prefixes), history in zip(repos, logs):
        by_sha = {c["sha"]: c for c in history["commits"]}
        for sha, claim in attribute(history["commits"], entries, prefixes).items():
            commit = by_sha[sha]
            out.setdefault(claim["session"], []).append({"sha": sha[:7], "subject": commit["subject"], "repo": repo["name"], "repoId": repo["id"],
                                                         "at": iso(commit["at"]), "evidence": claim["evidence"]})
    for rows in out.values():
        rows.sort(key=lambda c: c["at"], reverse=True)
    return out


def split_patch(text):
    """{path: patch} from a unified diff, one block per file."""
    blocks = {}
    for block in re.split(r"^(?=diff --git )", text, flags=re.M):
        first = block.split("\n", 1)[0]
        match = re.match(r"diff --git a/(.*) b/(.*)$", first)
        if match:
            blocks[match.group(2)] = block
    return blocks


def commit_detail(doc, overlay, rid, sha):
    """One commit, read-only: its message, when and by whom, and each file it changed with the lines added and removed
    and the change itself (cut short for very large files). Merges are shown against their first parent."""
    repo = next((r for r in doc["repos"] if r["id"] == rid), None)
    if not repo:
        raise ValueError("Choose an indexed project.")
    if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{7,40}", sha):
        raise ValueError("Give a commit hash.")
    folders = folders_of(repo, overlay)
    if not folders:
        raise ValueError("This project is not on this machine.")
    folder = folders[0]
    full = git(folder, "rev-parse", "--verify", "--quiet", f"{sha}^{{commit}}").strip()
    if not full:
        raise ValueError("That commit is not in this project's history on this machine.")
    head = git(folder, "show", "-s", "--format=%H%x1f%an%x1f%aI%x1f%cI%x1f%P%x1f%s%x1f%b", full)
    parts = head.split("\x1f", 6)
    if len(parts) != 7:
        raise ValueError("Git could not read that commit.")
    _, author, authored, committed, parents, subject, body = parts
    base = parents.split()[0] if parents.split() else EMPTY_TREE
    files, budget = [], PATCH_BYTES
    patches = split_patch(git(folder, "diff", "--no-color", "--no-ext-diff", "-M", base, full))
    for line in git(folder, "diff", "--numstat", "-M", base, full).splitlines():
        cells = line.split("\t")
        if len(cells) < 3:
            continue
        added, removed, path = cells[0], cells[1], cells[-1]
        if " => " in path:  # a rename: numstat writes old => new, the patch is keyed by the new path
            path = re.sub(r"\{[^{}]* => ([^{}]*)\}", r"\1", path).replace("//", "/") if "{" in path else path.split(" => ")[-1]
        lines = (patches.get(path) or "").splitlines()
        shown = lines[:PATCH_LINES] if budget > 0 else []
        text = "\n".join(shown)
        budget -= len(text)
        files.append({"path": path, "added": None if added == "-" else int(added), "removed": None if removed == "-" else int(removed),
                      "binary": added == "-", "patch": text, "truncated": len(shown) < len(lines)})
    return {"repo": rid, "name": repo["name"], "sha": full, "short": full[:7], "subject": subject[:300], "body": body.strip()[:4000],
            "author": author, "at": committed or authored, "merge": len(parents.split()) > 1, "files": files[:300],
            "added": sum(f["added"] or 0 for f in files), "removed": sum(f["removed"] or 0 for f in files), "fileCount": len(files)}
