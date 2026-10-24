"""Explicit, private project-to-plan links. No plan descriptions or credentials are read."""
import threading
from urllib.parse import urlsplit
from . import config

_lock = threading.Lock()


def read():
    return config.read_json(config.LOCAL / "project-plans.json", {}) or {}


def save(doc, body):
    rid, url, title = body.get("repo"), body.get("url", ""), body.get("title", "")
    if not any(r["id"] == rid for r in doc["repos"]):
        raise ValueError("Choose a project from this map.")
    if not isinstance(url, str) or not isinstance(title, str) or len(url) > 2000 or len(title) > 120:
        raise ValueError("Use a plan URL and a short title.")
    url, title = url.strip(), title.strip()
    if url:
        parsed = urlsplit(url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError("Use an HTTPS plan link without credentials.")
        if not title:
            raise ValueError("Give the linked plan a title.")
    with _lock:
        links = read()
        if url:
            links[rid] = {"url": url, "title": title}
        else:
            links.pop(rid, None)
        config.write_json(config.LOCAL / "project-plans.json", links)
    return {"saved": True, "link": links.get(rid)}
