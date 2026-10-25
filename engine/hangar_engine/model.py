"""One document from three layers: GitHub (who exists), this machine's overlay (where), and the spine (what it means).

Every number the viewer shows is computed here from those facts; nothing is typed in by hand.
"""
import hashlib
import re
from datetime import datetime, timezone

from . import config

RECENCY = [(30, "live"), (90, "recent"), (365, "quiet")]
STAGES = [(300, "tent"), (5_000, "house"), (50_000, "midrise"), (500_000, "tower")]
NOT_CANONICAL = ("copy", "worktree", "release", "derived", "submodule")


def parse_time(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def days_since(s, now):
    t = parse_time(s)
    return None if t is None else max(0, (now - t).total_seconds() / 86400)


def recency(days):
    if days is None:
        return "unknown"
    for limit, name in RECENCY:
        if days <= limit:
            return name
    return "dormant"


def stage(size_kb, empty):
    """The building a repo gets: an empty lot, then a tent, a house, a mid-rise, a tower, a skyscraper."""
    if empty or not size_kb:
        return "lot"
    for limit, name in STAGES:
        if size_kb < limit:
            return name
    return "skyscraper"


def tokens(name):
    spaced = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "-", name)
    return [t for t in re.split(r"[-_.\s]+", spaced.lower()) if t]


def cluster_key(name):
    t = tokens(name)
    if not t:
        return None
    return t[0] if len(t[0]) >= 3 else ("-".join(t[:2]) if len(t) > 1 else None)


def pretty_prefix(names):
    norm = ["-".join(tokens(n)) for n in names]
    pre = norm[0]
    for n in norm[1:]:
        while not n.startswith(pre):
            pre = pre[:-1]
    pre = pre.strip("-") or norm[0].split("-")[0]
    words = pre.split("-")
    return " ".join([words[0].capitalize(), *words[1:]])


def assign_families(repos, rules, overrides):
    """Purpose categories only. Visibility, attention, age and origin are separate."""
    families = {}

    def put(r, fid, name):
        r["family"] = fid
        families.setdefault(fid, {"id": fid, "name": name, "repos": 0})

    compiled = [(f, [re.compile(p) for p in f["match"]]) for f in rules]
    rest = []
    for r in repos:
        o = overrides.get(r["id"], {})
        if o.get("family"):
            rule = next((f for f in rules if f["id"] == o["family"]), None)
            put(r, o["family"], rule["name"] if rule else o["family"].replace("-", " ").capitalize())
            continue
        low = r["name"].lower()
        hit = next((f for f, pats in compiled if any(p.search(low) for p in pats)), None)
        if hit:
            put(r, hit["id"], hit["name"])
        else:
            rest.append(r)
    groups = {}
    for r in rest:
        k = cluster_key(r["name"])
        if k:
            groups.setdefault(k, []).append(r)
    for k, members in groups.items():
        if len(members) >= 2:
            name = pretty_prefix([m["name"] for m in members])
            for m in members:
                put(m, f"auto-{k}", name)
    for r in rest:
        if r.get("family"):
            continue
        put(r, "uncategorized", "Uncategorized")
    for r in repos:
        families[r["family"]]["repos"] += 1
    return sorted(families.values(), key=lambda f: -f["repos"])


def site_view(s):
    keep = ("root", "rel", "role", "layout", "remoteName", "remotes", "branch", "head", "ahead", "behind", "dirty", "lastCommit", "upstream",
            "lastSession", "sessions", "checkpoint", "commits", "run", "spare", "aheadOnRemote", "pull", "dirtyFiles", "apps", "logo")
    return {k: s.get(k) for k in keep}


def nothing_unique(s):
    """An extra folder whose commits are on a remote, with nothing uncommitted and nothing ignored beyond build output."""
    v = s.get("spare")
    return bool(v) and v["commitsElsewhere"] and not v["ignored"] and not v["ignoredMore"] and not (s.get("dirty") or 0)


