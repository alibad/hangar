"""Optional local source index. The checkout and tool are chosen on the owning machine."""
import hashlib
import json
import os
import re
import subprocess
import threading
from datetime import datetime, timezone
from pathlib import Path

from . import config, work
from .insights import SOURCE

_lock = threading.Lock()
_pending = {}
_PATH = re.compile(r"[A-Za-z0-9_./ @+()\[\]-]{1,300}")
_SHA = re.compile(r"[0-9a-f]{40,64}")
_TYPES = ("IMPORTS", "CALLS")


def binary():
    # An absolute path selected by the operator. Never discover binaries in an indexed checkout.
    path = Path(os.environ.get("HANGAR_CBM_BIN") or ".").expanduser()
    return path if path.is_absolute() and path.is_file() else None


def run(args, folder, env=None, timeout=15):
    try:
        result = subprocess.run(args, cwd=folder, input="", capture_output=True, env=env,
                                encoding="utf-8", errors="replace", timeout=timeout,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except subprocess.TimeoutExpired as exc:
        raise ValueError("The code index operation timed out.") from exc
    if result.returncode:
        raise ValueError("The local code index command failed.")
    return result.stdout


def revision(folder):
    root, sha = run(["git", "rev-parse", "--show-toplevel", "HEAD"], folder).splitlines()
    if Path(root).resolve() != folder.resolve():
        raise ValueError("The detected checkout must be a Git root.")
    if not _SHA.fullmatch(sha):
        raise ValueError("The checkout has no readable Git revision.")
    return sha


def dirty(folder):
    return bool(run(["git", "--no-optional-locks", "status", "--porcelain", "-z"], folder))


def storage(folder):
    key = hashlib.sha256(str(folder.resolve()).encode()).hexdigest()[:20]
    return config.LOCAL / "code-graph" / key


def cbm(folder, tool, *args, timeout=12):
    exe = binary()
    if not exe:
        raise ValueError("Configure HANGAR_CBM_BIN on this machine to use the code index.")
    location = storage(folder)
    cache = location / "cache"
    cache.mkdir(parents=True, exist_ok=True)
    # Isolated from client indexes and from the operator's agent configuration.
    env = config.child_env(agent=True, extra={"CBM_CACHE_DIR": str(cache.resolve())})
    output = run([str(exe), "cli", "--quiet", tool, *args], folder, env=env, timeout=timeout)
    try:
        data = json.loads(output)
    except ValueError as exc:
        raise ValueError("The local code index did not return JSON.") from exc
    if not isinstance(data, dict) or data.get("error") or data.get("isError"):
        raise ValueError("The local code index could not answer this request.")
    return data


def index(folder):
    head = revision(folder)
    if dirty(folder):
        raise ValueError("Start with a clean checkout to create a committed baseline.")
    location = storage(folder)
    with _lock:
        if any(state["state"] == "indexing" for state in _pending.values()):
            raise ValueError("This machine is already building a code index.")
        _pending[location] = {"state": "indexing"}

    def build():
        try:
            # Keep the previous baseline unpublished while the store is being replaced.
            config.write_json(location / "baseline.json", None)
            result = cbm(folder, "index_repository", "--repo-path", str(folder), "--name", "checkout", "--mode", "fast", timeout=180)
            if result.get("status") != "indexed" or not result.get("nodes"):
                raise ValueError("The indexer returned no code graph.")
            if revision(folder) != head or dirty(folder):
                raise ValueError("The checkout changed during indexing. Build the index again.")
            config.write_json(location / "baseline.json", {
                "revision": head, "indexedAt": datetime.now(timezone.utc).isoformat(),
                "nodes": result["nodes"], "edges": result.get("edges", 0),
                "partial": result.get("parse_partial_count", 0),
                "skipped": result.get("skipped_count", 0) + result.get("parse_unusable_count", 0),
            })
            state = {"state": "ready"}
        except (ValueError, OSError) as exc:
            state = {"state": "failed", "error": str(exc)}
        with _lock:
            if state["state"] == "ready":
                _pending.pop(location, None)
            else:
                _pending[location] = state

    threading.Thread(target=build, daemon=True, name="hangar-code-index").start()
    return {"state": "indexing"}


def status(doc, overlay, rid):
    if not binary():
        return {"state": "unconfigured"}
    try:
        _, folder = work.checkout(doc, overlay, rid)
    except ValueError:
        return {"state": "no-checkout"}
    head = revision(folder)
    location = storage(folder)
    baseline = config.read_json(location / "baseline.json")
    with _lock:
        progress = _pending.get(location, {})
    state = progress.get("state")
    if state not in ("indexing", "failed"):
        state = "empty" if not baseline else "ready" if baseline["revision"] == head else "stale"
    return {**progress, "state": state, "baseline": baseline, "revision": head, "dirty": dirty(folder)}


def supported_path(path):
    return (isinstance(path, str) and _PATH.fullmatch(path) and not path.startswith("/")
            and all(part not in ("", ".", "..") and not part.startswith(".") for part in path.split("/"))
            and Path(path).suffix.lower() in SOURCE)


def tracked_files(folder, head):
    paths = {}
    for entry in run(["git", "ls-tree", "-r", "-z", head], folder).split("\x00"):
        meta, _, path = entry.partition("\t")
        if meta.startswith("100") and supported_path(path):
            paths[path] = meta.split()[-1]
    return paths


def files(paths, term):
    if not isinstance(term, str) or len(term) > 160:
        raise ValueError("Enter a shorter file name.")
    matches = sorted(path for path in paths if term.lower() in path.lower())
    return {"files": matches[:80], "total": len(matches)}


def dependencies(folder, paths, selected):
    if selected not in paths:
        raise ValueError("Choose a tracked source file from the current revision.")
    edges = []
    seen = set()
    omitted = False
    for relation in _TYPES:
        for direction, node in [("in", "b"), ("out", "a")]:
            # File literals are restricted to tracked paths without quote or escape characters.
            other = "a" if node == "b" else "b"
            query = (f"MATCH (a)-[r:{relation}]->(b) WHERE {node}.file_path = '{selected}' AND {other}.file_path != '{selected}' "
                     "RETURN a.file_path, a.name, b.file_path, b.name, r.line, r.confidence, r.strategy LIMIT 120")
            data = cbm(folder, "query_graph", "--project", "checkout", "--format", "json",
                       "--max-rows", "32", "--max-output-tokens", "3500", "--query", query, timeout=4)
            omitted |= bool(data.get("has_more") or data.get("truncated") or data.get("total", 0) >= 120)
            for source, caller, target, callee, line, confidence, strategy in data.get("rows", []):
                key = (relation, source, caller, target, callee, line)
                if source not in paths or target not in paths or source == target or key in seen:
                    continue
                seen.add(key)
                edges.append({"type": relation, "direction": direction, "source": source, "target": target,
                              "caller": caller, "callee": callee, "line": int(line) if str(line).isdigit() else None,
                              "confidence": confidence, "strategy": strategy})
    return {"file": selected, "edges": edges, "omitted": omitted}


def source(folder, paths, path, requested):
    if path not in paths or not re.fullmatch(r"[1-9][0-9]{0,6}", requested):
        raise ValueError("Choose a line from a tracked source file.")
    blob = paths[path]
    if int(run(["git", "cat-file", "-s", blob], folder)) > 400_000:
        raise ValueError("This file is too large for the source preview.")
    lines = run(["git", "cat-file", "blob", blob], folder).splitlines()
    line = int(requested)
    if line > len(lines):
        raise ValueError("That line is unavailable at this commit.")
    first = max(1, line - 3)
    return {"file": path, "line": line, "first": first, "lines": [row[:500] for row in lines[first - 1:line + 3]]}


def inspect(doc, overlay, rid, view, value, line=""):
    snapshot = status(doc, overlay, rid)
    if view == "status" or snapshot["state"] != "ready":
        return snapshot
    _, folder = work.checkout(doc, overlay, rid)
    paths = tracked_files(folder, snapshot["revision"])
    if view == "files":
        answer = files(paths, value)
    elif view == "dependencies":
        answer = dependencies(folder, paths, value)
    elif view == "source":
        answer = {"source": source(folder, paths, value, line)}
    elif view == "impact":
        data = cbm(folder, "detect_changes", "--project", "checkout", "--base-branch", "HEAD", "--format", "json",
                   "--depth", "2", "--seeds", "list", "--via", "true", "--limit", "50",
                   "--max-output-tokens", "5000")
        if data.get("merge_base") != snapshot["revision"]:
            raise ValueError("The worktree changed revision during analysis. Refresh the baseline.")
        answer = {"impact": {
            "changed": [p for p in data["changed_files"] if supported_path(p)],
            "changedTotal": data["changed_total"],
            "seeds": [row for row in data["seeds"] if row.get("file") in paths],
            "callers": [row for row in data["impacted"] if row.get("file") in paths],
            "omitted": any(data.get(key) for key in ("changed_has_more", "seed_has_more", "impacted_has_more", "truncated")),
        }}
    else:
        raise ValueError("Choose a code graph view.")
    if revision(folder) != snapshot["revision"] or config.read_json(storage(folder) / "baseline.json") != snapshot["baseline"]:
        raise ValueError("The checkout moved during analysis. Refresh the baseline.")
    return {**snapshot, **answer}


def start(doc, overlay, rid):
    if not binary():
        raise ValueError("Configure HANGAR_CBM_BIN on this machine to use the code index.")
    _, folder = work.checkout(doc, overlay, rid)
    return index(folder)
