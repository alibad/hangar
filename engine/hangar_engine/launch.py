"""Open a repo's folder in a coding agent (Claude Code, Codex) or an editor on this machine.

Agents open through their desktop apps' own links, so a new session starts in that folder:
claude://code/new?folder=... and codex://threads/new?path=... . A command-line install is the fallback.
The folder always comes from this machine's overlay and the starting prompt from INTENTS, never from a request.
"""
import os
import re
import shlex
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlencode

# What a session is asked first, by what is waiting on the repo. Each one looks and proposes; none changes anything.
INTENTS = {
    "commit": "Look at the uncommitted changes in this repo and suggest how to commit them. Don't commit anything until I say so.",
    "push": "Some commits here are on no remote branch yet. Show me what they are and whether they are ready to push. Don't push until I say so.",
    "pull": "GitHub has newer commits than this folder. Show me what changed there and whether a fast-forward pull is safe. Don't pull until I say so.",
    "prs": "List this repo's open pull requests on GitHub with a line on each, and say which ones need me.",
}
NAMES = {"claude": "Claude Code", "codex": "Codex", "code": "VS Code", "cursor": "Cursor",
         "folder": {"win32": "Explorer", "darwin": "Finder"}.get(sys.platform, "Files")}


# Launched programs never write into Hangar's own output: under `atlas.py mcp` that output is the MCP protocol.
QUIET = {"stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}


class LaunchError(Exception):
    pass


def _protocol(scheme):
    """True when a desktop app has registered this URL scheme (Windows)."""
    if sys.platform != "win32":
        return False
    import winreg
    for hive, key in ((winreg.HKEY_CURRENT_USER, rf"Software\Classes\{scheme}"), (winreg.HKEY_CLASSES_ROOT, scheme)):
        try:
            winreg.CloseKey(winreg.OpenKey(hive, key))
            return True
        except OSError:
            continue
    return False


def _mac_app(name):
    return sys.platform == "darwin" and (Path("/Applications") / f"{name}.app").exists()


def _version_key(p):
    return tuple(int(x) for x in re.findall(r"\d+", p.name)) or (0,)


def bundled_cli(name):
    """The copy of the claude or codex command a desktop app keeps for itself, newest first."""
    home = Path.home()
    local = Path(os.environ.get("LOCALAPPDATA", home / "AppData" / "Local"))
    found = []
    if name == "claude":
        for base in local.glob("Claude-Data/claude_*/claude-code"):
            for ver in sorted(base.iterdir(), key=_version_key, reverse=True):
                found += sorted(ver.glob("*/claude.exe")) + sorted(ver.glob("claude.exe"))
        found += [home / ".local" / "bin" / "claude.exe", home / ".local" / "bin" / "claude", home / ".claude" / "local" / "claude"]
    elif name == "codex":
        found += sorted(local.glob("OpenAI/Codex/bin/*/codex.exe"), key=lambda p: p.stat().st_mtime, reverse=True)
    return next((str(p) for p in found if p.is_file()), None)


def cli(name):
    return shutil.which(name) or (shutil.which(f"{name}.cmd") if sys.platform == "win32" else None) or bundled_cli(name)


def available():
    """What this machine can open a folder with: agents first, then editors, then the file manager."""
    apps = []
    for aid, scheme, mac in (("claude", "claude", "Claude"), ("codex", "codex", "Codex")):
        if _protocol(scheme) or _mac_app(mac):
            apps.append({"id": aid, "name": NAMES[aid], "kind": "agent", "how": "app"})
        elif shutil.which(aid):
            apps.append({"id": aid, "name": NAMES[aid], "kind": "agent", "how": "cli"})
    if shutil.which("code") or shutil.which("code.cmd"):
        apps.append({"id": "code", "name": NAMES["code"], "kind": "editor", "how": "cli"})
    cursor_exe = Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "cursor" / "Cursor.exe"
    if shutil.which("cursor") or (sys.platform == "win32" and cursor_exe.is_file()) or _mac_app("Cursor"):
        apps.append({"id": "cursor", "name": NAMES["cursor"], "kind": "editor", "how": "cli"})
    apps.append({"id": "folder", "name": NAMES["folder"], "kind": "folder", "how": "os"})
    return apps


def link(app_id, folder, intent=None):
    """The desktop-app link that starts a new session in this folder, with a starting prompt from INTENTS."""
    prompt = INTENTS.get(intent or "")
    if app_id == "claude":
        return "claude://code/new?" + urlencode([("folder", str(folder))] + ([("q", prompt)] if prompt else []))
    if app_id == "codex":
        return "codex://threads/new?" + urlencode([("path", str(folder))] + ([("prompt", prompt)] if prompt else []))
    raise LaunchError(f"No app link for {app_id}.")


def _open_os(target):
    if sys.platform == "win32":
        os.startfile(target)  # noqa: S606 - a link built above, or a folder this machine's overlay resolved
    elif sys.platform == "darwin":
        subprocess.Popen(["open", target], **QUIET)
    else:
        subprocess.Popen(["xdg-open", target], **QUIET)


def _terminal(folder, cmd):
    """Run an agent's command line in a new terminal window, in that folder."""
    if sys.platform == "win32":
        subprocess.Popen(cmd, cwd=folder, creationflags=subprocess.CREATE_NEW_CONSOLE)
    elif sys.platform == "darwin":
        line = f"cd {shlex.quote(folder)} && {shlex.join(cmd)}"
        line = line.replace("\\", "\\\\").replace('"', '\\"')
        subprocess.Popen(["osascript", "-e", f'tell application "Terminal" to do script "{line}"'], **QUIET)
    else:
        term = shutil.which("x-terminal-emulator") or shutil.which("gnome-terminal")
        if not term:
            raise LaunchError("No terminal found to start it in.")
        subprocess.Popen([term, "--", *cmd] if term.endswith("gnome-terminal") else [term, "-e", shlex.join(cmd)], cwd=folder, **QUIET)


def open_in(app_id, folder, intent=None):
    """Open folder with app_id (claude, codex, code, cursor, folder). Raises LaunchError when that is not possible."""
    folder = str(folder)
    if not Path(folder).is_dir():
        raise LaunchError("That folder is not on this machine any more.")
    app = next((a for a in available() if a["id"] == app_id), None)
    if not app:
        raise LaunchError(f"{NAMES.get(app_id, app_id)} is not installed on this machine.")
    try:
        if app["kind"] == "agent" and app["how"] == "app":
            _open_os(link(app_id, folder, intent))
        elif app["kind"] == "agent":
            prompt = INTENTS.get(intent or "")
            _terminal(folder, [cli(app_id) or app_id] + ([prompt] if prompt else []))
        elif app_id == "cursor" and _mac_app("Cursor") and not shutil.which("cursor"):
            subprocess.Popen(["open", "-a", "Cursor", folder], **QUIET)
        elif app_id in ("code", "cursor"):
            exe = shutil.which(app_id) or shutil.which(f"{app_id}.cmd") or str(Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "cursor" / "Cursor.exe")
            subprocess.Popen([exe, folder], close_fds=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), **QUIET)
        else:
            _open_os(folder)
    except OSError as e:
        raise LaunchError(f"Could not start {app['name']}: {e}") from e
    return app
