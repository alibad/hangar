"""Private, incremental session evidence. Never publishes transcripts or scans shell commands.

An edit tool followed by a successful result is evidence; a working directory is
only a fallback. Activity timestamps do not prove that an agent is still running.
Commit hashes are the one thing kept from command output: git's own "[main 1a2b3c4]"
line, a short reply that starts with a hash, the newest lines of a longer log, or the
commit a push moved the branch to, with the time it was printed.
A Claude session's helper agents keep their own transcripts beside it; what they edit
and commit counts as the session's work.
"""
import json
import os
import re
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from . import config, local

MAX_FILES = 2000
MAX_HELPERS = 4000
MAX_LINE = 4 * 1024 * 1024
MAX_EDIT_TIMES = 12
MAX_HASHES = 600
VERSION = 5
# What a printed hash says about the session, strongest first. Each sighting is kept as [time, kind, subject].
MADE, SEEN, LISTED, PUSHED = 1, 0, -1, -2
_lock = threading.Lock()
_checked = 0.0
_cache = None
_view = None
# git commit, cherry-pick and amend confirm with "[branch 1a2b3c4] subject"; git log --oneline starts a line with one.
COMMIT_LINE = re.compile(r"\[[^\]\n\\]{1,80}? (?:\(root-commit\) )?([0-9a-f]{7,40})\] ([^\n\\]{0,160})")
HASH_LINE = re.compile(r"(?:^|\n|\\n)([0-9a-f]{7,40}) (?=\S)")
# git push reports "   0d58754..45c250f  main -> main"; a fetch reports the same shape ending in "-> origin/main".
PUSH_LINE = re.compile(r"(?:^|\n|\\n)[ \t]*\+?[ \t]*[0-9a-f]{7,40}\.\.\.?([0-9a-f]{7,40})[ \t]+(\S+) -> (\S+)")


def norm(path):
    """One spelling per folder. Windows' long-path prefix (\\\\?\\C:\\..., which the Codex app writes) is dropped, or no
    project folder would ever match it."""
    path = str(path)
    if path.startswith("\\\\?\\UNC\\"):
        path = "\\\\" + path[8:]
    elif path.startswith("\\\\?\\"):
        path = path[4:]
    return os.path.normcase(os.path.abspath(path)).replace("\\", "/").rstrip("/")


def stamp(value):
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return int((parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)).timestamp())
    except (ValueError, TypeError, AttributeError, OverflowError):
        return None


def fresh(provider, path):
    return {"provider": provider, "id": path.stem, "cwd": "", "model": "", "offset": 0,
            "files": [], "edits": {}, "commits": {}, "origin": "", "pending": {}, "lastEvent": None, "state": "unknown"}


def note_edits(state, paths, at):
    """When each confirmed edit landed, newest few per file: enough to say which session last touched it before a commit."""
    if at is None:
        return
    for path in paths:
        times = state["edits"].setdefault(path, [])
        if not times or at - times[-1] > 30:
            times.append(at)
            del times[:-MAX_EDIT_TIMES]


def counts_over(value, old):
    """Making a commit outranks seeing it; otherwise the first sighting counts."""
    made, was_made = value[1] == MADE, old is not None and old[1] == MADE
    return old is None or made > was_made or (made == was_made and value[0] < old[0])


def note_hashes(state, text, at):
    """Commit hashes in a tool's output. A confirmation line means the session made that commit; a reply of at most
    three lines that start with a hash means it looked at those commits then; a longer log lists its newest three; a
    push names the commit it moved the branch to."""
    if at is None or not isinstance(text, str) or len(text) > 400_000:
        return
    found = {}
    for sha, subject in COMMIT_LINE.findall(text):
        found[sha] = [at, MADE, subject.strip()[:160]]
    if not found:
        seen = [sha for sha in HASH_LINE.findall(text) if any(c.isdigit() for c in sha)]
        kind = SEEN if len(seen) <= 3 else LISTED
        found = {sha: [at, kind, ""] for sha in seen[:3]}
    for sha, source, target in PUSH_LINE.findall(text):
        if source in (target, "HEAD"):  # a fetch moves origin/main, not main
            found.setdefault(sha, [at, PUSHED, ""])
    commits = state["commits"]
    for sha, value in found.items():
        if counts_over(value, commits.get(sha)):
            commits[sha] = value
    if len(commits) > MAX_HASHES:
        for sha in sorted(commits, key=lambda k: (commits[k][1], commits[k][0]))[:len(commits) - MAX_HASHES]:
            del commits[sha]


def output_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(b.get("text", "") for b in content if isinstance(b, dict) and isinstance(b.get("text"), str))
    return ""


