"""Private, incremental session evidence. Never publishes transcripts or scans shell commands.

An edit tool followed by a successful result is evidence; a working directory is
only a fallback. Activity timestamps do not prove that an agent is still running.
"""
import json
import os
import re
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from . import config, local

MAX_FILES = 2000
MAX_LINE = 4 * 1024 * 1024
_lock = threading.Lock()
_checked = 0.0
_cache = None


def norm(path):
    return os.path.normcase(os.path.abspath(path)).replace("\\", "/").rstrip("/")


def fresh(provider, path):
    return {"provider": provider, "id": path.stem, "cwd": "", "model": "", "offset": 0,
            "files": [], "pending": {}, "lastEvent": None, "state": "unknown"}


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
    p = record.get("payload") or {}
    if not isinstance(p, dict):
        return
    if record.get("type") == "session_meta":
        sid = p.get("id") or p.get("session_id")
        if isinstance(sid, str):
            state["id"] = sid
        if isinstance(p.get("cwd"), str):
            state["cwd"] = p["cwd"]
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
            state["files"] = sorted(set(state["files"] + [norm(Path(state["cwd"] or ".") / path) for path in changes]))[:2000]
    if isinstance(record.get("sessionId"), str):
        state["id"] = record["sessionId"]
    msg = record.get("message") or {}
    if isinstance(msg, dict) and isinstance(msg.get("model"), str):
        state["model"] = msg["model"]

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

    if state["provider"] == "claude" and isinstance(msg, dict):
        blocks = msg.get("content")
        for block in blocks if isinstance(blocks, list) else []:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "tool_use":
                call(block.get("id"), block.get("name", ""), block.get("input") or {})
            if block.get("type") == "tool_result":
                result(block.get("tool_use_id"), not block.get("is_error", False))
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
    if p.get("type") in ("task_complete", "turn_aborted", "task_started"):
        state["state"] = {"task_complete": "completed", "turn_aborted": "interrupted", "task_started": "unknown"}[p["type"]]


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


def collect():
    global _cache, _checked
    with _lock:
        if _cache is not None and time.monotonic() - _checked < 15:
            return _cache
        saved = config.read_json(config.LOCAL / "session-index.json", {}) or {}
        old = saved.get("files", {}) if saved.get("version") == 3 else {}
        claude = Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude") / "projects"
        codex = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")
        candidates = []
        for provider, base, pattern in (("claude", claude, "*/*.jsonl"), ("codex", codex / "sessions", "**/*.jsonl"),
                                        ("codex", codex / "archived_sessions", "**/*.jsonl")):
            for path in base.glob(pattern):
                try:
                    candidates.append((path.stat().st_mtime, provider, path))
                except OSError:
                    pass
        candidates.sort(key=lambda x: x[0], reverse=True)
        files = {}
        for _, provider, path in candidates[:MAX_FILES]:
            try:
                files[str(path)] = update_file(path, provider, old.get(str(path)))
                files[str(path)]["nativeArchived"] = provider == "codex" and "archived_sessions" in path.parts
            except OSError:
                continue
        _cache = {"version": 3, "files": files, "truncated": len(candidates) > MAX_FILES,
                  "indexedAt": datetime.now(timezone.utc).isoformat(timespec="seconds")}
        config.write_json(config.LOCAL / "session-index.json", _cache)
        _checked = time.monotonic()
        return _cache


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
                         "summary": f"Edited {count} files across {len(projects)} projects" if count else "Session in " + (projects[0]["name"] if projects else "an unindexed folder"),
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
