"""Project architecture drawings: a coding agent reads the project, Archify checks and renders it.

The agent only reads. It replies with an Archify candidate; Hangar saves the candidate and
runs Archify's own gates, and asks the agent for a fix when a gate fails. A new drawing
replaces the previous one only after it passes. Drawings describe private code, so they
stay in local engine storage.
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import threading
from datetime import datetime, timezone
from pathlib import Path

from . import config, launch, work
from .insights import git

INSTALL = "npx skills add tt-a1i/archify -g"
SKILL_DIRS = (".claude/skills/archify", ".agents/skills/archify", ".codex/skills/archify")
REFERENCES = ("references/authoring-defaults.md", "references/repository-authoring.md",
              "schemas/architecture.schema.json", "schemas/common.schema.json", "examples/web-app.architecture.json")
ROUNDS = 3  # a first draft and two repairs
RULES = ("This task only reads: do not create, edit or delete any file, and do not run commands that change anything.\n"
         "Reply with the complete candidate in one ```json block and nothing else: schema_version 1, diagram_type "
         "\"architecture\", meta.title, meta.quality_profile \"showcase\", meta.locale \"en\", components with pos and size, "
         "labelled connections, and repository-relative sources (path, line, end_line) on each key component. "
         "Keep the canvas readable on a laptop: start near [40, 40], keep every component's x + width within 1150 (frames and labels add margin), and add "
         "rows rather than columns when it gets crowded. Show the main journey and the pieces that matter; leave minor "
         "helpers out rather than crossing lines over each other. Cards explain the system to a reader: never describe "
         "how you drew or repaired the drawing, what you ran, or the state of the working tree. "
         "Hangar sets meta.output and meta.repository itself.")

_lock = threading.Lock()
_drawing = {}


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def archify():
    """The Archify skill folder on this machine, or None."""
    env = os.environ.get("HANGAR_ARCHIFY")
    bases = [Path(env)] if env else [Path.home() / d for d in SKILL_DIRS]
    return next((b for b in bases if (b / "bin" / "archify.mjs").is_file()), None)


def storage(rid):
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", rid)[:60].strip("-.") or "project"
    return config.LOCAL / "architecture" / f"{slug}-{hashlib.sha256(rid.encode()).hexdigest()[:10]}"


def github_url(repo):
    url = repo.get("url") or ""
    return url if re.fullmatch(r"https://github\.com/[\w.-]+/[\w.-]+", url) else None


def prompt(folder, skill, previous=None, problems=None):
    refs = "\n".join(f"- {skill / ref}" for ref in REFERENCES)
    if previous is not None:
        return (f"Archify rejected this architecture candidate for the project at {folder}.\n\nDiagnostics:\n{problems}\n\n"
                f"Candidate:\n```json\n{json.dumps(previous, indent=1)}\n```\n\nFix what the diagnostics name and keep the meaning "
                f"and sources. The Archify references are:\n{refs}\n\n{RULES}")
    return (f"Draw the architecture of the project at {folder} as an Archify candidate.\n\n"
            f"1. Read these Archify references first:\n{refs}\n"
            "2. Inspect the project's source. Trace its main runtime pieces and how they connect: entry points, services, "
            "stores, external systems and the main user journey.\n3. " + RULES)


def candidate(text):
    """The architecture candidate in an agent's reply: the last JSON block that is one."""
    blocks = re.findall(r"```(?:json)?[ \t]*\r?\n(.*?)\r?\n```", text or "", re.S) or [text or ""]
    for raw in reversed(blocks):
        try:
            data = json.loads(raw)
        except ValueError:
            continue
        if isinstance(data, dict) and data.get("diagram_type") == "architecture" and isinstance(data.get("meta"), dict):
            return data
    raise ValueError("The agent did not reply with an Archify architecture candidate.")


def prepare(data, url, revision):
    """Pin what Hangar knows for certain; the agent does not decide where files go."""
    meta = data["meta"]
    meta["output"] = "diagram.html"
    if meta.get("quality_profile") not in ("showcase", "standard"):
        meta["quality_profile"] = "showcase"
    if url and revision:
        meta["repository"] = {"url": url, "revision": revision, "provider": "github", "link_mode": "web"}
    else:
        meta.pop("repository", None)
    return data


def problems(result):
    lines = [f"Failed gate: {result.get('failedStage') or 'unknown'}"]
    for d in (result.get("diagnostics") or [])[:8]:
        fixes = "; ".join(d.get("supportedFixes") or [])
        evidence = {k: v for k, v in (d.get("evidence") or {}).items() if k in ("owner", "viewBoxWidth", "text", "projectedFontPx", "path", "line")}
        lines.append(f"- {d.get('code')}: {d.get('message')}" + (f" Evidence: {json.dumps(evidence)[:300]}" if evidence else "")
                     + (f" Fix: {fixes}" if fixes else ""))
    return "\n".join(lines)[:4000]


