"""Pull and push, only when you press the button. The one place Hangar writes to a repo.

Pull is fetch + `merge --ff-only`: it moves a branch forward to what its remote branch has and nothing else, so it never
makes a merge commit, never rebases, and git itself refuses when your uncommitted changes would be overwritten.
Push is a plain push of the current branch to the remote branch it tracks: never forced, never a new branch.
Anything that needs a decision (diverged history, no remote branch, a detached checkout) is skipped and explained.
"""
import os
import subprocess
from concurrent.futures import ThreadPoolExecutor

from . import local

# Never wait on a password prompt: a pull or push that needs one fails and says so.
ENV = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "never"}


def _git(folder, *args, timeout=120):
    try:
        r = subprocess.run(["git", "-C", str(folder), *args], capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=timeout, env=ENV, stdin=subprocess.DEVNULL,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return r.returncode, (r.stdout + "\n" + r.stderr).strip()
    except subprocess.TimeoutExpired:
        return 124, "Timed out talking to the remote."
    except OSError as e:
        return 1, str(e)


def _out(folder, *args):
    code, text = _git(folder, *args, timeout=30)
    return text.strip() if code == 0 else None


def _tracking(folder):
    """(branch, remote, remote branch ref) for the checked-out branch; None parts when there is no such thing."""
    branch = _out(folder, "symbolic-ref", "--quiet", "--short", "HEAD")
    if not branch:
        return None, None, None
    return branch, _out(folder, "config", f"branch.{branch}.remote"), _out(folder, "config", f"branch.{branch}.merge")


def _first_line(text, *needles):
    for line in text.splitlines():
        if any(n in line for n in needles):
            return line.strip()
    return text.strip().splitlines()[-1] if text.strip() else ""


def pull(folder):
    branch, remote, merge = _tracking(folder)
    if not branch:
        return {"status": "skipped", "message": "Not on a branch (detached checkout): nothing to move forward."}
    if not remote or not merge:
        return {"status": "skipped", "message": f"{branch} tracks no remote branch."}
    before = _out(folder, "rev-parse", "HEAD")
    code, text = _git(folder, "fetch", "--quiet", remote)
    if code:
        return {"status": "failed", "message": "Could not fetch: " + _first_line(text, "fatal", "error")}
    code, text = _git(folder, "merge", "--ff-only", "--quiet", "@{u}")
    if code:
        if "overwritten" in text:
            files = [ln.strip() for ln in text.splitlines() if ln.startswith(("\t", "    "))][:3]
            return {"status": "blocked", "message": "Your uncommitted changes touch files GitHub also changed"
                    + (f" ({', '.join(files)})" if files else "") + ": commit or put them aside first. Nothing was changed."}
        if "fast-forward" in text.lower() or "not possible" in text.lower():
            return {"status": "diverged", "message": f"{branch} has its own commits as well as GitHub's: it needs a merge or rebase, which Hangar leaves to you."}
        return {"status": "failed", "message": _first_line(text, "fatal", "error")}
    after = _out(folder, "rev-parse", "HEAD")
    n = int(_out(folder, "rev-list", "--count", f"{before}..{after}") or 0) if before and after and before != after else 0
    if not n:
        return {"status": "current", "message": f"{branch} was already up to date."}
    return {"status": "done", "commits": n, "message": f"{branch} moved forward {n} commit{'s' * (n != 1)}."}


def push(folder):
    branch, remote, merge = _tracking(folder)
    if not branch:
        return {"status": "skipped", "message": "Not on a branch (detached checkout): nothing to push."}
    if not remote or not merge:
        return {"status": "skipped", "message": f"{branch} has no remote branch yet. The first push is yours: git push -u origin {branch}"}
    if merge != f"refs/heads/{branch}":
        return {"status": "skipped", "message": f"{branch} tracks a branch with another name ({merge.rsplit('/', 1)[-1]}): push it yourself so it lands where you mean."}
    ahead = int(_out(folder, "rev-list", "--count", "@{u}..HEAD") or 0)
    if not ahead:
        return {"status": "current", "message": f"Nothing to push on {branch}."}
    # A plain push: git's own rules decide where (push.default, pushRemote), exactly as in your terminal.
    code, text = _git(folder, "push", "--porcelain")
    if code:
        if "non-fast-forward" in text or "fetch first" in text or "rejected" in text:
            return {"status": "rejected", "message": f"GitHub has commits on {branch} that this folder doesn't: pull first. Nothing was pushed."}
        return {"status": "failed", "message": _first_line(text, "error", "fatal", "remote:")}
    return {"status": "done", "commits": ahead, "message": f"Pushed {ahead} commit{'s' * (ahead != 1)} on {branch}."}


def targets(repo, action):
    """Which of a repo's folders an action applies to, decided from the scan, never by the caller."""
    out = []
    for i, s in enumerate(repo.get("sites") or []):
        if action == "pull" and (s.get("pull") or {}).get("needed"):
            out.append(i)
        elif action == "push" and (s.get("ahead") or 0) > 0 and not s.get("aheadOnRemote") \
                and not (s.get("spare") or {}).get("commitsElsewhere"):
            out.append(i)
    return out


def run(doc, overlay, action, repo_ids, all_main=False, busy_repos=()):
    """Pull or push each repo's target folders, four at a time. One result per folder."""
    fn = {"pull": pull, "push": push}[action]
    jobs = []
    for rid in repo_ids:
        repo = next((r for r in doc["repos"] if r["id"] == rid), None)
        if not repo:
            continue
        idx = targets(repo, action)
        if all_main and action == "pull":
            main = next((i for i, s in enumerate(repo.get("sites", [])) if s.get("role") == "canonical"), None)
            idx = [main] if main is not None else []
            if not idx:
                jobs.append((repo, None, None))
        if not idx and action == "push" and repo.get("kind") == "orphan":
            jobs.append((repo, None, None))
        for i in idx:
            s = repo["sites"][i]
            jobs.append((repo, s, local.site_path(overlay, s) if overlay else None))

    def one(job):
        repo, s, folder = job
        base = {"repo": repo["id"], "name": repo["name"], "where": f"{s['root']}:{s['rel'] or '(root)'}" if s else ""}
        if s is None:
            if action == "pull":
                return {**base, "status": "skipped", "message": "No main checkout on this machine."}
            return {**base, "status": "skipped", "message": "No GitHub repo to push to yet: create one first (gh repo create)."}
        if not folder or not folder.is_dir():
            return {**base, "status": "failed", "message": "That folder is not on this machine any more."}
        if all_main and repo["id"] in busy_repos:
            return {**base, "status": "skipped", "message": "A Hangar coding job is active or unobserved in this checkout."}
        if all_main:
            dirty = _out(folder, "status", "--porcelain")
            if dirty is None or dirty:
                return {**base, "status": "skipped", "message": "Checkout has local changes or could not be inspected. Commit or review them first."}
        return {**base, **fn(folder)}
    with ThreadPoolExecutor(max_workers=4) as pool:
        return list(pool.map(one, jobs))
