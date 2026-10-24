"""Read Codex's local organization without editing its private database.

Native mutations use the installed app-server protocol, only after an explicit
action. Schema changes degrade to unknown state, never fabricated read receipts.
"""
import json
import os
import queue
import re
import sqlite3
import subprocess
import threading
import time
from contextlib import closing
from pathlib import Path

from . import launch


def home():
    return Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")


def snapshot():
    result = {"available": False, "sections": [], "threads": {}, "truncated": False}
    databases = sorted((p for p in home().glob("state_*.sqlite") if re.fullmatch(r"state_\d+\.sqlite", p.name)),
                       key=lambda p: int(re.search(r"state_(\d+)", p.name)[1]), reverse=True)
    if not databases:
        return result
    try:
        with closing(sqlite3.connect(databases[0].resolve().as_uri() + "?mode=ro", uri=True, timeout=.3)) as db:
            db.row_factory = sqlite3.Row
            db.execute("BEGIN")
            cols = {row[1] for row in db.execute("pragma table_info(threads)")}
            required = {"id", "title", "cwd", "updated_at", "archived", "is_pinned", "thread_section_id"}
            if not required <= cols:
                return result
            sections = [dict(row) for row in db.execute("select id,name from thread_sections limit 200")]
            receipts = {}
            try:
                receipts = {row[0]: bool(row[1]) for row in db.execute("select thread_id,first_unread_turn from thread_read_receipts")}
            except sqlite3.Error:
                pass
            display_name = "name" if "name" in cols else "null as name"
            rows = db.execute(f"select id,title,{display_name},cwd,updated_at,archived,is_pinned,thread_section_id from threads order by updated_at desc limit 5001").fetchall()
            for row in rows[:5000]:
                thread = dict(row)
                thread["title"] = row["name"] or row["title"]
                thread["unread"] = receipts.get(row["id"])
                result["threads"][row["id"]] = thread
            result.update(available=True, sections=sections, truncated=len(rows) > 5000)
    except (sqlite3.Error, OSError, ValueError):
        pass
    return result


def call(method, params, timeout=20):
    """One bounded stdio client. Never starts a turn or alters agent permissions."""
    if method not in {"threadSection/list", "thread/archive", "thread/unarchive", "thread/section/move"}:
        raise ValueError("Unsupported Codex organization operation.")
    exe = launch.bundled_cli("codex") or launch.cli("codex")
    if not exe or Path(exe).suffix.lower() in {".cmd", ".bat"}:
        raise ValueError("A native Codex executable is required for this action.")
    process = subprocess.Popen([exe, "app-server"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, text=True, encoding="utf-8",
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    replies = queue.Queue(maxsize=100)

    def receive():
        try:
            for line in process.stdout:
                try:
                    reply = json.loads(line)
                    if isinstance(reply, dict) and reply.get("id") in (1, 2):
                        replies.put_nowait(reply)
                except (ValueError, queue.Full):
                    continue
        finally:
            try:
                replies.put_nowait({"error": {"message": "Codex organization connection closed."}})
            except queue.Full:
                pass

    reader = threading.Thread(target=receive, daemon=True)
    reader.start()
    deadline = time.monotonic() + timeout

    def send(message):
        process.stdin.write(json.dumps(message) + "\n")
        process.stdin.flush()

    def response(rid):
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ValueError("Codex did not confirm the action. Refresh its state before retrying.")
            try:
                reply = replies.get(timeout=remaining)
            except queue.Empty:
                raise ValueError("Codex did not confirm the action. Refresh its state before retrying.") from None
            if "error" in reply:
                raise ValueError(str(reply["error"].get("message", "Codex rejected the action."))[:300])
            if reply.get("id") == rid:
                return reply.get("result", {})

    try:
        send({"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "hangar_organizer", "version": "1.0"}, "capabilities": {"experimentalApi": True}}})
        response(1)
        send({"method": "initialized", "params": {}})
        send({"id": 2, "method": method, "params": params})
        return response(2)
    finally:
        process.stdin.close()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)
        reader.join(timeout=1)
        process.stdout.close()
