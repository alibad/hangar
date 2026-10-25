"""Whether each coding agent can run here on the owner's own sign-in, and a way to sign in again.

Hangar never runs Claude Code or Codex with an API key (see config.child_env), so a lapsed command-line sign-in
stops its jobs. This reads only the sign-in's expiry and kind from each agent's own files, never the tokens, and
starts the agent's own sign-in command in a terminal when the owner asks.
"""
import json
import time
from pathlib import Path

from . import launch, work


def _from_jobs(aid, signed_in, reason=""):
    """A sign-in the files cannot judge (or that looks fine) still counts as lapsed when the last job failed on it."""
    if aid in work.signed_out():
        return {"signedIn": False, "reason": "The last Hangar job could not sign in."}
    return {"signedIn": signed_in, "reason": reason}


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
    return _from_jobs("claude", True)


def _codex():
    try:
        auth = json.loads((Path.home() / ".codex" / "auth.json").read_text(encoding="utf-8")) or {}
    except (OSError, ValueError):
        return {"signedIn": False, "reason": "Codex is not signed in on this machine."}
    if auth.get("tokens"):
        return _from_jobs("codex", True)
    return {"signedIn": False, "reason": "Codex is not signed in with your ChatGPT account on this machine."}


def status():
    out = []
    for aid, check in (("claude", _claude), ("codex", _codex)):
        installed = bool(launch.cli(aid))
        out.append({"id": aid, "name": launch.NAMES.get(aid, aid), "installed": installed,
                    **(check() if installed else {"signedIn": None, "reason": "Not installed on this machine."})})
    return {"agents": out}


def sign_in(aid):
    """Open the agent's own sign-in in a terminal; it opens the browser for the owner's account."""
    exe = launch.cli(aid) if aid in ("claude", "codex") else None
    if not exe:
        raise ValueError("That agent is not installed on this machine.")
    launch._terminal(str(Path.home()), [exe, "auth", "login"] if aid == "claude" else [exe, "login"])
    return {"opened": True, "agent": aid}
