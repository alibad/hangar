"""Bundled engine paths. All machine data, project notes and caches stay in ignored var/engine.
HANGAR_ENGINE_DATA_DIR can select a separate private runtime directory.
"""
import getpass
import hashlib
import json
import os
import re
import socket
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
LOCAL = Path(os.environ.get("HANGAR_ENGINE_DATA_DIR") or REPO / "var" / "engine").resolve()
SPINE = LOCAL / "spine"
VIEWER = REPO / "engine" / "world"
MACHINES = LOCAL / "machines"
CACHE = LOCAL / "cache"
ROOTS_FILE = LOCAL / "roots.json"

# Folder names under the home folder that usually hold code. Only the ones that exist become roots.
HOME_CANDIDATES = ["Code", "code", "src", "Source", "source/repos", "projects", "Projects", "dev", "repos", "git",
                   "Documents", "Desktop"]


def machine_identity():
    """A short id that is stable for this computer and user, and says nothing about either."""
    host = socket.gethostname().lower()
    user = getpass.getuser().lower()
    mid = hashlib.sha1(f"{host}|{user}".encode()).hexdigest()[:6]
    return {"id": mid, "os": sys.platform}


def root_id(path, taken=()):
    """CODE for ~/Code, D for D:\\, DOCUMENTS for ~/Documents; suffixed if already taken."""
    p = Path(path)
    name = p.name or p.drive.rstrip(":\\/") or "ROOT"
    base = re.sub(r"[^A-Za-z0-9]+", "_", name).strip("_").upper() or "ROOT"
    rid, n = base, 2
    while rid in taken:
        rid, n = f"{base}{n}", n + 1
    return rid


def default_roots():
    roots = {}
    home = Path.home()
    for name in HOME_CANDIDATES:
        p = home / name
        if p.is_dir() and not any(_same(p, Path(v)) for v in roots.values()):
            roots[root_id(p, roots)] = str(p)
    return roots


def _same(a, b):
    try:
        return a.resolve() == b.resolve()
    except OSError:
        return False


def load_roots():
    """This machine's scan settings. Written with defaults on first use so it can be edited by hand."""
    if ROOTS_FILE.exists():
        cfg = json.loads(ROOTS_FILE.read_text(encoding="utf-8"))
    else:
        cfg = {}
    cfg.setdefault("label", socket.gethostname().lower())
    cfg.setdefault("roots", default_roots())
    cfg.setdefault("canonical", list(cfg["roots"])[:1])
    cfg.setdefault("maxDepth", 5)
    cfg.setdefault("release", ["release"])
    cfg.setdefault("owners", [])
    return cfg


def save_roots(cfg):
    LOCAL.mkdir(parents=True, exist_ok=True)
    write_json(ROOTS_FILE, cfg, indent=2)


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def write_json(path, data, indent=1):
    """Atomic, UTF-8, LF line endings on every platform (the repo stores LF)."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    import tempfile
    import time
    fd, tmp = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            f.write(json.dumps(data, indent=indent, ensure_ascii=False) + "\n")
        for attempt in range(20):  # Windows refuses to replace a file someone is reading this instant
            try:
                os.replace(tmp, path)
                return
            except PermissionError:
                if attempt == 19:
                    raise
                time.sleep(0.05)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
