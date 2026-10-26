"""This machine's git checkouts: where they are, what they point at, and what state they are in.

Strictly read-only. Git runs with --no-optional-locks, so a scan never takes the index lock or rewrites the index,
even while another session is working in the same checkout.
"""
import os
import re
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

from . import apps, config, logos

# Never descended into: dependency caches, build output, operating-system and game-library folders.
SKIP = {
    "node_modules", ".git", ".hg", ".svn", ".next", ".nuxt", ".vite", ".vinext", ".turbo", ".cache", ".parcel-cache",
    "__pycache__", ".venv", "venv", "env", ".tox", "target", "bin", "obj", "dist", "build", "out", "coverage",
    "Library", "Temp", "tmp", "$RECYCLE.BIN", "System Volume Information", "Windows", "Program Files",
    "Program Files (x86)", "ProgramData", "AppData", "WindowsApps", "WpSystem", "SteamLibrary", "XBoxGames",
    "BattlenetGames", "npm-cache", "nuget-packages", ".gradle", "Pods", "DerivedData", "site-packages",
    ".pnpm-store", ".yarn", "vendor", "artifacts",
}
# Hidden folders are skipped except these, which can hold git worktrees.
HIDDEN_OK = {".claude", "worktrees"}

GITHUB = re.compile(r"(?:https?://|ssh://)?(?:[^@/]+@)?(?P<host>[^/:]+)[:/](?P<owner>[^/]+)/(?P<name>[^/]+?)(?:\.git)?/?$")


def parse_remote(url):
    """{'host','owner','name','slug'} for a hosted remote, {'local': path} for a folder, None for nothing."""
    if not url:
        return None
    u = url.strip()
    if re.match(r"^[A-Za-z]:[\\/]", u) or u.startswith(("/", "\\", "file://", "./", "../")):
        return {"local": u[7:] if u.startswith("file://") else u}
    m = GITHUB.match(u)
    if not m:
        return {"local": u}
    host, owner, name = m.group("host").lower(), m.group("owner"), m.group("name")
    return {"host": host, "owner": owner, "name": name, "slug": f"{owner}/{name}".lower()}


