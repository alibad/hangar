"""Owner-started coding jobs. Fixed agent commands, overlay-resolved folders, no shell.

Only processes started by this server are controllable. Transcript history remains
separate: an old JSONL cannot establish that a process is alive.
"""
import collections
import os
import re
import subprocess
import threading
import time
import uuid
from datetime import datetime, timezone

from . import config, launch, local

_lock = threading.RLock()
_jobs = {}
_processes = {}
_loaded = False
MAX_ACTIVE = 2


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def command(provider, folder, prompt, session=None, read_dirs=None):
    """read_dirs makes a read-only job: no session is kept, and Claude gets only reading tools.
    Codex's sandbox is not enforced on every platform, so its read-only job relies on the task wording too."""
    exe = launch.cli(provider)
    if not exe:
        raise ValueError(f"The {provider} CLI is not installed on this machine.")
    if os.name == "nt" and str(exe).lower().endswith((".cmd", ".bat")):
        exe = launch.bundled_cli(provider)
        if not exe:
            raise ValueError("Install the desktop agent's native executable to run managed jobs on Windows.")
    if provider == "codex" and read_dirs is not None:
        return [exe, "exec", "--json", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", "--cd", str(folder), "-"]
    if provider == "claude" and read_dirs is not None:
        return [exe, "--print", "--verbose", "--output-format", "stream-json", "--no-session-persistence",
                "--tools", "Read", "Grep", "Glob"] + [arg for d in read_dirs for arg in ("--add-dir", str(d))]
    if provider == "codex":
        return [exe, "--cd", str(folder), "exec", "resume", "--json", session, "-"] if session else [exe, "exec", "--json", "--cd", str(folder), "-"]
    if provider == "claude":
        return [exe, "--print", "--verbose", "--output-format", "stream-json"] + (["--resume", session] if session else [])
    raise ValueError("Choose Claude or Codex.")


def sign_in_hint(text):
    """A plain next step when the agent's own command-line sign-in has lapsed."""
    if re.search(r"Failed to authenticate|OAuth access token|401\b.*(token|auth)|Not logged in|Please run /login", text or "", re.I):
        return "The agent's command-line sign-in has expired. Open a terminal, run the agent once and sign in, then try again."
    return None


def signed_out():
    """Agents whose most recent finished job failed on sign-in; a later success clears it."""
    latest = {}
    for job in snapshot()["jobs"]:  # newest first
        if job.get("endedAt") and job["provider"] not in latest:
            latest[job["provider"]] = job
    return [p for p, job in latest.items() if job["state"] == "failed" and sign_in_hint(" ".join(o["text"] for o in job["output"]))]


def checkout(doc, overlay, rid):
    """The project and its main checkout folder on this machine."""
    repo = next((r for r in doc["repos"] if r["id"] == rid), None)
    site = next((s for s in (repo or {}).get("sites", []) if s.get("role") in ("canonical", "orphan")), None)
    folder = local.site_path(overlay, site) if site else None
    if not folder or not folder.is_dir():
        raise ValueError("This project has no main checkout on this machine.")
    return repo, folder


def note(jid, text):
    with _lock:
        if jid in _jobs:
            _jobs[jid]["output"].append({"at": now(), "text": text})
            config.write_json(config.LOCAL / "work-history.json", snapshot())


def snapshot():
    global _loaded
    with _lock:
        if not _loaded:
            _loaded = True
            history = config.read_json(config.LOCAL / "work-history.json", {}) or {}
            for job in history.get("jobs", [])[:40][::-1]:
                if not isinstance(job, dict) or not isinstance(job.get("id"), str):
                    continue
                job["output"] = collections.deque(job.get("output", [])[-120:], maxlen=120)
                if job.get("state") in ("running", "stopping"):
                    job["state"] = "unobserved"
                    job["output"].append({"at": now(), "text": "Hangar restarted. This process may still be running; inspect it before starting another job in this checkout."})
                _jobs[job["id"]] = job
        return {"jobs": [{**job, "output": list(job["output"])} for job in reversed(list(_jobs.values()))],
                "limit": MAX_ACTIVE, "observedAt": now()}


def start(doc, overlay, body):
    snapshot()
    provider, prompt = body.get("provider"), body.get("prompt")
    if provider not in ("claude", "codex") or not isinstance(prompt, str) or not 1 <= len(prompt.strip()) <= 8000:
        raise ValueError("Choose an agent and enter a task (up to 8,000 characters).")
    repo, _ = checkout(doc, overlay, body.get("repo"))
    session = body.get("session")
    if session:
        from . import session_library
        valid = session_library.snapshot(doc, overlay)["sessions"]
        if not any(s["id"] == session and s["provider"] == provider and s["canResume"] and not s["archived"]
                   and any(p["id"] == repo["id"] for p in s["projects"]) for s in valid):
            raise ValueError("That session is not indexed for this project on this machine.")
    return begin(doc, overlay, repo["id"], provider, prompt.strip(), session)


def begin(doc, overlay, rid, provider, prompt, session=None, kind="code", read_dirs=None, on_finish=None, label=None):
    """Start a validated job. on_finish(job, reply) runs after the agent exits, with its final reply."""
    snapshot()
    repo, folder = checkout(doc, overlay, rid)
    argv = command(provider, folder, prompt, session, read_dirs)
    with _lock:
        if len(_processes) >= MAX_ACTIVE:
            raise ValueError("Two jobs are already running. Stop or finish one before starting another.")
        # Starting two writers in the same checkout is never an implicit choice.
        if read_dirs is None and any(j["repo"] == repo["id"] and j.get("kind", "code") == "code" and j["state"] in ("running", "stopping", "unobserved")
                                     for j in _jobs.values()):
            raise ValueError("This checkout has an active or unobserved Hangar job. Inspect it before starting another.")
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        process = subprocess.Popen(argv, cwd=folder, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT, creationflags=flags, start_new_session=os.name != "nt")
        jid = uuid.uuid4().hex
        job = {"id": jid, "repo": repo["id"], "project": repo["name"], "provider": provider,
               "prompt": label or prompt, "kind": kind, "state": "running", "startedAt": now(), "endedAt": None,
               "exitCode": None, "output": collections.deque(maxlen=120), "session": session}
        _jobs[jid] = job
        _processes[jid] = process
        try:
            config.write_json(config.LOCAL / "work-history.json", snapshot())
        except OSError:
            process.kill()
            process.wait()
            process.stdin.close()
            process.stdout.close()
            del _jobs[jid]
            del _processes[jid]
            raise ValueError("Could not save job state; the agent was stopped before receiving its task.")
        # Keep bounded history. Never discard a live process handle.
        for old in list(_jobs)[:-40]:
            if old not in _processes:
                del _jobs[old]

    def monitor():
        import json
        reply = ""
        try:
            try:
                process.stdin.write(prompt.encode("utf-8"))
                process.stdin.close()
            except OSError:
                pass
            for raw in iter(lambda: process.stdout.readline(128 * 1024), b""):
                line = raw.decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                text = line[:2000]
                try:
                    event = json.loads(line)
                    if read_dirs is None and (event.get("thread_id") or event.get("session_id")):  # read-only runs keep no session
                        job["session"] = event.get("thread_id") or event.get("session_id")
                    item = event.get("item") or {}
                    if item.get("type") == "agent_message":
                        reply = item.get("text", "")
                        text = reply[:2000]
                    elif event.get("type") == "assistant":
                        text = "\n".join(b.get("text", "") for b in event.get("message", {}).get("content", []) if b.get("type") == "text")[:2000]
                    elif item.get("type") == "command_execution":
                        text = f"Ran {item.get('command', '')}"[:300] if event.get("type") == "item.completed" else ""
                    elif event.get("type") == "result":
                        reply = str(event.get("result") or "")
                        text = (reply or str(event.get("subtype", "")))[:2000]
                    else:
                        text = event.get("type", "Agent activity") + (" · " + item.get("type", "") if item else "")
                except (ValueError, TypeError, AttributeError):
                    if len(line) > 600:  # a fragment of an event too large for one read, not a message
                        text = ""
                if text:
                    with _lock:
                        job["output"].append({"at": now(), "text": text})
        finally:
            code = process.wait()
            process.stdout.close()
            with _lock:
                job.update(state="stopped" if job["state"] == "stopping" else "completed" if code == 0 else "failed",
                           exitCode=code, endedAt=now())
                hint = code and sign_in_hint(" ".join(o["text"] for o in job["output"]))
                if hint:
                    job["output"].append({"at": now(), "text": hint})
                _processes.pop(jid, None)
                config.write_json(config.LOCAL / "work-history.json", snapshot())
            from . import session_index
            session_index.invalidate()
            if on_finish:
                on_finish(job, reply)
    threading.Thread(target=monitor, daemon=True).start()
    return {"id": jid, "started": True}


def stop(jid):
    with _lock:
        process = _processes.get(jid)
        if not process or process.poll() is not None:
            raise ValueError("That job is no longer running in this server.")
        _jobs[jid]["state"] = "stopping"
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW, timeout=10)
        else:
            import signal
            os.killpg(process.pid, signal.SIGTERM)
    return {"stopping": True}


def acknowledge(jid):
    """Owner explicitly verified an unobserved process outside this server."""
    snapshot()
    with _lock:
        job = _jobs.get(jid)
        if not job or job["state"] != "unobserved":
            raise ValueError("Only an unobserved job can be acknowledged.")
        job.update(state="acknowledged", endedAt=now())
        job["output"].append({"at": now(), "text": "Owner confirmed this job is no longer running."})
        config.write_json(config.LOCAL / "work-history.json", snapshot())
    return {"acknowledged": True}
