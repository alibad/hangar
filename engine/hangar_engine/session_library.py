"""An explicit, reversible organizing layer shared by Claude and Codex.

Only Hangar metadata is written here. Codex-native actions go through its API;
Claude transcripts and Codex databases are never rewritten or moved by Hangar.
The Claude app's own session records are read for its titles, archive flags,
unread replies and status lines, never written.

Archive means archived in the app that holds the session. A Codex thread is
archived through Codex's API. The Claude app can only be changed from inside
it, so a Claude app session is queued here and a Claude session in the app
archives it (hangar_cleanup lists the queue); it counts as archived once the
app's record says so. Only a session no app shows (a terminal session, an old
Codex rollout) is archived in Hangar itself, since Hangar is the one list it
is in.
"""
import threading
import time
import uuid
import re
from datetime import datetime, timezone

from . import codex_library, config, desktop_sessions, local, session_index, session_topics, work
from .activity import claimed

_lock = threading.RLock()
DAY = 86400
LIVE = 30 * 60  # an open turn that has written nothing for this long is a crashed app, not work


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


def snapshot(doc, overlay, now=None, changes=False):
    """changes adds what each session committed (one short git log per project, cached), for the session list."""
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
            "probe": not match and session_index.in_temp(thread["cwd"]),
            "projects": [{"id": match["id"], "name": match["name"], "files": [], "evidence": "working-directory"}] if match else []}
    groups = {"codex:" + s["id"]: {"id": "codex:" + s["id"], "name": s["name"], "source": "codex", "nativeId": s["id"]} for s in native["sections"]}
    groups.update({gid: {"id": gid, "name": g["name"], "source": "hangar"} for gid, g in saved["groups"].items()})
    live = work.snapshot()["jobs"]
    app = desktop_sessions.claude_app_records()
    checkins = config.read_json(config.LOCAL / "checkins.json", {}) or {}  # checkin.py writes these
    rows = []
    for (provider, sid), session in entries.items():
        key = provider + ":" + sid
        meta = saved["sessions"].get(key, {})
        thread = native["threads"].get(sid) if provider == "codex" else None
        record = app.get(sid) if provider == "claude" else None
        native_group = "codex:" + thread["thread_section_id"] if thread and thread.get("thread_section_id") else None
        # Transcript event timestamps survive file copies. Native metadata covers
        # database-backed Codex threads with no JSONL rollout on disk.
        activity = max(stamp(session.get("lastEventAt") or session["updatedAt"]), stamp(thread["updated_at"]) if thread else 0)
        used = max(activity, stamp(meta.get("reviewedAt")), stamp(meta.get("openedAt")))
        archived = bool(thread["archived"]) if thread else bool(session.get("nativeArchived") or record and record["archived"])
        hangar_archive = stamp(meta.get("archivedAt")) >= activity if meta.get("archivedAt") else False
        # Asked to archive in the Claude app and not yet done there; new activity since then cancels the request.
        app_pending = bool(record and not record["archived"] and meta.get("appArchiveAt") and stamp(meta["appArchiveAt"]) >= activity)
        busy = any(j.get("state") in {"running", "stopping", "unobserved"} and (
            j.get("session") == sid and j.get("provider") == provider or any(p["id"] == j.get("repo") for p in session["projects"])) for j in live)
        # Working now: a Hangar job is running in this conversation, or its transcript shows a turn that has not ended. A
        # crashed app leaves a turn open forever, so an open turn counts only while the conversation is still writing.
        job_here = any(j.get("state") in {"running", "stopping"} and j.get("session") == sid and j.get("provider") == provider for j in live)
        open_turn = session.get("state") == "working" and now - activity < LIVE
        pinned = bool(thread and thread["is_pinned"])
        age = max(0, int((now - used) // DAY)) if used else None
        unread = thread.get("unread") if thread else record["unread"] if record else None
        group = meta.get("group", native_group)
        if group not in groups:
            group = None
        title = thread["title"] if thread and thread["title"] else record["title"] if record and record["title"] else session.get("title")
        row = {**session, "key": key, "title": (title or " · ".join(p["name"] for p in session["projects"]) or "Unmatched session")[:240],
            "updatedAt": iso(activity), "activityAt": iso(activity), "idleDays": age, "unread": unread,
            "reviewed": stamp(meta.get("reviewedAt")) >= activity if meta.get("reviewedAt") else False,
            "group": group, "nativeGroup": native_group, "nativeKnown": bool(thread), "pinned": pinned,
            "archived": archived or hangar_archive or app_pending, "archiveScope": provider if archived or app_pending else "hangar" if hangar_archive else None,
            "archivePending": app_pending, "appId": record["own"] if record else None,
            "checkin": found if (found := checkins.get(key)) and found.get("activityAt") == iso(activity) else None,
            "status": record["status"] if record and not archived else None, "working": bool(job_here or open_turn),
            "protected": busy, "snoozedUntil": meta.get("snoozedUntil"), "suggestion": None, "opensIn": desktop_sessions.opens_in(provider, sid),
            "reviewDue": bool(used and now - used >= saved["idleDays"] * DAY and not archived and not hangar_archive and not app_pending and not busy and not pinned
                              and not session.get("probe") and stamp(meta.get("snoozedUntil")) <= now)}
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
    if changes:
        recent = {p["id"] for row in rows if now - stamp(row["activityAt"]) <= 30 * DAY for p in row["projects"]}
        try:
            made = claimed(doc, overlay, recent, now=now)
        except Exception:  # what a session changed is a bonus; the list must still load
            made = {}
        for row in rows:
            row["changed"] = made.get(row["key"], [])[:8]
            row["changedCount"] = len(made.get(row["key"], []))
    rows.sort(key=lambda s: s["updatedAt"], reverse=True)
    return {"sessions": rows, "groups": list(groups.values()), "idleDays": saved["idleDays"], "nativeAvailable": native["available"],
            "reviewCount": sum(s["reviewDue"] for s in rows), "unreadReviewCount": sum(s["reviewDue"] and s["unread"] is True for s in rows),
            "claudeApp": bool(app), "checking": _checking(), "claudeQueue": [{"key": r["key"], "appId": r["appId"], "title": r["title"]} for r in rows if r["archivePending"]],
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
            if not isinstance(keys, list) or not 1 <= len(keys) <= 500 or any(not isinstance(k, str) or k not in rows for k in keys) or len(set(keys)) != len(keys):
                raise ValueError("Choose 1–500 known sessions on this machine.")
            if action in {"restore", "moveCodex"} and len(keys) != 1:
                raise ValueError("Review this action one session at a time.")
            if action == "archive":
                return _archive(saved, rows, keys, body)
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
                elif action == "restore":
                    if row["archiveScope"] == "claude" and not row["archivePending"]:
                        raise ValueError("It is archived in the Claude app. Restore it there, from the app's archived sessions.")
                    if row["archiveScope"] == "codex":
                        codex_library.call("thread/unarchive", {"threadId": row["id"]})
                        session_index.invalidate()
                    meta.pop("archivedAt", None)
                    meta.pop("appArchiveAt", None)
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


def _archive(saved, rows, keys, body):
    """Archive in the app that holds each session: Codex through its API, the Claude app through the queue a Claude
    session there applies, Hangar only for sessions no app shows. One session or a whole age group: every session is
    checked before anything changes, and unread ones are never archived in bulk."""
    expected = body.get("activity") if isinstance(body.get("activity"), dict) else {keys[0]: body.get("activityAt")} if len(keys) == 1 else {}
    for key in keys:
        row = rows[key]
        if row["protected"] or row["pinned"]:
            raise ValueError(f"“{row['title'][:60]}” is pinned or its project has a running job, so it stays.")
        if len(keys) > 1 and row["unread"] is True:
            raise ValueError(f"“{row['title'][:60]}” is unread. Unread sessions are never archived in bulk; open it first.")
        if expected.get(key) != row["activityAt"]:
            raise ValueError(f"“{row['title'][:60]}” changed since this list was shown. Refresh and look again.")
    live = [rows[k] for k in keys if not rows[k]["archived"]]
    codex = [r for r in live if r["provider"] == "codex" and r["nativeKnown"]]
    claude = [r for r in live if r["provider"] == "claude" and r["appId"]]
    failed = []
    if codex:
        results = codex_library.call_many("thread/archive", [{"threadId": r["id"]} for r in codex])
        failed = [r for r, result in zip(codex, results) if isinstance(result, Exception)]
        if len(keys) == 1 and failed:
            raise next(result for result in results if isinstance(result, Exception))
        session_index.invalidate()
    now = iso(time.time())
    for row in claude:
        saved["sessions"].setdefault(row["key"], {})["appArchiveAt"] = now
    elsewhere = [r for r in live if r not in codex and r not in claude]
    for row in elsewhere:
        saved["sessions"].setdefault(row["key"], {})["archivedAt"] = now
    config.write_json(config.LOCAL / "session-library.json", saved)
    return {"saved": True, "archived": len(live) - len(failed), "codexArchived": len(codex) - len(failed), "codexFailed": len(failed),
            "claudeQueued": len(claude), "hangarOnly": len(elsewhere)}


def _checking():
    from . import checkin  # checkin reads this module's sessions
    return checkin.progress()
