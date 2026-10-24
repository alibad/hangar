"""Read-only project evidence: tracked structure, resolved imports and Git chronology.

No source bodies or credentials leave this module. Labels describe observations,
not an AI claim that directory names prove a runtime architecture.
"""
import json
import re
import subprocess
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from . import local

SKIP = {"node_modules", "vendor", ".git", ".next", "dist", "build", "coverage", "var", "__pycache__"}
SOURCE = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".py", ".go", ".rs", ".cs"}

def git(folder, *args):
    try:
        result = subprocess.run(["git", "-C", str(folder), *args], stdin=subprocess.DEVNULL,
                                capture_output=True, timeout=25, encoding="utf-8", errors="replace",
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return result.stdout if result.returncode == 0 else ""
    except (OSError, subprocess.TimeoutExpired):
        return ""

def safe_read(root, rel):
    path = (root / rel).resolve()
    if root not in path.parents or not path.is_file() or path.stat().st_size > 160_000:
        return ""
    return path.read_text(encoding="utf-8", errors="replace")

def module_for(path):
    parts = PurePosixPath(path).parts
    if len(parts) == 1:
        return "root"
    if parts[0] in {"src", "packages", "apps", "services", "engine"} and len(parts) > 2:
        if parts[:3] == ("src", "app", "api"):
            return "src/app/api"
        return "/".join(parts[:2])
    return parts[0]

def architecture(folder):
    root = Path(folder).resolve()
    tracked = git(root, "ls-files", "-z").split("\0")
    files = [p for p in tracked if p and not set(PurePosixPath(p).parts) & SKIP and not PurePosixPath(p).name.startswith(".env")][:20000]
    groups = defaultdict(list)
    for path in files:
        groups[module_for(path)].append(path)
    nodes = sorted(groups, key=lambda k: (-len(groups[k]), k))[:14]
    manifests, dependencies = [], set()
    for path in [p for p in files if PurePosixPath(p).name == "package.json"][:12]:
        try:
            data = json.loads(safe_read(root, path))
            names = sorted(set(data.get("dependencies", {})) | set(data.get("devDependencies", {})))
            manifests.append({"path": path, "name": data.get("name", ""), "dependencies": names[:80]})
            dependencies.update(names)
        except (ValueError, OSError):
            pass
    languages = Counter(PurePosixPath(p).suffix.lstrip(".") for p in files if PurePosixPath(p).suffix in SOURCE)
    known = set(files)
    links = defaultdict(list)
    checked = 0
    for path in [p for p in files if PurePosixPath(p).suffix in SOURCE][:500]:
        try:
            text = safe_read(root, path)
        except OSError:
            continue
        checked += 1
        for spec in re.findall(r'''(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s*)["']([^"']+)["']''', text):
            if not spec.startswith((".", "@/")):
                continue
            candidate = (root / "src" / spec[2:]) if spec.startswith("@/") else (root / PurePosixPath(path).parent / spec)
            candidate = candidate.resolve()
            if root not in candidate.parents:
                continue
            rel = candidate.relative_to(root).as_posix()
            target = next((p for p in [rel, *[rel + ext for ext in (".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx", "/index.js")]] if p in known), None)
            if target:
                a, b = module_for(path), module_for(target)
                if a != b and a in nodes and b in nodes:
                    links[(a, b)].append({"from": path, "to": target})
    frameworks = [name for name in ("next", "react", "vue", "svelte", "express", "fastify", "three", "@tauri-apps/api", "electron") if name in dependencies]
    return {"nodes": [{"id": n, "label": n, "files": len(groups[n]), "examples": groups[n][:15]} for n in nodes],
            "edges": [{"from": a, "to": b, "count": len(evidence), "evidence": evidence[:5]} for (a, b), evidence in sorted(links.items())],
            "frameworks": frameworks, "languages": dict(languages), "manifests": manifests,
            "trackedFiles": len(files), "scannedSources": checked, "omittedModules": max(0, len(groups) - len(nodes)),
            "basis": "Tracked folders and resolved JS/TS imports. Runtime calls, deployment topology and dynamic imports may not be represented. Up to 500 source files inspected; @/ resolves only to src/."}

def timeline(folder, repo):
    # All local refs, deduplicated by Git. One chapter per month across the history.
    rows = git(folder, "log", "--all", "--max-count=20001", "--format=%H%x09%cI%x09%s").splitlines()
    truncated = len(rows) > 20000
    chapters = defaultdict(list)
    for row in rows[:20000]:
        parts = row.split("\t", 2)
        if len(parts) != 3:
            continue
        sha, at, subject = parts
        chapters[at[:7]].append({"sha": sha, "at": at, "subject": subject[:240]})
    releases = []
    for row in git(folder, "for-each-ref", "--sort=-creatordate", "--format=%(refname:short)%09%(creatordate:iso-strict)", "refs/tags").splitlines()[:300]:
        name, _, at = row.partition("\t")
        releases.append({"name": name, "at": at})
    return {"chapters": [{"month": month, "count": len(commits), "highlights": commits[:8],
                          "themes": [t for t, _ in Counter((c["subject"].split(":", 1)[0].split("(")[0].lower() if ":" in c["subject"] else "other") for c in commits).most_common(4)]}
                         for month, commits in sorted(chapters.items(), reverse=True)],
            "commits": min(len(rows), 20000), "truncated": truncated, "tags": releases,
            "createdAt": repo.get("createdAt"), "basis": "Local Git history across all refs, grouped by month. Highlights are commit subjects, not verified business outcomes. Tags are local tags; remote-only history requires a fetch."}

def inspect(doc, overlay, rid):
    repo = next((r for r in doc["repos"] if r["id"] == rid), None)
    if not repo:
        raise ValueError("Choose an indexed project.")
    sites = sorted(repo.get("sites", []), key=lambda s: s.get("role") != "canonical")
    folder = next((p for s in sites if (p := local.site_path(overlay, s)) and p.is_dir()), None) if overlay else None
    if not folder:
        return {"available": False, "reason": "Clone this project on the selected machine to inspect its architecture and Git timeline.", "repo": rid}
    return {"available": True, "repo": rid, "observedAt": datetime.now(timezone.utc).isoformat(),
            "architecture": architecture(folder), "timeline": timeline(folder, repo)}
