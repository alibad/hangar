"""A full scan: GitHub, this machine's disks and Claude Code's history, written to var/engine/."""
from . import config, local, model, sessions
from . import github as gh_api


def overlay_file():
    return config.MACHINES / f"{config.machine_identity()['id']}.json"


def overlay():
    return config.read_json(overlay_file())


def github_cache():
    return gh_api.cached()


def run(github=True, progress=None):
    """Refresh GitHub (unless github=False, which reuses the cache) and rescan this machine."""
    say = progress or (lambda m: None)
    cfg = config.load_roots()
    config.save_roots(cfg)
    gh, warnings = None, []
    if github:
        say("reading GitHub")
        try:
            gh = gh_api.fetch(cfg.get("owners"))
            say(f"GitHub: {len(gh['repos'])} repositories")
            if not gh.get("countsComplete", True):
                warnings.append("GitHub did not answer for open pull requests and issues; cards leave them out.")
        except (gh_api.GitHubError, OSError) as e:
            cached = github_cache()
            note = f"Showing GitHub as of {cached['fetchedAt'][:10]}." if cached else "Showing this machine only."
            warnings.append(f"Could not read GitHub ({str(e).splitlines()[0][:160]}). {note}")
            say("GitHub unavailable: " + warnings[-1])
    gh = gh or github_cache() or {"login": "", "owners": cfg.get("owners", []), "repos": []}
    say("walking this machine's roots")
    heads = {r["fullName"].lower(): (r.get("defaultBranch"), r.get("headOid")) for r in gh.get("repos", [])}
    doc = local.scan(cfg, [o for o in (gh.get("owners") or [gh.get("login")]) if o], progress=say, heads=heads,
                     previous=overlay())
    if doc.get("inferredOwner") and not gh.get("login"):
        warnings.append(f"Assuming you are {doc['inferredOwner']} on GitHub (most of this machine's remotes).")
    doc["warnings"] = warnings
    say(f"this machine: {len(doc['sites'])} checkouts in {doc['seconds']}s")
    sessions.attach(doc, sessions.collect())
    config.write_json(overlay_file(), doc)
    return doc


def document():
    spine, rules = model.load_spine()
    return model.build(github_cache(), overlay(), spine, rules)
