"""Owner-started coding jobs. Fixed agent commands, overlay-resolved folders, no shell.

Only processes started by this server are controllable. Transcript history remains
separate: an old JSONL cannot establish that a process is alive.
"""
import collections
import os
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


def command(provider, folder, prompt, session=None):
    exe = launch.cli(provider)
    if not exe:
        raise ValueError(f"The {provider} CLI is not installed on this machine.")
    if os.name == "nt" and str(exe).lower().endswith((".cmd", ".bat")):
        exe = launch.bundled_cli(provider)
        if not exe:
            raise ValueError("Install the desktop agent's native executable to run managed jobs on Windows.")
    if provider == "codex":
        return [exe, "--cd", str(folder), "exec", "resume", "--json", session, "-"] if session else [exe, "exec", "--json", "--cd", str(folder), "-"]
    if provider == "claude":
        return [exe, "--print", "--verbose", "--output-format", "stream-json"] + (["--resume", session] if session else [])
    raise ValueError("Choose Claude or Codex.")


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
    repo = next((r for r in doc["repos"] if r["id"] == body.get("repo")), None)
    site = next((s for s in (repo or {}).get("sites", []) if s.get("role") in ("canonical", "orphan")), None)
    folder = local.site_path(overlay, site) if site else None
    if not folder or not folder.is_dir():
        raise ValueError("This project has no main checkout on this machine.")
    session = body.get("session")
    if session:
        from . import session_library
        valid = session_library.snapshot(doc, overlay)["sessions"]
        if not any(s["id"] == session and s["provider"] == provider and s["canResume"] and not s["archived"]
                   and any(p["id"] == repo["id"] for p in s["projects"]) for s in valid):
            raise ValueError("That session is not indexed for this project on this machine.")
    argv = command(provider, folder, prompt.strip(), session)
    with _lock:
        if len(_processes) >= MAX_ACTIVE:
            raise ValueError("Two jobs are already running. Stop or finish one before starting another.")
        # Starting two writers in the same checkout is never an implicit choice.
        if any(j["repo"] == repo["id"] and j["state"] in ("running", "stopping", "unobserved") for j in _jobs.values()):
            raise ValueError("This checkout has an active or unobserved Hangar job. Inspect it before starting another.")
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        process = subprocess.Popen(argv, cwd=folder, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT, creationflags=flags, start_new_session=os.name != "nt")
        jid = uuid.uuid4().hex
        job = {"id": jid, "repo": repo["id"], "project": repo["name"], "provider": provider,
               "prompt": prompt.strip(), "state": "running", "startedAt": now(), "endedAt": None,
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
        try:
            try:
                process.stdin.write(prompt.strip().encode("utf-8"))
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
                    if event.get("thread_id") or event.get("session_id"):
                        job["session"] = event.get("thread_id") or event.get("session_id")
                    item = event.get("item") or {}
                    if item.get("type") == "agent_message":
                        text = item.get("text", "")[:2000]
                    elif event.get("type") == "assistant":
                        text = "\n".join(b.get("text", "") for b in event.get("message", {}).get("content", []) if b.get("type") == "text")[:2000]
                    elif event.get("type") == "result":
                        text = str(event.get("result") or event.get("subtype", ""))[:2000]
                    else:
                        text = event.get("type", "Agent activity") + (" · " + item.get("type", "") if item else "")
                except (ValueError, TypeError, AttributeError):
                    pass
                if text:
                    with _lock:
                        job["output"].append({"at": now(), "text": text})
        finally:
            code = process.wait()
            process.stdout.close()
            with _lock:
                job.update(state="stopped" if job["state"] == "stopping" else "completed" if code == 0 else "failed",
                           exitCode=code, endedAt=now())
                _processes.pop(jid, None)
                config.write_json(config.LOCAL / "work-history.json", snapshot())
            from . import session_index
            session_index.invalidate()
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