def temp_folders():
    """System scratch space. A session that ran there and edited no project is a test run, not your work."""
    home = Path.home()
    candidates = [tempfile.gettempdir(), os.environ.get("TEMP"), os.environ.get("TMP"), os.environ.get("TMPDIR"),
                  home / "AppData" / "Local" / "Temp", "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"]
    return sorted({norm(str(c)) for c in candidates if c}, key=len, reverse=True)


def in_temp(cwd, folders=None):
    if not cwd:
        return False
    path = norm(cwd)
    return any(path == t or path.startswith(t + "/") for t in (folders or temp_folders()))


def edit_paths(name, arguments):
    if name.split(".")[-1] == "apply_patch":
        raw = arguments if isinstance(arguments, str) else arguments.get("patch", "")
        return re.findall(r"^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$", raw, re.M)
    if isinstance(arguments, dict) and name in ("Edit", "Write", "MultiEdit", "NotebookEdit"):
        return [arguments.get("file_path") or arguments.get("notebook_path") or ""]
    return []


def ingest(state, record):
    """Keep metadata and confirmed edit paths only. Message text never enters the cache."""
    if record.get("type") == "custom-title" and isinstance(record.get("customTitle"), str):
        state["title"] = record["customTitle"][:240]
    cwd = record.get("cwd")
    if isinstance(cwd, str):
        state["cwd"] = cwd
    timestamp = record.get("timestamp")
    if isinstance(timestamp, str):
        state["lastEvent"] = timestamp
    if not state["origin"] and isinstance(record.get("entrypoint"), str):
        state["origin"] = record["entrypoint"][:40]  # cli, claude-desktop, sdk-cli…
    p = record.get("payload") or {}
    if not isinstance(p, dict):
        return
    if record.get("type") == "session_meta":
        sid = p.get("id") or p.get("session_id")
        if isinstance(sid, str):
            state["id"] = sid
        if isinstance(p.get("cwd"), str):
            state["cwd"] = p["cwd"]
        source = p.get("originator") or p.get("source")
        state["origin"] = (source if isinstance(source, str) else "subagent" if isinstance(source, dict) else state["origin"])[:40]
    at = lambda: stamp(timestamp) if isinstance(timestamp, str) else None
    if record.get("type") == "turn_context":
        if isinstance(p.get("model"), str):
            state["model"] = p["model"]
        if isinstance(p.get("cwd"), str):
            state["cwd"] = p["cwd"]
    # Desktop Codex records completed patch operations inside item_completed,
    # including patches called through a tool orchestrator. Never parse shell text.
    item = p.get("item") or {}
    if p.get("type") == "item_completed" and item.get("type") == "FileChange" and item.get("status") == "completed":
        changes = item.get("changes")
        if isinstance(changes, dict):
            paths = [norm(Path(state["cwd"] or ".") / path) for path in changes]
            state["files"] = sorted(set(state["files"] + paths))[:2000]
            note_edits(state, paths, at())
    if isinstance(record.get("sessionId"), str):
        state["id"] = record["sessionId"]
    msg = record.get("message") or {}
    if isinstance(msg, dict) and isinstance(msg.get("model"), str):
        state["model"] = msg["model"]
    # Where a Claude turn stands: it is working until the agent's final reply (end_turn) is written, whatever started
    # it (a message, another session's note, a finished background task). Helpers' sidechains are not the main turn.
    if state["provider"] == "claude" and record.get("type") in ("user", "assistant") and isinstance(msg, dict) \
            and not record.get("isMeta") and not record.get("isSidechain"):
        content = msg.get("content")
        blocks = content if isinstance(content, list) else [{"type": "text", "text": content}] if isinstance(content, str) else []
        if record["type"] == "assistant":
            state["state"] = "completed" if msg.get("stop_reason") in ("end_turn", "stop_sequence") else "working"
        elif any(isinstance(b, dict) and str(b.get("text", "")).startswith("[Request interrupted") for b in blocks):
            state["state"] = "interrupted"
        elif blocks:
            state["state"] = "working"

    def call(key, name, args):
        paths = edit_paths(name, args)
        if paths and key:
            state["pending"][key] = [norm(Path(state["cwd"] or ".") / p) for p in paths if p]
            # Bound unresolved tool calls from interrupted transcripts.
            while len(state["pending"]) > 200:
                del state["pending"][next(iter(state["pending"]))]

    def result(key, success):
        paths = state["pending"].pop(key, [])
        if success:
            state["files"] = sorted(set(state["files"] + paths))[:2000]
            note_edits(state, paths, at())

    if state["provider"] == "claude" and isinstance(msg, dict):
        blocks = msg.get("content")
        for block in blocks if isinstance(blocks, list) else []:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "tool_use":
                call(block.get("id"), block.get("name", ""), block.get("input") or {})
            if block.get("type") == "tool_result":
                result(block.get("tool_use_id"), not block.get("is_error", False))
                note_hashes(state, output_text(block.get("content")), at())
    if p.get("type") in ("function_call", "custom_tool_call"):
        args = p.get("input") or p.get("arguments") or {}
        if isinstance(args, str) and p.get("name") != "apply_patch":
            try:
                args = json.loads(args)
            except ValueError:
                args = {}
        call(p.get("call_id"), p.get("name", ""), args)
    if p.get("type") in ("function_call_output", "custom_tool_call_output"):
        output = p.get("output", "")
        # apply_patch's successful response is explicit. Arbitrary shell output is not evidence.
        success = isinstance(output, str) and ("Success. Updated the following files" in output or output.startswith("{\"output\":\"Success."))
        result(p.get("call_id"), success)
        note_hashes(state, output_text(output), at())
    if p.get("type") in ("task_complete", "turn_aborted", "task_started"):
        state["state"] = {"task_complete": "completed", "turn_aborted": "interrupted", "task_started": "working"}[p["type"]]