def risks_for(r, now):
    out = []
    sites = r["sites"]
    if r["kind"] == "orphan":
        out.append({"id": "offmap", "level": "high", "text": "Only on this disk: no remote anywhere"})
    # Commits ahead of the tracked branch only count when no remote branch holds them yet.
    ahead = [s for s in sites if (s.get("ahead") or 0) > 0 and not s.get("aheadOnRemote")
             and not (s.get("spare") or {}).get("commitsElsewhere")]
    if ahead:
        top = max(ahead, key=lambda s: s["ahead"])
        n, behind, up = top["ahead"], top.get("behind") or 0, top.get("upstream") or "its remote"
        level = "high" if any(s["role"] in ("canonical", "orphan") for s in ahead) else "medium"
        who = "The main folder" if top["role"] == "canonical" else "A folder"
        if len(ahead) > 1:
            text = f"{len(ahead)} folders have commits not on {up}; the most is {n} ahead"
        elif behind:
            text = f"{who} has diverged from {up}: {n} ahead, {behind} behind"
        else:
            text = f"{who} is {n} commit{'s' * (n != 1)} ahead of {up}"
        out.append({"id": "unpushed", "level": level, "text": text + " (as of its last fetch)"})
    dirty = sum(s.get("dirty") or 0 for s in sites)
    if dirty:
        out.append({"id": "uncommitted", "level": "medium",
                    "text": f"{dirty} uncommitted change{'s' * (dirty != 1)}"})
    extra = [s for s in sites if s["role"] in NOT_CANONICAL]
    if len(extra) >= 2:
        clean = sum(1 for s in extra if nothing_unique(s))
        detail = f"; {clean} of the extras {'holds' if clean == 1 else 'hold'} nothing unique (as of the last fetch)" if clean else ""
        out.append({"id": "sprawl", "level": "medium", "text": f"{len(extra) + 1} local folders for one repo{detail}"})
    if any(s["role"] == "derived" for s in sites):
        out.append({"id": "derived", "level": "low", "text": "A folder clones another local folder"})
    if r["kind"] in ("mine", "fork") and not sites and r["recency"] == "live":
        out.append({"id": "elsewhere", "level": "low", "text": "Pushed this month, not on this machine"})
    behind = next((s["pull"] for s in sites if (s.get("pull") or {}).get("needed")), None)
    if behind:
        out.append({"id": "pull", "level": "medium", "text": f"GitHub has newer commits on {behind['branch']}: pull to get them"})
    prs = r.get("openPRs") or 0
    if prs:
        out.append({"id": "prs", "level": "medium", "text": f"{prs} open pull request{'s' * (prs != 1)} waiting"})
    if r.get("empty"):
        out.append({"id": "empty", "level": "low", "text": "Empty on GitHub"})
    cp = next((s.get("checkpoint") for s in sites if s.get("checkpoint")), None)
    last = max((s.get("lastCommit") or "" for s in sites), default="")
    if cp and last and parse_time(last) and parse_time(cp["updatedAt"]) and parse_time(last) > parse_time(cp["updatedAt"]):
        out.append({"id": "stale", "level": "medium", "text": "Commits landed after its last checkpoint"})
    return out


def meaning(r, override, sites):
    """What the repo is for: your words in the spine, else its checkpoint, else GitHub, else its README."""
    cp = next((s.get("checkpoint") for s in sites if s.get("checkpoint")), None)
    readme = next((s.get("readme") for s in sites if s.get("readme")), None)
    f = (cp or {}).get("fields", {})
    out = {
        "purpose": override.get("purpose") or r.get("description") or readme or "",
        "forWhom": override.get("forWhom") or f.get("who it's for") or f.get("for") or "",
        "why": override.get("whyItMatters") or f.get("why it matters") or f.get("why") or "",
        "stage": override.get("stage") or f.get("stage") or "",
        "next": override.get("next") or f.get("next step") or f.get("next") or "",
        "blockers": f.get("blockers") or f.get("blocked") or "",
    }
    out["source"] = ("spine" if override.get("purpose") else "description" if r.get("description")
                     else "readme" if readme else "none")
    return out


