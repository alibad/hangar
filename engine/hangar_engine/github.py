"""GitHub facts through the gh CLI you are already signed in to. Read-only."""
import json
import re
import shutil
import subprocess
import time
from datetime import datetime, timezone

from . import config

FIELDS = ("id,name,nameWithOwner,owner,description,homepageUrl,isPrivate,isFork,isArchived,isEmpty,isTemplate,"
          "createdAt,pushedAt,diskUsage,stargazerCount,url,defaultBranchRef,primaryLanguage,repositoryTopics,parent")
# Open pull requests and issues come from a separate, lighter query: asked together with everything above for
# hundreds of repos, GitHub's GraphQL endpoint answers 502.
COUNTS = """query($owner: String!, $endCursor: String) { repositoryOwner(login: $owner) {
  repositories(first: 50, after: $endCursor, ownerAffiliations: OWNER) { pageInfo { hasNextPage endCursor }
    nodes { nameWithOwner pullRequests(states: OPEN) { totalCount } issues(states: OPEN) { totalCount }
      defaultBranchRef { name target { oid } } } } } }"""
CACHE_FILE = config.CACHE / "github.json"


class GitHubError(RuntimeError):
    pass


def _gh(*args, timeout=300, tries=3):
    """Run gh; retry GitHub's transient 5xx answers with a short backoff."""
    if not shutil.which("gh"):
        raise GitHubError("The GitHub CLI (gh) is not installed. Install it and run `gh auth login`.")
    for attempt in range(tries):
        try:
            r = subprocess.run(["gh", *args], capture_output=True, text=True, encoding="utf-8", errors="replace",
                               timeout=timeout, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        except subprocess.TimeoutExpired:
            raise GitHubError(f"GitHub did not answer within {timeout} s.") from None
        if r.returncode == 0:
            return r.stdout
        err = (r.stderr or r.stdout).strip() or f"gh {' '.join(args)} failed"
        if not re.search(r"HTTP 5\d\d|timed out|timeout", err, re.I) or attempt == tries - 1:
            raise GitHubError(err)
        time.sleep(2 * (attempt + 1))


def login():
    return _gh("api", "user", "--jq", ".login").strip()


def orgs():
    out = _gh("api", "user/orgs", "--jq", ".[].login")
    return [o for o in out.split() if o]


def normalize(r):
    lang = (r.get("primaryLanguage") or {}).get("name")
    parent = r.get("parent") or None
    return {
        "id": r["id"],
        "name": r["name"],
        "owner": (r.get("owner") or {}).get("login") or r["nameWithOwner"].split("/")[0],
        "fullName": r["nameWithOwner"],
        "url": r.get("url"),
        "description": r.get("description") or "",
        "homepage": r.get("homepageUrl") or "",
        "private": bool(r.get("isPrivate")),
        "fork": bool(r.get("isFork")),
        "archived": bool(r.get("isArchived")),
        "empty": bool(r.get("isEmpty")),
        "template": bool(r.get("isTemplate")),
        "language": lang,
        "topics": [t.get("name") for t in (r.get("repositoryTopics") or []) if t.get("name")],
        "createdAt": r.get("createdAt"),
        "pushedAt": r.get("pushedAt"),
        "sizeKB": int(r.get("diskUsage") or 0),
        "stars": int(r.get("stargazerCount") or 0),
        "openPRs": None,
        "openIssues": None,
        "defaultBranch": (r.get("defaultBranchRef") or {}).get("name"),
        "parent": f"{parent['owner']['login']}/{parent['name']}" if parent and parent.get("owner") else None,
    }


def fetch(owners=None):
    """Every repository the signed-in account owns, plus its organisations' (or the owners named in roots.json)."""
    me = login()
    owners = list(dict.fromkeys([me, *(owners or []), *orgs()]))
    repos = {}
    counts_ok = True
    for owner in owners:
        out = _gh("repo", "list", owner, "--limit", "4000", "--json", FIELDS)
        for r in json.loads(out or "[]"):
            n = normalize(r)
            repos[n["id"]] = n
        try:
            counts = open_counts(owner)
        except GitHubError:
            counts_ok = False  # the map still works; cards say the counts are unknown rather than zero
            continue
        for n in repos.values():
            if n["fullName"] in counts:
                n["openPRs"], n["openIssues"], n["headOid"] = counts[n["fullName"]]
    data = {"fetchedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"), "login": me, "owners": owners,
            "countsComplete": counts_ok, "repos": sorted(repos.values(), key=lambda x: x["fullName"].lower())}
    config.write_json(CACHE_FILE, data)
    return data


def open_counts(owner):
    """{owner/name: (open pull requests, open issues, commit id at the tip of the default branch)}."""
    out = _gh("api", "graphql", "--paginate", "-f", f"owner={owner}", "-f", f"query={COUNTS}", "--jq",
              ".data.repositoryOwner.repositories.nodes[] | [.nameWithOwner, .pullRequests.totalCount, .issues.totalCount,"
              " (.defaultBranchRef.target.oid // \"\")] | @tsv")
    counts = {}
    for line in out.splitlines():
        parts = line.split("	")
        if len(parts) >= 3:
            counts[parts[0]] = (int(parts[1]), int(parts[2]), (parts[3] if len(parts) > 3 else "") or None)
    return counts


def cached():
    return config.read_json(CACHE_FILE)
