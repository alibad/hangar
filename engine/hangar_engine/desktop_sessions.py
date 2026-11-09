"""Which conversations the Claude and Codex desktop apps can open themselves.

The Claude app keeps one small record per Code session (local_<id>.json) that names the command-line session it runs
(cliSessionId); its link claude://code/continue?session=local_<id> opens that session in the app. A conversation the
app never saw (a terminal session, a Hangar job) has no record, and only a terminal can resume it. The Codex app opens
any thread by id.

The same record says what the sidebar shows: the title, whether the session is archived, when you last opened it and
when its last turn ended (a reply you have not opened yet), and the app's one-line status of that turn. Hangar only
reads these records; it never writes them.
"""
import json
import os
import re
import sys
import time
from pathlib import Path

from . import launch

_cache = {"at": 0.0, "records": {}}
_files = {}  # path -> (modified, record): a record is re-read only when it changes
_VALUE = r'("(?:[^"\\]|\\.)*"|true|false|null|-?\d+(?:\.\d+)?)'
_FIELD = {k: re.compile(rf'"{k}"\s*:\s*{_VALUE}') for k in ("sessionId", "cliSessionId", "isArchived", "title", "lastFocusedAt", "lastTurnEdgeAt")}
_SUMMARY = re.compile(rb'"postTurnSummary"\s*:\s*\{')
_SPAWNED = re.compile(rb'"spawnedFrom"\s*:\s*\{')
_LAST = re.compile(rf'"lastAssistantUuid"\s*:\s*{_VALUE}')


def _read(path):
    """The ids, title and times sit at the start of each record; the rest (tool and prompt snapshots) can be large,
    so only the small status object is decoded from it."""
    with open(path, "rb") as f:
        raw = f.read()
    head = raw[:16384].decode("utf-8", errors="replace")
    found = {}
    for key, rx in _FIELD.items():
        if m := rx.search(head):
            try:
                found[key] = json.loads(m.group(1))
            except ValueError:
                pass
    focused, edge = found.get("lastFocusedAt"), found.get("lastTurnEdgeAt")
    record = {"cli": found.get("cliSessionId"), "own": found.get("sessionId"), "archived": found.get("isArchived") is True,
              "title": found.get("title") if isinstance(found.get("title"), str) else "",
              # Older records carry neither time, so their read state is unknown rather than read.
              "unread": None if not isinstance(edge, (int, float)) else not isinstance(focused, (int, float)) or edge > focused,
              "status": None, "parent": None}
    # A session another session started names it (the app's own id of the parent), so a family of sessions can be drawn.
    if m := _SPAWNED.search(raw):
        try:
            spawned, _ = json.JSONDecoder().raw_decode(raw[m.end() - 1:m.end() + 4095].decode("utf-8", errors="replace"))
            if isinstance(spawned, dict) and isinstance(spawned.get("sessionId"), str):
                record["parent"] = spawned["sessionId"][:80]
        except ValueError:
            pass
    if not record["archived"] and (m := _SUMMARY.search(raw)):
        text = raw[m.end() - 1:m.end() + 8191].decode("utf-8", errors="replace")
        try:
            summary, end = json.JSONDecoder().raw_decode(text)
            last = _LAST.search(text, end)
            # A summary of an earlier turn would describe work the session has since moved past.
            if isinstance(summary, dict) and (not last or json.loads(last.group(1)) in (None, summary.get("summarizes_uuid"))):
                record["status"] = {"category": str(summary.get("status_category") or "")[:40],
                                    "detail": str(summary.get("status_detail") or "")[:300],
                                    "needsAction": str(summary.get("needs_action") or "")[:300]}
        except ValueError:
            pass
    return record


def _roots():
    home = Path.home()
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA", home / "AppData" / "Local")) / "Claude-Data"
        return list(base.glob("claude_*/claude-code-sessions")) + [Path(os.environ.get("APPDATA", home / "AppData" / "Roaming")) / "Claude" / "claude-code-sessions"]
    if sys.platform == "darwin":
        return [home / "Library" / "Application Support" / "Claude" / "claude-code-sessions"]
    return [home / ".config" / "Claude" / "claude-code-sessions"]


def claude_app_records():
    """Command-line session id -> what the Claude app shows for it, for sessions the app knows (kept for 30 seconds)."""
    if time.time() - _cache["at"] < 30:
        return _cache["records"]
    records = {}
    for root in _roots():
        if not root.is_dir():
            continue
        for path in root.glob("*/*/local_*.json"):
            try:
                modified = path.stat().st_mtime
                if _files.get(path, (None,))[0] != modified:
                    _files[path] = (modified, _read(path))
            except OSError:
                continue
            record = _files[path][1]
            if record["cli"] and record["own"] and record["own"].startswith("local_"):
                records[record["cli"]] = record
    _cache.update(at=time.time(), records=records)
    return records


def claude_app_ids():
    """Command-line session id -> the Claude app's own id, for sessions open in the app (not archived there)."""
    return {cli: r["own"] for cli, r in claude_app_records().items() if not r["archived"]}


def app_ready(provider):
    return launch._protocol(provider) or launch._mac_app("Claude" if provider == "claude" else "Codex")


def opens_in(provider, session_id):
    """Where Open would take this conversation: "app" when its desktop app can show it, else "terminal"."""
    if not app_ready(provider):
        return "terminal"
    if provider == "codex":
        return "app"
    return "app" if session_id in claude_app_ids() else "terminal"


def app_link(provider, session_id):
    if provider == "codex":
        return f"codex://threads/{session_id}"
    own = claude_app_ids().get(session_id)
    return f"claude://code/continue?session={own}" if own else None
