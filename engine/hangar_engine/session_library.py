"""An explicit, reversible organizing layer shared by Claude and Codex.

Only Hangar metadata is written here. Codex-native actions go through its API;
Claude transcripts and Codex databases are never rewritten or moved by Hangar.
"""
import threading
import time
import uuid
import re
from datetime import datetime, timezone

from . import codex_library, config, desktop_sessions, local, session_index, session_topics, work

_lock = threading.RLock()
DAY = 86400


def stamp(value):
    try:
        if isinstance(value, (int, float)):
            return max(0, float(value))
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return (parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)).timestamp()
    except (ValueError, TypeError, AttributeError, OverflowError):
        return 0


def iso(value):
    return datetime.fromtimestamp(value, timezone.utc).isoformat(timespec="seconds")


def read():
    data = config.read_json(config.LOCAL / "session-library.json", {}) or {}
    return {"version": 1, "idleDays": data.get("idleDays", 7), "groups": data.get("groups", {}), "sessions": data.get("sessions", {})}


def snapshot(doc, overlay, now=None):
    now = time.time() if now is None else now
    saved = read()
    native = codex_library.snapshot()
    history = session_index.timeline(doc, overlay, limit=None)
    entries = {(s["provider"], s["id"]): dict(s) for s in history["sessions"]}
    paths = []
    for repo in doc["repos"]:
        for site in repo.get("sites", []):
            folder = local.site_path(overlay, site)
            if folder:
                paths.append((session_index.norm(folder), repo))
    paths.sort(key=lambda p: len(p[0]), reverse=True)
    for sid, thread in native["threads"].items():
        if ("codex", sid) in entries:
            continue
        cwd = session_index.norm(thread["cwd"]) if thread["cwd"] else ""
        match = next((r for p, r in paths if cwd == p or cwd.startswith(p + "/")), None)
        entries[("codex", sid)] = {"id": sid, "provider": "codex", "model": "", "updatedAt": iso(thread["updated_at"]),
            "state": "unknown", "summary": "Codex session metadata; edit evidence not indexed.", "canResume": bool(match and re.fullmatch(r"[a-zA-Z0-9_-]{8,100}", sid)),
            "projects": [{"id": match["id"], "name": match["name"], "files": [], "evidence": "working-directory"}] if match else []}
    groups = {"codex:" + s["id"]: {"id": "codex:" + s["id"], "name": s["name"], "source": "codex", "nativeId": s["id"]} for s in native["sections"]}
    groups.update({gid: {"id": gid, "name": g["name"], "source": "hangar"} for gid, g in saved["groups"].items()})
    live = work.snapshot()["jobs"]
    rows = []
    for (provider, sid), session in entries.items():
        key = provider + ":" + sid
        meta = saved["sessions"].get(key, {})
        thread = native["threads"].get(sid) if provider == "codex" else None
        native_group = "codex:" + thread["thread_section_id"] if thread and thread.get("thread_section_id") else None
        # Transcript event timestamps survive file copies. Native metadata covers
        # database-backed Codex threads with no JSONL rollout on disk.
        activity = max(stamp(session.get("lastEventAt") or session["updatedAt"]), stamp(thread["updated_at"]) if thread else 0)
        used = max(activity, stamp(meta.get("reviewedAt")), stamp(meta.get("openedAt")))
        archived = bool(thread["archived"]) if thread else bool(session.get("nativeArchived"))
        hangar_archive = stamp(meta.get("archivedAt")) >= activity if meta.get("archivedAt") else False
        busy = any(j.get("state") in {"running", "stopping", "unobserved"} and (
            j.get("session") == sid and j.get("provider") == provider or any(p["id"] == j.get("repo") for p in session["projects"])) for j in live)
        pinned = bool(thread and thread["is_pinned"])
        age = max(0, int((now - used) // DAY)) if used else None
        unread = thread.get("unread") if thread else None
        group = meta.get("group", native_group)
        if group not in groups:
            group = None
        row = {**session, "key": key, "title": (thread["title"][:240] if thread and thread["title"] else session.get("title") or " · ".join(p["name"] for p in session["projects"]) or "Unmatched session"),
            "updatedAt": iso(activity), "activityAt": iso(activity), "idleDays": age, "unread": unread,
            "reviewed": stamp(meta.get("reviewedAt")) >= activity if meta.get("reviewedAt") else False,
            "group": group, "nativeGroup": native_group, "nativeKnown": bool(thread), "pinned": pinned,
            "archived": archived or hangar_archive, "archiveScope": "codex" if archived else "hangar" if hangar_archive else None,
            "protected": busy, "snoozedUntil": meta.get("snoozedUntil"), "suggestion": None, "opensIn": desktop_sessions.opens_in(provider, sid),
            "reviewDue": bool(used and now - used >= saved["idleDays"] * DAY and not archived and not hangar_archive and not busy and not pinned and stamp(meta.get("snoozedUntil")) <= now)}
        rows.append(row)
    # Purpose is suggested from native titles across repositories/providers.
    # When titles are ambiguous, fall back to project evidence explicitly.
    project_sections = {}
    for row in rows:
        if row["nativeGroup"] in groups and groups[row["nativeGroup"]]["name"] != "Pinned" and len(row["projects"]) == 1:
            project_sections.setdefault(row["projects"][0]["id"], set()).add(row["nativeGroup"])
    for row in rows:
        if row["group"] or row["archived"] or "group" in saved["sessions"].get(row["key"], {}):
            continue
        native_title = native["threads"].get(row["id"], {}).get("title", "") if row["provider"] == "codex" else entries[(row["provider"], row["id"])].get("title", "")
        topic = session_topics.suggest(native_title)
        if topic:
            row["suggestion"] = topic
            continue
        if len(row["projects"]) != 1:
            continue
        project = row["projects"][0]
        matches = project_sections.get(project["id"], set())
        gid = next(iter(matches)) if len(matches) == 1 else "project:" + project["id"]
        name = groups[gid]["name"] if gid in groups else project["name"]
        evidence = "Confirmed file edits" if project["evidence"] == "edit-tool" else "Working directory only"
        reason = f"{evidence} in {project['name']}" + ("; matches an existing Codex section" if len(matches) == 1 else "")
        row["suggestion"] = {"id": gid, "name": name, "reason": reason, "confidence": "strong" if project["evidence"] == "edit-tool" else "tentative"}
    rows.sort(key=lambda s: s["updatedAt"], reverse=True)
    return {"sessions": rows, "groups": list(groups.values()), "idleDays": saved["idleDays"], "nativeAvailable": native["available"],
            "reviewCount": sum(s["reviewDue"] for s in rows), "unreadReviewCount": sum(s["reviewDue"] and s["unread"] is True for s in rows),
            "truncated": history["truncated"] or native["truncated"], "observedAt": iso(now)}


def update(doc, overlay, body):
    action = body.get("action")
    with _lock:
        saved = read()
        if action == "settings":
            if type(body.get("idleDays")) is not int or body["idleDays"] not in (7, 14, 30):
                raise ValueError("Choose 7, 14 or 30 idle days.")
            saved["idleDays"] = body["idleDays"]
        elif action == "createGroup":
            name = body.get("name")
            if not isinstance(name, str) or not 1 <= len(name.strip()) <= 80 or len(saved["groups"]) >= 200:
                raise ValueError("Use a group name of 1–80 characters (up to 200 groups).")
            gid = "hangar:" + uuid.uuid4().hex
            saved["groups"][gid] = {"name": name.strip()}
        else:
            current = snapshot(doc, overlay)
            rows = {s["key"]: s for s in current["sessions"]}
            keys = body.get("keys")
            if not isinstance(keys, list) or not 1 <= len(keys) <= 100 or any(not isinstance(k, str) or k not in rows for k in keys) or len(set(keys)) != len(keys):
                raise ValueError("Choose 1–100 known sessions on this machine.")
            if action in {"archive", "restore", "moveCodex"} and len(keys) != 1:
                raise ValueError("Review this action one session at a time.")
            known_groups = {g["id"]: g for g in current["groups"]}
            now = iso(time.time())
            for key in keys:
                row = rows[key]
                meta = saved["sessions"].setdefault(key, {})
                if action == "assign":
                    gid = body.get("group")
                    if gid is not None and (not isinstance(gid, str) or gid not in known_groups):
                        raise ValueError("Choose an existing group.")
                    meta["group"] = gid
                elif action == "acceptSuggestion":
                    suggestion = row["suggestion"]
                    if not suggestion:
                        raise ValueError("This suggestion changed. Refresh before applying it.")
                    gid = suggestion["id"]
                    if gid not in known_groups:
                        saved["groups"][gid] = {"name": suggestion["name"]}
                    meta["group"] = gid
                elif action in {"reviewed", "opened"}:
                    meta[action + "At"] = now
                    meta.pop("snoozedUntil", None)
                elif action == "snooze":
                    meta["snoozedUntil"] = iso(time.time() + 7 * DAY)
                elif action in {"archive", "restore"}:
                    scope = body.get("scope")
                    if scope not in {"hangar", "codex"}:
                        raise ValueError("Choose where to archive this session.")
                    if row["protected"] or (action == "archive" and row["pinned"]):
                        raise ValueError("Pinned sessions and projects with active or unobserved jobs are protected.")
                    if action == "archive" and body.get("activityAt") != row["activityAt"]:
                        raise ValueError("This session changed. Review the latest activity before archiving.")
                    if scope == "codex":
                        if row["provider"] != "codex" or not row["nativeKnown"]:
                            raise ValueError("Codex-native state is unavailable for this session.")
                        codex_library.call("thread/archive" if action == "archive" else "thread/unarchive", {"threadId": row["id"]})
                        session_index.invalidate()
                    if action == "archive" and scope == "hangar":
                        meta["archivedAt"] = now
                    if action == "restore":
                        meta.pop("archivedAt", None)
                        meta["snoozedUntil"] = iso(time.time() + 7 * DAY)
                elif action == "moveCodex":
                    gid = body.get("group")
                    group = known_groups.get(gid) if isinstance(gid, str) else None
                    if row["provider"] != "codex" or not row["nativeKnown"] or not group or group["source"] != "codex":
                        raise ValueError("Choose an existing Codex section and a Codex session.")
                    codex_library.call("thread/section/move", {"threadId": row["id"], "sectionId": group["nativeId"]})
                    meta["group"] = group["id"]
                else:
                    raise ValueError("Unknown session organization action.")
        config.write_json(config.LOCAL / "session-library.json", saved)
    return {"saved": True}
