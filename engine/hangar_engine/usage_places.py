"""Which project each working folder in AI usage belongs to.

Coding agents record the folder a task ran in, not the project. A folder is a project's own checkout, a folder inside
one, an old working copy beside it (RTSAI-Web-wt-accounts next to RTSAI-Web), or a parent folder that holds several
projects (hq/games). Usage then counts real projects, not folders, and keeps parent folders apart instead of guessing
which of their projects the tokens went to."""
import re

from . import local, session_index

# A working copy made beside its project: <name>-wt-<topic> or <name>-worktree-<topic>.
COPY = re.compile(r"^(?P<name>.+?)-(?:wt|worktree)-.+$", re.I)
LIMIT = 2000
SHOWN = 12


def _sites(doc, overlay):
    found = []
    for repo in doc.get("repos", []):
        for site in repo.get("sites", []):
            folder = local.site_path(overlay, site)
            if folder:
                found.append((session_index.norm(folder), repo["id"], site.get("role")))
    found.sort(key=lambda item: len(item[0]), reverse=True)
    return found


def _copy_of(folder, by_path):
    """The project a working copy beside it was made from, looking from the folder up through its parents."""
    parts = folder.split("/")
    for end in range(len(parts), 1, -1):
        match = COPY.match(parts[end - 1])
        if match:
            repo = by_path.get("/".join(parts[:end - 1] + [match.group("name")]))
            if repo:
                return repo
    return None


def places(doc, overlay, paths):
    """{path: place} for the paths that resolve, keyed by the path exactly as sent. A place is one of
    {"kind": "project", "repo"}: the checkout itself or a folder inside it;
    {"kind": "copy", "repo"}: a working copy kept beside the project;
    {"kind": "folder", "holds", "contains", "within"?}: a folder of several projects (the first few of them), which may
    itself be, or lie inside, a parent project ("within")."""
    if not isinstance(paths, list):
        raise ValueError("paths must be a list")
    sites = _sites(doc, overlay)
    by_path = {path: rid for path, rid, _ in sites}
    out = {}
    for raw in paths[:LIMIT]:
        if not isinstance(raw, str) or not raw.strip() or raw.startswith("("):
            continue
        folder = session_index.norm(raw)
        exact = by_path.get(folder)
        inside = exact or next((rid for path, rid, _ in sites if folder.startswith(path + "/")), None)
        # Other projects kept in this folder. A submodule, or the project's own worktree, is part of the project.
        below = sorted({rid for path, rid, role in sites if path.startswith(folder + "/") and rid != inside and role != "submodule"})
        if below:
            # A folder of projects stays a folder, even when it is a parent repository itself (hq, or hq/games inside
            # it): work started there is mostly about the projects it holds, and which ones is not the folder's to say.
            out[raw] = {"kind": "folder", "holds": len(below), "contains": below[:SHOWN], **({"within": inside} if inside else {})}
        elif exact:
            out[raw] = {"kind": "project", "repo": exact}
        elif repo := _copy_of(folder, by_path):
            # Checked before the parent: RTSAI-Web-wt-x lies inside hq, but it is a copy of RTSAI-Web.
            out[raw] = {"kind": "copy", "repo": repo}
        elif inside:
            out[raw] = {"kind": "project", "repo": inside}
    return out
