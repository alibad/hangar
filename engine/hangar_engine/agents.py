"""Whether each coding agent can run here on the owner's own sign-in, and a way to sign in again.

Hangar never runs Claude Code or Codex with an API key (see config.child_env), so a lapsed command-line sign-in
stops its jobs. This reads only the sign-in's expiry and kind from each agent's own files, never the tokens, and
starts the agent's own sign-in (which opens the browser) when the owner asks.
"""
import json
import subprocess
import threading
import time
from datetime import datetime
from pathlib import Path

from . import config, launch, work


def _from_jobs(aid, signed_in, reason="", since=None):
    """A sign-in the files cannot judge (or that looks fine) still counts as lapsed when a job failed on it, unless
    the owner signed in again after that job (the sign-in file changed later)."""
    failed = work.sign_in_failures().get(aid)
    if failed:
        try:
            failed_at = datetime.fromisoformat(failed).timestamp()
        except ValueError:
            failed_at = None
        if since is None or failed_at is None or since <= failed_at:
            return {"signedIn": False, "reason": "The last Hangar job could not sign in."}
    return {"signedIn": signed_in, "reason": reason}


def _changed(path):
    try:
        return path.stat().st_mtime
    except OSError:
        return None


def _claude():
    path = Path.home() / ".claude" / ".credentials.json"
    if not path.is_file():
        # Some systems keep the sign-in in the OS keychain; then only a job can tell.
        return _from_jobs("claude", None)
    try:
        oauth = (json.loads(path.read_text(encoding="utf-8")) or {}).get("claudeAiOauth") or {}
    except (OSError, ValueError):
        return _from_jobs("claude", None)
    if not oauth.get("accessToken"):
        return {"signedIn": False, "reason": "Claude Code is not signed in on this machine."}
    expires = (oauth.get("expiresAt") or 0) / 1000
    if expires and expires < time.time() and not oauth.get("refreshToken"):
        return {"signedIn": False, "reason": f"Claude Code's sign-in on this machine expired on {time.strftime('%d %b %Y', time.localtime(expires))}."}
    return _from_jobs("claude", True, since=_changed(path))


def _codex():
    path = Path.home() / ".codex" / "auth.json"
    try:
        auth = json.loads(path.read_text(encoding="utf-8")) or {}
    except (OSError, ValueError):
        return {"signedIn": False, "reason": "Codex is not signed in on this machine."}
    if auth.get("tokens"):
        return _from_jobs("codex", True, since=_changed(path))
    return {"signedIn": False, "reason": "Codex is not signed in with your ChatGPT account on this machine."}


def status():
    out = []
    for aid, check in (("claude", _claude), ("codex", _codex)):
        installed = bool(launch.cli(aid))
        out.append({"id": aid, "name": launch.NAMES.get(aid, aid), "installed": installed,
                    **(check() if installed else {"signedIn": None, "reason": "Not installed on this machine."})})
    return {"agents": out}


def sign_in(aid):
    """Start the agent's own sign-in. It opens the browser for the owner's account and waits for the answer, so it runs
    without a window; only when it stops at once (it wanted to ask something) does it get a terminal."""
    exe = launch.cli(aid) if aid in ("claude", "codex") else None
    if not exe:
        raise ValueError("That agent is not installed on this machine.")
    cmd = [exe, "auth", "login", "--claudeai"] if aid == "claude" else [exe, "login"]
    with open(config.LOCAL / f"sign-in-{aid}.log", "w", encoding="utf-8") as out:
        process = subprocess.Popen(cmd, cwd=str(Path.home()), stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT,
                                   env=config.child_env(agent=True), creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    try:
        code = process.wait(timeout=4)
    except subprocess.TimeoutExpired:
        # Waiting on the browser. Give up after ten minutes so no sign-in lingers.
        threading.Timer(600, lambda: process.poll() is None and process.kill()).start()
        return {"opened": True, "agent": aid, "where": "browser"}
    if code == 0:
        return {"opened": True, "agent": aid, "where": "done"}
    launch._terminal(str(Path.home()), cmd)
    return {"opened": True, "agent": aid, "where": "terminal"}