def update_file(path, provider, previous=None):
    st = path.stat()
    state = previous or fresh(provider, path)
    if st.st_size < state.get("offset", 0) or (st.st_size == state.get("size") and st.st_mtime_ns != state.get("mtime")):
        state = fresh(provider, path)
    if state.get("mtime") == st.st_mtime_ns and state.get("size") == st.st_size:
        return state
    with path.open("rb") as f:
        f.seek(state["offset"])
        while True:
            start = f.tell()
            line = f.readline(MAX_LINE + 1)
            if not line:
                break
            if len(line) > MAX_LINE:
                while line and not line.endswith(b"\n"):
                    line = f.readline(MAX_LINE + 1)
                if not line.endswith(b"\n"):
                    f.seek(start)
                    break
                state["offset"] = f.tell()
                continue
            if not line.endswith(b"\n"):
                break  # appended partial JSON is retried next time
            try:
                record = json.loads(line)
                if isinstance(record, dict):
                    ingest(state, record)
            except (ValueError, TypeError):
                pass
            state["offset"] = f.tell()
    state.update(mtime=st.st_mtime_ns, size=st.st_size,
                 updatedAt=datetime.fromtimestamp(st.st_mtime, timezone.utc).isoformat(timespec="seconds"))
    return state


def parent_of(helper):
    """Claude keeps a helper agent's transcript at <project>/<session>/subagents/agent-<id>.jsonl, and a workflow's
    agents one folder down, under subagents/workflows/<run>/."""
    folder = next((p for p in Path(helper).parents if p.name == "subagents"), None)
    return str(folder.parent.parent / (folder.parent.name + ".jsonl")) if folder else ""


def fold(entry, helpers):
    """The session plus its helper agents: their edits, their commits and their last activity are the session's.
    Copies, so the per-file states keep their own read positions."""
    merged = dict(entry, files=list(entry["files"]), edits={p: list(t) for p, t in entry["edits"].items()},
                  commits=dict(entry["commits"]), helpers=len(helpers))
    for helper in helpers:
        merged["files"] = sorted(set(merged["files"]) | set(helper["files"]))[:2000]
        for path, times in helper["edits"].items():
            merged["edits"][path] = sorted(set(merged["edits"].get(path, [])) | set(times))[-MAX_EDIT_TIMES:]
        for sha, value in helper["commits"].items():
            if counts_over(value, merged["commits"].get(sha)):
                merged["commits"][sha] = value
        if (stamp(helper.get("lastEvent") or "") or 0) > (stamp(merged.get("lastEvent") or "") or 0):
            merged["lastEvent"] = helper["lastEvent"]
        merged["updatedAt"] = max(merged["updatedAt"], helper.get("updatedAt") or "")
    return merged


def view(index):
    by_parent = {}
    for path, helper in index.get("helpers", {}).items():
        by_parent.setdefault(parent_of(path), []).append(helper)
    files = {path: fold(entry, by_parent[path]) if path in by_parent else entry for path, entry in index["files"].items()}
    return {**index, "files": files}