def build(github, overlay, spine, rules, now=None):
    now = now or datetime.now(timezone.utc)
    login = (github or {}).get("login") or ""
    owners = [o.lower() for o in ((github or {}).get("owners") or [login, (overlay or {}).get("inferredOwner")]) if o]
    overrides = (spine or {}).get("repos", {})
    by_slug, repos = {}, {}
    for g in (github or {}).get("repos", []):
        r = {**g, "kind": "fork" if g["fork"] else "mine", "sites": []}
        repos[g["id"]] = r
        by_slug[g["fullName"].lower()] = r

    sites = (overlay or {}).get("sites", [])
    local_index = {}
    for s in sites:
        local_index[f"{s['root']}/{s['rel']}".lower()] = s
    for s in sites:
        remote = s.get("remote") or {}
        target = None
        if "slug" in remote and remote["slug"] in by_slug:
            target = by_slug[remote["slug"]]
        elif "slug" in remote:
            vendor = bool(owners) and remote["owner"].lower() not in owners
            vid = ("vendor:" if vendor else "remote:") + remote["slug"]
            target = repos.setdefault(vid, {
                "id": vid, "name": remote["name"], "owner": remote["owner"], "fullName": f"{remote['owner']}/{remote['name']}",
                "url": f"https://{remote['host']}/{remote['owner']}/{remote['name']}" if remote.get("host") else None,
                "description": "", "homepage": "", "private": None, "fork": False, "archived": False, "empty": False,
                "language": None, "topics": [], "createdAt": None, "pushedAt": None, "sizeKB": 0, "stars": 0,
                "defaultBranch": None, "parent": None, "sites": [],
                "kind": "vendor" if vendor else "unlisted"})
        elif "local" in remote:
            target = _derived_target(s, remote["local"], overlay, repos, by_slug)
        if target is None:
            key = f"{s['root']}/{s['rel']}"
            oid = "local:" + hashlib.sha1(f"{(overlay or {}).get('machine', {}).get('id')}|{key}".encode()).hexdigest()[:10]
            target = repos.setdefault(oid, {
                "id": oid, "name": s["rel"].rsplit("/", 1)[-1] or s["root"], "owner": None, "fullName": None, "url": None,
                "description": "", "homepage": "", "private": True, "fork": False, "archived": False, "empty": False,
                "language": None, "topics": [], "createdAt": None, "pushedAt": None, "sizeKB": 0, "stars": 0,
                "defaultBranch": None, "parent": None, "sites": [], "kind": "orphan"})
        target["sites"].append(s)

    out = []
    for r in repos.values():
        o = overrides.get(r["id"], {})
        r["hidden"] = bool(o.get("hidden"))
        r["attention"] = "focus" if o.get("focus") else "parked" if o.get("parked") else None
        last = r.get("pushedAt") or max((s.get("lastCommit") or "" for s in r["sites"]), default="") or None
        d = days_since(last, now)
        r["lastActivity"] = last
        r["recency"] = recency(d)
        r["stage"] = (stage(r.get("sizeKB"), r.get("empty")) if r["kind"] in ("mine", "fork")
                      else "warehouse" if r["kind"] == "vendor" else "house")
        r["meaning"] = meaning(r, o, r["sites"])
        r["notes"] = {k: v for k, v in o.items() if k not in ("hidden", "focus", "parked")}
        r["onMachine"] = bool(r["sites"])
        r["copies"] = len(r["sites"])
        r["sessions"] = sum(s.get("sessions") or 0 for s in r["sites"])
        r["lastSession"] = max((s.get("lastSession") or "" for s in r["sites"]), default="") or None
        r["risks"] = risks_for(r, now)
        roles = {"canonical": 0, "orphan": 1, "vendor": 2, "clone": 3, "release": 4, "copy": 5, "derived": 6,
                 "submodule": 7, "worktree": 8}
        r["sites"] = [site_view(s) for s in sorted(r["sites"], key=lambda s: (roles.get(s["role"], 9), s["rel"]))]
        out.append(r)

    families = assign_families(out, rules, overrides)
    island_prefs = spine.get("islands", {})
    custom, hidden_islands = island_prefs.get("custom", {}), island_prefs.get("hidden", {})
    all_islands = {f["id"]: {**f, "hidden": f["id"] in hidden_islands, "custom": f["id"] in custom} for f in families}
    for fid, name in {**custom, **hidden_islands}.items():
        all_islands.setdefault(fid, {"id": fid, "name": name, "repos": 0, "hidden": fid in hidden_islands, "custom": fid in custom})
    for r in out:
        if r["family"] in hidden_islands and not r["hidden"]:
            r["hidden"], r["hiddenByIsland"] = True, r["family"]
    families = [f for f in all_islands.values() if not f["hidden"]]
    out.sort(key=lambda r: (r["family"], -(parse_time(r["lastActivity"]) or datetime.min.replace(tzinfo=timezone.utc)).timestamp()))
    return {
        "schema": 1,
        "generatedAt": now.isoformat(timespec="seconds"),
        "login": login,
        "github": {"fetchedAt": (github or {}).get("fetchedAt"), "owners": (github or {}).get("owners") or []},
        "machine": {**((overlay or {}).get("machine") or {}), "scannedAt": (overlay or {}).get("scannedAt"),
                    "roots": list(((overlay or {}).get("roots") or {}).keys())},
        "families": families,
        "islands": list(all_islands.values()),
        "warnings": (overlay or {}).get("warnings") or [],
        "repos": out,
        "stats": {**stats([r for r in out if not r["hidden"]]), "hidden": sum(1 for r in out if r["hidden"])},
    }


