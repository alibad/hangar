"""Explicit workspace operations. Private preferences and bounded background jobs."""
import copy
import os
import re
import subprocess
import threading
import uuid
from pathlib import Path
from urllib.parse import urlsplit

from . import config, gitops, model

_lock = threading.RLock()
_jobs = {}


def preferences():
    return config.read_json(config.LOCAL / "islands.json", {}) or {}


def island_action(doc, body):
    action, fid = body.get("action"), body.get("island")
    with _lock:
        prefs = preferences()
        custom, hidden = prefs.setdefault("custom", {}), prefs.setdefault("hidden", {})
        known = {f["id"]: f for f in doc.get("islands", doc["families"])}
        if action == "create-island":
            name = body.get("name")
            if not isinstance(name, str) or not name.strip() or len(name.strip()) > 60:
                raise ValueError("Name the island (up to 60 characters).")
            if any(f["name"].casefold() == name.strip().casefold() for f in known.values()):
                raise ValueError("An island already has that name.")
            fid = "custom-" + uuid.uuid4().hex[:12]
            custom[fid] = name.strip()
        elif action in ("hide-island", "restore-island"):
            if not isinstance(fid, str) or fid not in known:
                raise ValueError("Choose an island from this world.")
            if action == "hide-island":
                hidden[fid] = known[fid]["name"]
            else:
                hidden.pop(fid, None)
        elif action == "assign-island":
            if not isinstance(fid, str) or fid not in known or fid in hidden:
                raise ValueError("Choose a visible island.")
            ids = body.get("repos")
            if not isinstance(ids, list) or not ids or len(ids) > 300 or any(not isinstance(rid, str) for rid in ids):
                raise ValueError("Choose projects to move.")
            if not set(ids).issubset({r["id"] for r in doc["repos"]}):
                raise ValueError("A selected project is no longer indexed.")
            for rid in set(ids):
                model.save_notes(doc, rid, {"family": fid, "focus": False, "parked": False, "hidden": False})
        else:
            raise ValueError("Unknown island action.")
        config.write_json(config.LOCAL / "islands.json", prefs)
        return {"island": fid, "saved": True}


def clone_target(doc, body):
    repo = next((r for r in doc["repos"] if r["id"] == body.get("repo")), None)
    if not repo or repo.get("sites"):
        raise ValueError("Choose an indexed project without a checkout on this machine.")
    slug = repo.get("fullName") or ""
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*", slug) or urlsplit(repo.get("url") or "").hostname != "github.com":
        raise ValueError("Only indexed GitHub repositories can be cloned here.")
    roots = config.load_roots()
    root_id = body.get("root")
    if not isinstance(root_id, str) or root_id not in roots.get("canonical", []) or root_id not in roots["roots"]:
        raise ValueError("Choose a configured main code root.")
    root = Path(roots["roots"][root_id]).resolve()
    name = body.get("folder") or repo["name"]
    if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,99}", name) or name.endswith((".", " ")) or name.split(".")[0].upper() in {"CON", "PRN", "AUX", "NUL", *[f"{p}{i}" for p in ("COM", "LPT") for i in range(1, 10)]}:
        raise ValueError("Use a simple folder name, without slashes or reserved names.")
    destination = root / name
    if not root.is_dir() or destination.resolve().parent != root or destination.exists() or destination.is_symlink():
        raise ValueError("The code root is unavailable or that destination already exists. Nothing was overwritten.")
    return repo, destination, f"https://github.com/{slug}.git"


def snapshot(doc):
    roots = config.load_roots()
    with _lock:
        return {"roots": [{"id": key, "path": value} for key, value in roots["roots"].items() if key in roots.get("canonical", [])],
                "jobs": copy.deepcopy(list(_jobs.values())[-12:]), "islands": doc.get("islands", doc["families"])}


def start(doc, overlay, body, refresh):
    action = body.get("action")
    if action == "clone":
        repo, destination, url = clone_target(doc, body)
        label = f"Clone {repo['name']}"
    elif action == "pull":
        ids = body.get("repos")
        if not isinstance(ids, list) or not ids or len(ids) > 300 or any(not isinstance(rid, str) for rid in ids):
            raise ValueError("Choose repositories to pull.")
        if not set(ids).issubset({r["id"] for r in doc["repos"]}):
            raise ValueError("A selected repository is no longer indexed.")
        label = f"Pull {len(set(ids))} repositories"
    else:
        raise ValueError("Choose clone or pull.")
    with _lock:
        if any(j["state"] == "running" for j in _jobs.values()):
            raise ValueError("A workspace operation is already running. Wait for its results.")
        if action == "clone":
            # Claim an empty destination atomically, before a background worker starts.
            destination.mkdir()
        jid = uuid.uuid4().hex
        job = {"id": jid, "action": action, "label": label, "state": "running", "results": [], "repo": body.get("repo")}
        _jobs[jid] = job
        for old in list(_jobs)[:-12]:
            del _jobs[old]

    def run():
        try:
            if action == "clone":
                result = subprocess.run(["git", "clone", "--", url, str(destination)], stdin=subprocess.DEVNULL,
                                        capture_output=True, text=True, encoding="utf-8", errors="replace",
                                        timeout=600, env=gitops.ENV, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                if result.returncode:
                    raise ValueError("Clone failed. Check this machine's GitHub access. The destination is kept for inspection; choose a new folder to retry.")
                results = [{"repo": repo["id"], "name": repo["name"], "status": "done", "message": "Cloned and indexed. Ready to start or continue coding."}]
            else:
                from . import work
                active = {j["repo"] for j in work.snapshot()["jobs"] if j["state"] in ("running", "stopping", "unobserved")}
                results = gitops.run(doc, overlay, "pull", list(dict.fromkeys(ids)), all_main=True, busy_repos=active)
            refresh()
            with _lock:
                job.update(state="done", results=results)
        except Exception as error:
            with _lock:
                job.update(state="failed", error="Operation timed out; inspect its destination before retrying." if isinstance(error, subprocess.TimeoutExpired) else str(error))
    threading.Thread(target=run, daemon=True).start()
    return {"job": copy.deepcopy(job)}