def check(data, folder, out, skill):
    """Run Archify's gates on a candidate. Returns None when it passed, else the diagnostics."""
    node = shutil.which("node")
    if not node:
        return "Node.js is not installed on this machine, so Archify cannot run."
    draft = out / "draft"
    shutil.rmtree(draft, ignore_errors=True)
    draft.mkdir(parents=True)
    (draft / "candidate.json").write_text(json.dumps(data, indent=1), encoding="utf-8")
    try:
        run = subprocess.run([node, str(skill / "bin" / "archify.mjs"), "finalize", "architecture", "candidate.json", "diagram.html",
                              "--repo-root", str(folder), "--quality", data["meta"]["quality_profile"], "--json"],
                             cwd=draft, stdin=subprocess.DEVNULL, capture_output=True, timeout=420, encoding="utf-8", errors="replace",
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except subprocess.TimeoutExpired:
        return "Archify's checks did not finish within seven minutes."
    try:
        result = json.loads(run.stdout[run.stdout.index("{"):])
    except ValueError:
        return f"Archify did not report a result: {(run.stderr or run.stdout).strip()[:600]}"
    if result.get("ok") and (draft / "diagram.html").is_file():
        return None
    return problems(result)


def publish(out, data, provider, revision):
    draft = out / "draft"
    os.replace(draft / "diagram.html", out / "diagram.html")
    os.replace(draft / "candidate.json", out / "candidate.json")
    shutil.rmtree(draft, ignore_errors=True)
    config.write_json(out / "meta.json", {"title": data["meta"].get("title"), "drawnAt": now(), "provider": provider,
                                          "revision": revision, "components": len(data.get("components") or [])})


def set_state(rid, **fields):
    with _lock:
        _drawing[rid] = {**_drawing.get(rid, {}), **fields, "updatedAt": now()}


def launch_round(doc, overlay, task):
    text = prompt(task["folder"], task["skill"], task.get("previous"), task.get("problems"))
    # Set before starting: an agent that fails at once reports back before begin() returns.
    set_state(task["repo"], state="drawing", round=task["round"], job=None, provider=task["provider"], message=None,
              problems=task.get("problems"))
    try:
        started = work.begin(doc, overlay, task["repo"], task["provider"], text, kind="architecture",
                             read_dirs=[task["skill"]], label=f"Draw the architecture with Archify (round {task['round']} of {ROUNDS})",
                             on_finish=lambda job, reply: finish(doc, overlay, task, job, reply))
    except ValueError:
        with _lock:
            _drawing.pop(task["repo"], None)
        raise
    with _lock:
        if _drawing[task["repo"]].get("round") == task["round"]:
            _drawing[task["repo"]]["job"] = started["id"]
    return started


def finish(doc, overlay, task, job, reply):
    try:
        conclude(doc, overlay, task, job, reply)
    except Exception as error:  # a crashed check must not leave the drawing looking busy forever
        set_state(task["repo"], state="failed", message=f"Hangar could not finish the drawing: {error}")


def conclude(doc, overlay, task, job, reply):
    rid, out = task["repo"], storage(task["repo"])
    if job["state"] != "completed":
        failed = " ".join(o["text"] for o in job["output"])
        return set_state(rid, state="failed", message=work.sign_in_hint(failed) or "The agent stopped before replying with a drawing.")
    set_state(rid, state="checking")
    try:
        data = prepare(candidate(reply), task["url"], task["revision"])
    except ValueError as error:
        return set_state(rid, state="failed", message=str(error))
    issues = check(data, task["folder"], out, task["skill"])
    if issues is None:
        publish(out, data, task["provider"], task["revision"])
        work.note(job["id"], "Archify checks passed. The drawing is ready.")
        return set_state(rid, state="ready", message=None, problems=None)
    if task["round"] >= ROUNDS or "Node.js" in issues:
        work.note(job["id"], "Archify checks still fail after the last repair.")
        return set_state(rid, state="failed", message=issues)
    work.note(job["id"], f"Archify found problems; asking the agent for a fix (round {task['round'] + 1} of {ROUNDS}).")
    try:
        launch_round(doc, overlay, {**task, "round": task["round"] + 1, "previous": data, "problems": issues})
    except ValueError as error:
        set_state(rid, state="failed", message=str(error))


def start(doc, overlay, body):
    skill = archify()
    if not skill:
        raise ValueError(f"Archify is not installed on this machine. Install it with: {INSTALL}")
    provider = body.get("provider")
    if provider not in ("claude", "codex"):
        raise ValueError("Choose Claude or Codex to draw the architecture.")
    repo, folder = work.checkout(doc, overlay, body.get("repo"))
    with _lock:
        if _drawing.get(repo["id"], {}).get("state") in ("drawing", "checking"):
            raise ValueError("This project's architecture is already being drawn.")
    revision = git(folder, "rev-parse", "HEAD").strip()
    task = {"repo": repo["id"], "folder": folder, "skill": skill, "provider": provider, "round": 1,
            "url": github_url(repo), "revision": revision if re.fullmatch(r"[0-9a-f]{40}", revision) else None}
    return launch_round(doc, overlay, task)


def status(doc, overlay, rid):
    out = storage(rid)
    meta = config.read_json(out / "meta.json", None) if (out / "diagram.html").is_file() else None
    try:
        _, folder = work.checkout(doc, overlay, rid)
    except ValueError:
        folder = None
    behind = None
    if meta and folder and meta.get("revision"):
        count = git(folder, "rev-list", "--count", f"{meta['revision']}..HEAD").strip()
        behind = int(count) if count.isdigit() else None
    with _lock:
        drawing = dict(_drawing.get(rid) or {}) or None
    return {"archify": archify() is not None, "install": INSTALL, "checkout": folder is not None,
            "agents": [p for p in ("claude", "codex") if launch.cli(p)], "signedOut": work.signed_out(),
            "diagram": meta, "behind": behind, "drawing": drawing}


def view(rid):
    path = storage(rid) / "diagram.html"
    return path.read_bytes() if path.is_file() else None
