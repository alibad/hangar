"""Which conversations the Claude and Codex desktop apps can open themselves.

The Claude app keeps one small record per Code session (local_<id>.json) that names the command-line session it runs
(cliSessionId); its link claude://code/continue?session=local_<id> opens that session in the app. A conversation the
app never saw (a terminal session, a Hangar job) has no record, and only a terminal can resume it. The Codex app opens
any thread by id.
"""
import os
import re
import sys
import time
from pathlib import Path

from . import launch

_cache = {"at": 0.0, "ids": {}}
_files = {}  # path -> (modified, cli id, own id, archived): a record is re-read only when it changes
_FIELD = {k: re.compile(rf'"{k}"\s*:\s*("([^"]*)"|true|false)') for k in ("sessionId", "cliSessionId", "isArchived")}


def _head(path):
    """The ids sit at the start of each record; the rest (tool and prompt snapshots) can be large."""
    with open(path, "rb") as f:
        text = f.read(4096).decode("utf-8", errors="replace")
    found = {k: m.group(2) if m.group(2) is not None else m.group(1) for k, rx in _FIELD.items() if (m := rx.search(text))}
    return found.get("cliSessionId"), found.get("sessionId"), found.get("isArchived") == "true"


def _roots():
    home = Path.home()
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA", home / "AppData" / "Local")) / "Claude-Data"
        return list(base.glob("claude_*/claude-code-sessions")) + [Path(os.environ.get("APPDATA", home / "AppData" / "Roaming")) / "Claude" / "claude-code-sessions"]
    if sys.platform == "darwin":
        return [home / "Library" / "Application Support" / "Claude" / "claude-code-sessions"]
    return [home / ".config" / "Claude" / "claude-code-sessions"]


def claude_app_ids():
    """Command-line session id -> the Claude app's own id, for sessions the app knows (kept for 30 seconds)."""
    if time.time() - _cache["at"] < 30:
        return _cache["ids"]
    ids = {}
    for root in _roots():
        if not root.is_dir():
            continue
        for path in root.glob("*/*/local_*.json"):
            try:
                modified = path.stat().st_mtime
                if _files.get(path, (None,))[0] != modified:
                    _files[path] = (modified, *_head(path))
            except OSError:
                continue
            _, cli, own, archived = _files[path]
            if cli and own and own.startswith("local_") and not archived:
                ids[cli] = own
    _cache.update(at=time.time(), ids=ids)
    return ids


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
