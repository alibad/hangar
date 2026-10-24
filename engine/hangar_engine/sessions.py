"""When you last worked on each checkout with Claude Code, from its local history in ~/.claude/projects.

Read-only: it opens the newest transcript of each project only to learn the folder it ran in.
"""
import json
import os
from datetime import datetime, timezone
from pathlib import Path


def projects_dir():
    return Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude") / "projects"


def _cwd_of(transcript, max_lines=60):
    try:
        with open(transcript, encoding="utf-8", errors="replace") as f:
            for i, line in enumerate(f):
                if i >= max_lines:
                    break
                if '"cwd"' not in line:
                    continue
                try:
                    cwd = json.loads(line).get("cwd")
                except ValueError:
                    continue
                if cwd:
                    return cwd
    except OSError:
        pass
    return None


def collect():
    """[{'cwd', 'last', 'count'}] for every Claude Code project folder on this machine."""
    out = []
    base = projects_dir()
    if not base.is_dir():
        return out
    for proj in base.iterdir():
        if not proj.is_dir():
            continue
        files = sorted(proj.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
        if not files:
            continue
        cwd = None
        for f in files[:3]:
            cwd = _cwd_of(f)
            if cwd:
                break
        if not cwd:
            continue
        last = datetime.fromtimestamp(files[0].stat().st_mtime, timezone.utc).isoformat(timespec="seconds")
        out.append({"cwd": cwd, "last": last, "count": len(files)})
    return out


def attach(overlay, sessions):
    """Credit each session folder to the deepest site that contains it."""
    from .local import site_path
    paths = []
    for s in overlay["sites"]:
        p = site_path(overlay, s)
        if p:
            paths.append((os.path.normcase(str(p)).rstrip("\\/"), s))
    paths.sort(key=lambda x: len(x[0]), reverse=True)
    for sess in sessions:
        cwd = os.path.normcase(sess["cwd"]).rstrip("\\/")
        for p, site in paths:
            if cwd == p or cwd.startswith(p + os.sep):
                if not site.get("lastSession") or sess["last"] > site["lastSession"]:
                    site["lastSession"] = sess["last"]
                site["sessions"] = site.get("sessions", 0) + sess["count"]
                break
    return overlay
