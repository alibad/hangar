"""Exactly what is waiting on one repo, read live when you ask: changed files, commits not pushed, commits to pull,
open pull requests. The map's counts come from the last scan; this answers "which ones?" right now."""
import json

from . import github as gh_api
from . import local

STATES = {"?": "new", "M": "changed", "A": "added", "D": "deleted", "R": "renamed", "C": "copied", "U": "conflict", "T": "changed"}
LOG = "--format=%h%x09%s%x09%cI%x09%an"


def _commits(text):
    out = []
    for line in (text or "").splitlines():
        sha, subject, at, author = (line.split("\t") + ["", "", ""])[:4]
        out.append({"sha": sha, "subject": subject, "at": at, "author": author})
    return out


def files(folder, limit=40):
    """Uncommitted files in a folder: path and what happened to it."""
    text = local._git(folder, "status", "--porcelain=v1", "--untracked-files=normal") or ""
    items = []
    for line in text.splitlines():
        if len(line) < 4:
            continue
        xy, path = line[:2], line[3:]
        code = "U" if "U" in xy else (xy[0] if xy[0] not in " ?" else xy[1]) if xy != "??" else "?"
        items.append({"path": path.split(" -> ")[-1].strip('"'), "state": STATES.get(code, "changed")})
    return {"items": items[:limit], "more": max(0, len(items) - limit), "total": len(items)}


def unpushed(folder, limit=20):
    """Commits on no remote branch (as of the last fetch). A folder with no remote at all says so instead."""
    if not (local._git(folder, "remote") or "").strip():
        return {"noRemote": True, "commits": []}
    text = local._git(folder, "log", LOG, "HEAD", "--not", "--remotes", "-n", str(limit + 1)) or ""
    commits = _commits(text)
    return {"noRemote": False, "commits": commits[:limit], "more": len(commits) > limit}


def incoming(folder, full_name, branch, tip, limit=20):
    """Commits on GitHub's default branch that this folder does not have yet, newest first."""
    if tip and local._git(folder, "cat-file", "-e", f"{tip}^{{commit}}") is not None:
        commits = _commits(local._git(folder, "log", LOG, f"HEAD..{tip}", "-n", str(limit + 1)))
        return {"branch": branch, "commits": commits[:limit], "more": len(commits) > limit, "fetched": True}
    try:
        page = json.loads(gh_api._gh("api", f"repos/{full_name}/commits?sha={branch}&per_page={limit + 10}", timeout=20, tries=1) or "[]")
    except (gh_api.GitHubError, OSError, ValueError):
        return {"branch": branch, "commits": [], "more": False, "unknown": True}
    commits = []
    for c in page:
        if local._git(folder, "cat-file", "-e", f"{c['sha']}^{{commit}}") is not None:
            break
        info = c.get("commit") or {}
        commits.append({"sha": c["sha"][:7], "subject": (info.get("message") or "").splitlines()[0][:200],
                        "at": (info.get("committer") or {}).get("date", ""),
                        "author": (c.get("author") or {}).get("login") or (info.get("author") or {}).get("name", "")})
    else:
        return {"branch": branch, "commits": commits[:limit], "more": len(commits) >= limit, "fetched": False}
    return {"branch": branch, "commits": commits[:limit], "more": len(commits) > limit, "fetched": False}


def pull_requests(full_name, limit=20):
    try:
        text = gh_api._gh("pr", "list", "-R", full_name, "--state", "open", "--limit", str(limit),
                          "--json", "number,title,url,isDraft,author,updatedAt,reviewDecision", timeout=20, tries=1)
        return [{"number": p["number"], "title": p["title"], "url": p["url"], "draft": p.get("isDraft", False),
                 "author": (p.get("author") or {}).get("login", ""), "updatedAt": p.get("updatedAt", ""),
                 "review": p.get("reviewDecision") or ""} for p in json.loads(text or "[]")]
    except (gh_api.GitHubError, OSError, ValueError):
        return None


def live(repo, overlay):
    """Everything waiting on a repo, for its main folder and any other folder with uncommitted work."""
    out = {"folders": [], "incoming": None, "prs": None}
    for i, s in enumerate(repo.get("sites") or []):
        if not (s.get("dirty") or s.get("role") == "canonical"):
            continue
        folder = local.site_path(overlay, s) if overlay else None
        if not folder or not folder.is_dir():
            continue
        entry = {"site": i, "where": f"{s['root']}:{s['rel'] or '(root)'}", "path": str(folder), "role": s.get("role"),
                 "branch": (local._git(folder, "rev-parse", "--abbrev-ref", "HEAD") or "").strip() or s.get("branch"),
                 "files": files(folder), "unpushed": unpushed(folder)}
        out["folders"].append(entry)
        pull = s.get("pull") or {}
        if pull.get("needed") and repo.get("fullName") and out["incoming"] is None:
            out["incoming"] = {"site": i, **incoming(folder, repo["fullName"], pull.get("branch"), pull.get("github"))}
    if repo.get("openPRs") and repo.get("fullName"):
        out["prs"] = pull_requests(repo["fullName"])
    return out