def _read(path):
    try:
        return Path(path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def git_layout(folder):
    """How a folder's .git is laid out: a full clone, a worktree, or a submodule, and where its config lives."""
    dotgit = Path(folder) / ".git"
    if dotgit.is_dir():
        return {"kind": "clone", "config": dotgit / "config", "gitdir": dotgit}
    m = re.search(r"gitdir:\s*(.+)", _read(dotgit))
    if not m:
        return None
    gitdir = Path(m.group(1).strip())
    if not gitdir.is_absolute():
        gitdir = (Path(folder) / gitdir).resolve()
    common = gitdir
    cd = _read(gitdir / "commondir").strip()
    if cd:
        common = (gitdir / cd).resolve()
    kind = "worktree" if "worktrees" in gitdir.parts else "submodule"
    return {"kind": kind, "config": common / "config", "gitdir": gitdir}


def remotes_of(config_path):
    """{remote name: url} for every remote in a git config."""
    out = {}
    for m in re.finditer(r'\[remote "([^"]+)"\]([^\[]*)', _read(config_path)):
        u = re.search(r"^\s*url\s*=\s*(.+?)\s*$", m.group(2), re.M)
        if u:
            out[m.group(1)] = u.group(1)
    return out


def choose_remote(remotes, upstream, owners):
    """The remote a checkout really works against: the one its branch tracks if you own it, else a remote you own,
    else origin. A fork cloned from upstream with your fork as a second remote is yours, not vendor code."""
    parsed = {n: parse_remote(u) for n, u in remotes.items()}
    owned = [n for n, r in parsed.items() if r and r.get("owner", "").lower() in owners]
    track = upstream.split("/", 1)[0] if upstream else None
    for name in (track if track in owned else None, "origin" if "origin" in owned else None, *owned, "origin", track):
        if name and parsed.get(name):
            return name, parsed[name]
    return (next(iter(parsed)), next(iter(parsed.values()))) if parsed else (None, None)


def _reparse(entry):
    """Windows junctions and symlinked folders: skipped, so a walk can never loop or leave its root."""
    try:
        return bool(getattr(entry.stat(follow_symlinks=False), "st_file_attributes", 0) & 0x400)
    except OSError:
        return True


def walk(roots, max_depth=5):
    """Every folder under the roots that has a .git, as (root id, absolute path)."""
    found = []
    for rid, base in roots.items():
        base = Path(base)
        if not base.is_dir():
            continue
        stack = [(base, 0)]
        while stack:
            folder, depth = stack.pop()
            try:
                entries = list(os.scandir(folder))
            except OSError:
                continue
            names = {e.name for e in entries}
            if ".git" in names:
                found.append((rid, folder))
            if depth >= max_depth:
                continue
            for e in entries:
                if not e.is_dir(follow_symlinks=False) or _reparse(e):
                    continue
                n = e.name
                if n in SKIP or (n.startswith(".") and n not in HIDDEN_OK) or n.startswith("$"):
                    continue
                stack.append((Path(e.path), depth + 1))
    # A path reachable from two roots (a root inside another) is kept once, under the deepest root.
    best = {}
    for rid, p in found:
        key = os.path.normcase(str(p))
        if key not in best or len(str(roots[rid])) > len(str(roots[best[key][0]])):
            best[key] = (rid, p)
    return sorted(best.values(), key=lambda x: str(x[1]).lower())


def _git(folder, *args, timeout=30):
    try:
        r = subprocess.run(["git", "--no-optional-locks", "-C", str(folder), *args], capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=timeout,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return r.stdout if r.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired):
        return None


# Ignored folders that are only ever rebuilt output; anything else git ignores may be someone's work.
DISPOSABLE = {"node_modules", "dist", "build", "out", ".next", ".nuxt", ".vite", ".vinext", ".turbo", ".cache", "bin", "obj",
              "__pycache__", ".venv", "venv", ".pytest_cache", ".mypy_cache", "coverage", "target", ".parcel-cache", ".svelte-kit",
              ".gradle", ".dart_tool", "Pods", "DerivedData", ".angular", ".expo", ".DS_Store", "Thumbs.db",
              "tsconfig.tsbuildinfo", "next-env.d.ts", ".wrangler", ".eslintcache", ".ruff_cache", ".tox", "playwright-report",
              "test-results", ".terraform", "storybook-static"}


def spare_check(folder):
    """For an extra folder (worktree, copy, release): is anything here found nowhere else?
    Commits: HEAD must be on some remote branch (as of the last fetch). Files: nothing uncommitted, and nothing git
    ignores beyond rebuilt output (an ignored artifacts/ folder can hold the only copy of real work)."""
    contained = _git(folder, "branch", "-r", "--contains", "HEAD", "--format=%(refname:short)")
    st = _git(folder, "status", "--porcelain", "--ignored=matching", "--untracked-files=normal")
    if contained is None or st is None:
        return None
    ignored, untracked = [], 0
    for line in st.splitlines():
        if line.startswith("!! "):
            name = line[3:].strip().strip('"').rstrip("/")
            parts = name.split("/")
            if not any(p in DISPOSABLE for p in parts) and not name.endswith((".log", ".tmp", ".pyc", ".tsbuildinfo")):
                ignored.append(line[3:].strip().strip('"'))
        elif line.startswith("?? "):
            untracked += 1
    on = contained.strip().splitlines()
    return {"commitsElsewhere": bool(on), "onRemote": on[0] if on else None, "ignored": ignored[:6],
            "ignoredMore": max(0, len(ignored) - 6), "untracked": untracked}


def on_remote(folder):
    """The first remote branch that already holds HEAD (as of the last fetch), or None."""
    out = _git(folder, "branch", "-r", "--contains", "HEAD", "--format=%(refname:short)")
    lines = (out or "").strip().splitlines()
    return lines[0] if lines else None


def pull_check(folder, oid):
    """Does this checkout already have the commit GitHub reports at the tip of its branch? Answered without fetching:
    a commit missing here, or not in HEAD's history, means a pull is needed. Both commands only read."""
    if _git(folder, "cat-file", "-e", f"{oid}^{{commit}}") is None:
        return True
    return _git(folder, "merge-base", "--is-ancestor", oid, "HEAD") is None


def run_hints(folder):
    """How to start it: the project's own .claude/launch.json entries, else its package.json dev or start script."""
    import json
    hints = []
    try:
        cfg = json.loads((Path(folder) / ".claude" / "launch.json").read_text(encoding="utf-8"))
        for c in cfg.get("configurations", [])[:4]:
            cmd = " ".join([str(c.get("runtimeExecutable") or ""), *map(str, c.get("runtimeArgs") or [])]).strip()
            if cmd:
                hints.append({"name": str(c.get("name") or "dev")[:40], "cmd": cmd[:160], "port": c.get("port")})
    except (OSError, ValueError, AttributeError):
        pass
    if not hints:
        try:
            scripts = json.loads((Path(folder) / "package.json").read_text(encoding="utf-8")).get("scripts") or {}
            for key, cmd in (("dev", "npm run dev"), ("start", "npm start")):
                if key in scripts:
                    hints.append({"name": key, "cmd": cmd, "port": None})
                    break
        except (OSError, ValueError, AttributeError):
            pass
    return hints


def commit_count(folder):
    """How many commits HEAD has: how much work went into the project. None when git cannot say."""
    out = _git(folder, "rev-list", "--count", "HEAD")
    return int(out.strip()) if out and out.strip().isdigit() else None


def recent_commits(folder, n=5):
    """The last few commits: what you were doing there, in your own words."""
    out = _git(folder, "log", f"-{n}", "--format=%h%x1f%cI%x1f%s")
    commits = []
    for line in (out or "").splitlines():
        parts = line.split("")
        if len(parts) == 3:
            commits.append({"sha": parts[0], "at": parts[1], "subject": parts[2][:140]})
    return commits


def git_facts(folder, prev=None):
    """Branch, ahead/behind, uncommitted count and last commit. None for a fact git could not give in time.
    One `git status` always runs (it is the only way to see new edits); the last commit's date is reused from the
    previous scan when HEAD has not moved, which saves a git call per folder."""
    facts = {"branch": None, "head": None, "ahead": None, "behind": None, "dirty": None, "lastCommit": None,
             "upstream": None, "dirtyFiles": [], "oid": None}
    st = _git(folder, "status", "--porcelain=v2", "--branch")
    if st is not None:
        dirty = 0
        for line in st.splitlines():
            if line.startswith("# branch.oid "):
                oid = line[13:].strip()
                facts["oid"] = None if oid == "(initial)" else oid
            elif line.startswith("# branch.head "):
                h = line[14:].strip()
                facts["branch"] = None if h == "(detached)" else h
            elif line.startswith("# branch.upstream "):
                facts["upstream"] = line[18:].strip()
            elif line.startswith("# branch.ab "):
                m = re.match(r"# branch\.ab \+(\d+) -(\d+)", line)
                if m:
                    facts["ahead"], facts["behind"] = int(m.group(1)), int(m.group(2))
            elif line and not line.startswith("#"):
                dirty += 1
                if len(facts["dirtyFiles"]) < 5:  # the first few names, so a list can say which files
                    kind = line[0]
                    path = line[2:] if kind in "?!" else line.split(" ", {"1": 8, "2": 9, "u": 10}.get(kind, 8))[-1].split("\t")[0]
                    facts["dirtyFiles"].append({"path": path, "state": "new" if kind == "?" else "conflict" if kind == "u" else "changed"})
        facts["dirty"] = dirty
    if prev and facts["oid"] and prev.get("oid") == facts["oid"] and prev.get("lastCommit"):
        facts["head"], facts["lastCommit"] = prev.get("head"), prev["lastCommit"]
        return facts
    log = _git(folder, "log", "-1", "--format=%h|%cI")
    if log and "|" in log:
        facts["head"], facts["lastCommit"] = log.strip().split("|", 1)
    return facts


def refs_stamp(layout):
    """When this repo last fetched or moved a remote ref: changes whenever "which remote branches hold HEAD" could.
    Looks at the shared FETCH_HEAD and packed-refs, the worktree's own FETCH_HEAD, and every loose remote ref."""
    common, own = Path(layout["config"]).parent, Path(layout.get("gitdir") or Path(layout["config"]).parent)
    stamp = []
    for p in (common / "FETCH_HEAD", own / "FETCH_HEAD", common / "packed-refs"):
        try:
            stamp.append(p.stat().st_mtime_ns)
        except OSError:
            stamp.append(0)
    newest = 0
    for dirpath, _dirs, files in os.walk(common / "refs" / "remotes"):
        for f in files:
            try:
                newest = max(newest, os.stat(os.path.join(dirpath, f)).st_mtime_ns)
            except OSError:
                pass
    return stamp + [newest]


CHECKPOINT_KEYS = {"stage", "next", "next step", "proof", "blockers", "blocked", "who it's for", "for", "why it matters",
                   "why"}


def checkpoint(folder):
    """A product-library style .claude/session-state.md, if the project keeps one."""
    f = Path(folder) / ".claude" / "session-state.md"
    text = _read(f)
    if not text:
        return None
    fields = {}
    for line in text.splitlines()[:80]:
        m = re.match(r"^\s*[-*]?\s*\**([A-Za-z' ]{2,20})\**\s*:\s*(.+?)\s*$", line)
        if m and m.group(1).strip().lower() in CHECKPOINT_KEYS:
            fields.setdefault(m.group(1).strip().lower(), m.group(2)[:240])
    mtime = datetime.fromtimestamp(f.stat().st_mtime, timezone.utc).isoformat(timespec="seconds")
    return {"updatedAt": mtime, "fields": fields}


def readme_summary(folder):
    """The first real paragraph of the README: no headings, badges, or HTML."""
    for name in ("README.md", "readme.md", "README.MD", "Readme.md", "README"):
        text = _read(Path(folder) / name)
        if not text:
            continue
        para = []
        for line in text.splitlines():
            s = line.strip()
            if not s:
                if para:
                    break
                continue
            if s.startswith(("#", "!", "<", "[!", "```", "|", ">", "---", "===")) or re.match(r"^\[!\[", s):
                if para:
                    break
                continue
            para.append(s)
        out = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", " ".join(para))
        out = re.sub(r"[*_`]", "", out).strip()
        if out:
            return out[:280]
    return None


def classify(sites, owners, cfg):
    """Give every site a role. Exactly one clone per repo is canonical: the place you are meant to work."""
    release = [r.lower() for r in cfg.get("release", [])]
    canonical_roots = cfg.get("canonical", [])
    by_slug = {}
    for s in sites:
        remote = s["remote"]
        if remote is None:
            s["role"] = "orphan"
        elif "local" in remote:
            s["role"] = "derived"
        elif s["layout"] == "worktree":
            s["role"] = "worktree"
        elif s["layout"] == "submodule":
            s["role"] = "submodule"
        elif owners and remote["owner"].lower() not in owners:  # with no known owner, nothing is someone else's
            s["role"] = "vendor"
        else:
            s["role"] = "clone"
            by_slug.setdefault(remote["slug"], []).append(s)
    for group in by_slug.values():
        def rank(s):
            return (s["root"] not in canonical_roots, any(r in s["rel"].lower() for r in release), s["rel"].count("/"),
                    len(s["rel"]))
        group.sort(key=rank)
        group[0]["role"] = "canonical"
        for s in group[1:]:
            s["role"] = "release" if any(r in s["rel"].lower() for r in release) else "copy"
    return sites


def scan(cfg, owners, progress=None, heads=None, previous=None):
    """Walk this machine's roots and describe every checkout. Returns the overlay document."""
    t0 = time.time()
    roots = cfg["roots"]
    found = walk(roots, cfg.get("maxDepth", 5))
    if progress:
        progress(f"found {len(found)} git folders")
    owners = {o.lower() for o in owners if o}
    sites = []
    for rid, folder in found:
        layout = git_layout(folder)
        if not layout:
            continue
        rel = Path(folder).relative_to(roots[rid]).as_posix()
        sites.append({"root": rid, "rel": "" if rel == "." else rel, "layout": layout["kind"],
                      "_remotes": remotes_of(layout["config"]), "_path": folder, "refs": refs_stamp(layout)})
    inferred = None
    if not owners:
        # No GitHub sign-in: the owner behind most of this machine's remotes is almost certainly the person.
        from collections import Counter
        seen = Counter(r["owner"].lower() for s in sites for r in map(parse_remote, s["_remotes"].values()) if r and "owner" in r)
        if seen:
            top, n = seen.most_common(1)[0]
            if n >= max(3, 0.4 * sum(seen.values())):
                inferred, owners = top, {top}
    # The previous scan's answers stay good for anything that only depends on HEAD (and on the refs, for "is it on a
    # remote"): reusing them skips most git calls when little has changed.
    before = {(s["root"], s["rel"]): s for s in (previous or {}).get("sites", [])}
    same = lambda s, p: bool(p) and p.get("oid") == s.get("oid") and p.get("branch") == s.get("branch")  # noqa: E731
    with ThreadPoolExecutor(max_workers=8) as pool:
        facts = list(pool.map(lambda s: git_facts(s["_path"], before.get((s["root"], s["rel"]))), sites))
    for s, f in zip(sites, facts):
        s.update(f)
        name, remote = choose_remote(s["_remotes"], f.get("upstream"), owners)
        s["remote"], s["remoteName"], s["remotes"] = remote, name, sorted(s.pop("_remotes"))
    classify(sites, owners, cfg)
    extras = [s for s in sites if s["role"] in ("worktree", "copy", "release", "derived")]
    with ThreadPoolExecutor(max_workers=8) as pool:
        for s, verdict in zip(extras, pool.map(lambda s: spare_check(s["_path"]), extras)):
            s["spare"] = verdict
        ahead = [s for s in sites if s not in extras and (s.get("ahead") or 0) > 0]
        fresh = []
        for s in ahead:
            p = before.get((s["root"], s["rel"]))
            if same(s, p) and p.get("refs") == s.get("refs") and "aheadOnRemote" in p:
                s["aheadOnRemote"] = p["aheadOnRemote"]
            else:
                fresh.append(s)
        for s, branch in zip(fresh, pool.map(lambda s: on_remote(s["_path"]), fresh)):
            s["aheadOnRemote"] = branch
        # Needs a pull: the main folder sits on the default branch and GitHub's tip of it is not in its history.
        heads = heads or {}
        checks = []
        for s in sites:
            head = heads.get((s.get("remote") or {}).get("slug", ""))
            if s["role"] == "canonical" and head and head[1] and s.get("branch") == head[0]:
                p = before.get((s["root"], s["rel"]))
                if same(s, p) and (p.get("pull") or {}).get("github") == head[1][:7]:
                    s["pull"] = p["pull"]
                else:
                    checks.append((s, head))
        for (s, head), needed in zip(checks, pool.map(lambda c: pull_check(c[0]["_path"], c[1][1]), checks)):
            s["pull"] = {"needed": needed, "branch": head[0], "github": head[1][:7]}
    for s in sites:
        if s["role"] in config.MAIN_ROLES:
            s["checkpoint"] = checkpoint(s["_path"])
            s["readme"] = readme_summary(s["_path"])
            p = before.get((s["root"], s["rel"]))
            s["commits"] = p["commits"] if same(s, p) and p.get("commits") is not None else recent_commits(s["_path"])
            s["commitCount"] = p["commitCount"] if same(s, p) and p.get("commitCount") is not None else commit_count(s["_path"])
            s["run"] = run_hints(s["_path"])
        if s["role"] in config.MAIN_ROLES:
            s["apps"] = apps.detect(s["_path"])
            s["logo"] = logos.find(s["_path"], [a["dir"] for a in s["apps"]])
    logos.drop_stock(sites)
    for s in sites:
        s.pop("_path", None)
    ident = config.machine_identity()
    doc = {"schema": 1, "machine": {**ident, "label": cfg["label"]},
           "scannedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
           "seconds": round(time.time() - t0, 1), "roots": roots, "sites": sites, "inferredOwner": inferred}
    return doc


def site_path(overlay, site):
    """The absolute folder for a site, resolved through this machine's roots. Never taken from a client."""
    base = overlay["roots"].get(site["root"])
    if not base:
        return None
    return Path(base) / site["rel"] if site["rel"] else Path(base)