def _derived_target(site, local_url, overlay, repos, by_slug):
    """A clone of a clone belongs to whatever its source folder belongs to."""
    import os
    from .local import site_path
    want = os.path.normcase(os.path.normpath(local_url.replace("/", os.sep)))
    for other in (overlay or {}).get("sites", []):
        if other is site:
            continue
        p = site_path(overlay, other)
        if p and os.path.normcase(os.path.normpath(str(p))) == want:
            remote = other.get("remote") or {}
            if "slug" in remote and remote["slug"] in by_slug:
                return by_slug[remote["slug"]]
    return None


def stats(repos):
    def count(pred):
        return sum(1 for r in repos if pred(r))
    mine = ("mine", "fork")
    gh = [r for r in repos if r.get("kind") in mine]
    risks = {}
    for r in repos:
        for k in r.get("risks", []):
            risks[k["id"]] = risks.get(k["id"], 0) + 1
    return {
        "repos": len(repos),
        "github": len(gh),
        "mine": count(lambda r: r.get("kind") == "mine"),
        "forks": count(lambda r: r.get("kind") == "fork"),
        "private": count(lambda r: r.get("kind") in mine and r.get("private")),
        "public": count(lambda r: r.get("kind") in mine and r.get("private") is False),
        "onMachine": count(lambda r: r.get("kind") in mine and r.get("onMachine")),
        "elsewhere": count(lambda r: r.get("kind") in mine and not r.get("onMachine")),
        "offMap": count(lambda r: r.get("kind") == "orphan"),
        "vendor": count(lambda r: r.get("kind") == "vendor"),
        "sites": sum(r.get("copies", 0) for r in repos),
        "live": count(lambda r: bool(r.get("homepage"))),
        "recency": {k: count(lambda r, k=k: r.get("recency") == k) for k in ("live", "recent", "quiet", "dormant", "unknown")},
        "risks": risks,
        "atRisk": count(lambda r: any(k["level"] in ("high", "medium") for k in r.get("risks", []))),
        "toCommit": count(lambda r: any((s.get("dirty") or 0) > 0 for s in r.get("sites", []))),
        "toPush": count(lambda r: any(k["id"] in ("unpushed", "offmap") for k in r.get("risks", []))),
        "toPull": count(lambda r: any(k["id"] == "pull" for k in r.get("risks", []))),
        "openPRs": sum(r.get("openPRs") or 0 for r in repos),
        "openIssues": sum(r.get("openIssues") or 0 for r in repos),
    }


def load_spine():
    spine = config.read_json(config.SPINE / "spine.json", {}) or {}
    rules = (config.read_json(config.SPINE / "families.json", {}) or {}).get("families", [])
    spine["islands"] = config.read_json(config.LOCAL / "islands.json", {}) or {}
    rules += [{"id": fid, "name": name, "match": []} for fid, name in spine["islands"].get("custom", {}).items()]
    return spine, rules


NOTE_FIELDS = ("family", "purpose", "forWhom", "whyItMatters", "stage", "next", "hidden", "focus", "parked")


def save_notes(doc, rid, fields):
    """Your words and Focus / Park / Hide for one repo, saved to spine/spine.json (never into the repo itself).
    Raises ValueError with a message for the person when the repo or district is unknown."""
    if not any(r["id"] == rid for r in doc["repos"]):
        raise ValueError("No such repo on the map.")
    families = {f["id"] for f in doc["families"]} | {f["id"] for f in load_spine()[1]}
    clean = {}
    for key in NOTE_FIELDS:
        if key not in (fields or {}):
            continue
        v = fields[key]
        if key in ("hidden", "focus", "parked"):
            clean[key] = bool(v)
            continue
        v = str(v or "").strip()[:400]
        if key == "family" and v and v not in families:
            raise ValueError("Unknown district.")
        clean[key] = v
    path = config.SPINE / "spine.json"
    spine = config.read_json(path, {}) or {}
    spine.setdefault("repos", {})
    entry = {k: v for k, v in {**spine["repos"].get(rid, {}), **clean}.items() if v not in ("", None, False)}
    if entry:
        spine["repos"][rid] = entry
    else:
        spine["repos"].pop(rid, None)
    spine["repos"] = dict(sorted(spine["repos"].items()))
    config.write_json(path, spine, indent=2)