def collect():
    global _cache, _view, _checked
    with _lock:
        if _view is not None and time.monotonic() - _checked < 15:
            return _view
        saved = config.read_json(config.LOCAL / "session-index.json", {}) or {}
        old = saved.get("files", {}) if saved.get("version") == VERSION else {}
        old_helpers = saved.get("helpers", {}) if saved.get("version") == VERSION else {}
        claude = Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude") / "projects"
        codex = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")
        def newest(base, pattern, provider):
            found = []
            for path in base.glob(pattern):
                try:
                    found.append((path.stat().st_mtime, provider, path))
                except OSError:
                    pass
            return found
        candidates = [*newest(claude, "*/*.jsonl", "claude"), *newest(codex / "sessions", "**/*.jsonl", "codex"),
                      *newest(codex / "archived_sessions", "**/*.jsonl", "codex")]
        candidates.sort(key=lambda x: x[0], reverse=True)
        files = {}
        for _, provider, path in candidates[:MAX_FILES]:
            try:
                files[str(path)] = update_file(path, provider, old.get(str(path)))
                files[str(path)]["nativeArchived"] = provider == "codex" and "archived_sessions" in path.parts
            except OSError:
                continue
        helpers = {}
        for _, provider, path in sorted(newest(claude, "*/*/subagents/**/*.jsonl", "claude"), key=lambda x: x[0], reverse=True)[:MAX_HELPERS]:
            if parent_of(path) in files:
                try:
                    helpers[str(path)] = update_file(path, provider, old_helpers.get(str(path)))
                except OSError:
                    continue
        _cache = {"version": VERSION, "files": files, "helpers": helpers, "truncated": len(candidates) > MAX_FILES,
                  "indexedAt": datetime.now(timezone.utc).isoformat(timespec="seconds")}
        config.write_json(config.LOCAL / "session-index.json", _cache)
        _view = view(_cache)
        _checked = time.monotonic()
        return _view


def invalidate():
    global _checked
    with _lock:
        _checked = 0.0


def timeline(doc, overlay, repo_id=None, limit=300):
    paths = []
    for repo in doc["repos"]:
        for site in repo.get("sites", []):
            folder = local.site_path(overlay, site)
            if folder:
                paths.append((norm(folder), repo["id"], repo["name"]))
    paths.sort(key=lambda x: len(x[0]), reverse=True)
    def match(path):
        return next((p for p in paths if path == p[0] or path.startswith(p[0] + "/")), None)
    index = collect()
    scratch = temp_folders()
    sessions = []
    for entry in index["files"].values():
        touched = {}
        for path in entry["files"]:
            hit = match(path)
            if hit:
                touched.setdefault(hit[1], {"id": hit[1], "name": hit[2], "files": [], "evidence": "edit-tool"})["files"].append(path[len(hit[0]) + 1:])
        if not touched and entry["cwd"]:
            hit = match(norm(entry["cwd"]))
            if hit:
                touched[hit[1]] = {"id": hit[1], "name": hit[2], "files": [], "evidence": "working-directory"}
        if repo_id and repo_id not in touched:
            continue
        projects = list(touched.values())
        count = sum(len(p["files"]) for p in projects)
        sessions.append({"id": entry["id"], "provider": entry["provider"], "model": entry["model"],
                         "title": entry.get("title", ""),
                         "updatedAt": entry["updatedAt"], "state": entry["state"], "projects": projects,
                         "lastEventAt": entry.get("lastEvent"), "nativeArchived": entry.get("nativeArchived", False),
                         "summary": f"Edited {count} {'file' if count == 1 else 'files'} " + (f"in {projects[0]['name']}" if len(projects) == 1 else f"across {len(projects)} projects") if count else "Session in " + (projects[0]["name"] if projects else "an unindexed folder"),
                         "origin": entry.get("origin", ""), "probe": not projects and in_temp(entry["cwd"], scratch),
                         "helpers": entry.get("helpers", 0),
                         "canResume": bool(re.fullmatch(r"[a-zA-Z0-9_-]{8,100}", entry["id"]))})
    sessions.sort(key=lambda s: s["updatedAt"], reverse=True)
    return {"sessions": sessions[:limit], "total": len(sessions), "truncated": index["truncated"] or (limit is not None and len(sessions) > limit),
            "indexedAt": index["indexedAt"], "liveStatus": "unavailable"}


def resume(provider, session_id):
    from . import launch
    if provider not in ("claude", "codex") or not isinstance(session_id, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{8,100}", session_id):
        raise ValueError("Invalid session")
    from . import desktop_sessions
    # The desktop app opens the conversation itself, with its history, where you normally read it.
    link = desktop_sessions.app_link(provider, session_id) if desktop_sessions.opens_in(provider, session_id) == "app" else None
    if link:
        launch._open_os(link)
        return {"opened": True, "provider": provider, "where": "app"}
    entry = next((e for e in collect()["files"].values() if e["provider"] == provider and e["id"] == session_id), None)
    if not entry or not entry["cwd"] or not Path(entry["cwd"]).is_dir():
        raise ValueError("The session's working folder is no longer available on this machine.")
    exe = launch.cli(provider)
    if not exe:
        raise ValueError(f"Install the {provider} CLI to resume this session.")
    launch._terminal(entry["cwd"], [exe, "--resume" if provider == "claude" else "resume", session_id])
    return {"opened": True, "provider": provider, "where": "terminal"}
