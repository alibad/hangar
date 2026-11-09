"""What you said in each session, and how you said it: in your own words, by clicking a reply the session offered, or
by starting a side session it proposed.

Step back reads this to tell your direction from the session's. It is the one place Hangar keeps message text, so it is
kept apart from the session index (which never holds any): only your own messages, each cut short, only for the
sessions asked for, in local engine storage. An agent's replies are not kept. Of what a session said, only the question
it ended a turn on, the replies it offered with it, and the side sessions it proposed.

How a message is told apart (Claude Code records who a turn came from; older transcripts fall back to its shape):
  typed     you wrote it
  button    it is word for word a reply the session had just offered
  ack       a short yes ("ok", "go ahead") with nothing of your own in it
  started   you started a side session the session proposed
  stopped   you interrupted the turn
  proposed  the session opened or proposed a side session (by: "session" when it was its own idea)
  brief     the task another session wrote to start this one: not your words
"""
import json
import re
import threading
import time

from . import config, session_index

VERSION = 2
MAX_EVENTS, HEAD = 220, 30
TEXT, ASK, BRIEF, TITLE = 600, 240, 900, 160
KEEP_DAYS = 60
_lock = threading.Lock()

# Lines worth decoding: a person's turn, or a tool call that asks, offers or proposes.
_WANTED = (b'"type":"user"', b"wrap_up", b"start_session", b"AskUserQuestion", b"user_message")
# What an app or a tool wraps around a message; none of it is the person's words.
_TAGS = re.compile(r"<(system-reminder|task-notification|side-sessions-event|ci-monitor-event|scheduled-task|environment_context|"
                   r"user_instructions|command-[a-z-]+|local-command-[a-z-]+)\b[^>]*>.*?</\1>", re.S)
_PASTED = re.compile(r"<(pasted_content|pasted-content)\b[^>]*>.*?</\1>", re.S)
_STARTED = re.compile(r'The user started your (?:proposal|suggested background task) task_\w+ \("([^"\n]{1,300})"')
_ACK = re.compile(r"^(yes|yep|yeah|yup|ok|okay|k|sure|go|go ahead|go for it|do it|do that|do both|continue|proceed|please do|sounds good|"
                  r"looks good|lgtm|perfect|great|approved?|yes please|yes do it|ok do it|okay do it|ship it)[\s.!,]*$", re.I)
# Turn origins that are never the person typing.
_MACHINE = {"sdk", "system", "task_notification", "scheduled", "peer"}


def want(line):
    return any(mark in line for mark in _WANTED)


def fresh(provider, path):
    return {"provider": provider, "id": path.stem, "offset": 0, "events": [], "counts": {}, "offer": None, "asks": {},
            "dropped": 0, "begun": False}


def cut(text, limit):
    text = re.sub(r"\s+", " ", text or "").strip()
    return text[:limit].rstrip() + ("…" if len(text) > limit else "")


def _text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") in ("text", "input_text"))
    return ""


def _add(state, at, kind, **fields):
    state["counts"][kind] = state["counts"].get(kind, 0) + 1
    state["events"].append({"at": at, "k": kind, **{k: v for k, v in fields.items() if v}})
    if len(state["events"]) > MAX_EVENTS:  # a long session keeps how it began and how it is going now
        del state["events"][HEAD]
        state["dropped"] += 1


def _human(record, text):
    """True when this turn is the person's own message."""
    origin = record.get("origin")
    if isinstance(origin, dict):
        return origin.get("kind") == "human"
    turn = record.get("turnOrigin")
    if turn in _MACHINE:
        return False
    if turn == "human" or record.get("promptSource") == "sdk":
        return True
    # A terminal session, or an older app: nothing says who wrote it, so its shape decides.
    return not text.lstrip().startswith(("<", "[", "Caveat:", "Base directory for this skill", "Another Claude session sent"))


def _say(state, at, text):
    """One message of the person's, sorted by how much of it was theirs."""
    for title in _STARTED.findall(text):
        _add(state, at, "started", text=cut(title, TITLE))
    clean = _PASTED.sub(" [pasted text] ", _TAGS.sub(" ", text)).strip()
    if not clean:
        return
    offer, state["offer"] = state.get("offer"), None
    ask = offer["ask"] if offer else ""
    if offer and clean in offer["options"]:
        return _add(state, at, "button", text=cut(clean, TITLE), ask=ask)
    if _ACK.match(clean):
        return _add(state, at, "ack", text=cut(clean, 40), ask=ask)
    _add(state, at, "typed", text=cut(clean, TEXT), ask=ask)


def take(state, record):
    kind = record.get("type")
    at = record.get("timestamp") if isinstance(record.get("timestamp"), str) else None
    payload = record.get("payload")
    if kind == "event_msg" and isinstance(payload, dict):  # Codex
        if payload.get("type") == "user_message" and isinstance(payload.get("message"), str):
            _say(state, at, payload["message"])
        return
    if kind not in ("user", "assistant") or record.get("isSidechain"):
        return
    message = record.get("message") or {}
    content = message.get("content") if isinstance(message, dict) else None
    blocks = content if isinstance(content, list) else []
    if kind == "assistant":
        for block in blocks:
            if not isinstance(block, dict) or block.get("type") != "tool_use":
                continue
            name, args = str(block.get("name") or ""), block.get("input") if isinstance(block.get("input"), dict) else {}
            if name.endswith("wrap_up"):
                actions = args.get("actions")
                if isinstance(actions, str):
                    try:
                        actions = json.loads(actions)
                    except ValueError:
                        actions = []
                labels = [str(a["label"]).strip() for a in actions or [] if isinstance(a, dict) and a.get("label")][:4]
                ask = cut(str(args.get("ask") or ""), ASK)
                state["offer"] = {"ask": ask, "options": labels, "at": at} if ask else None
            elif name == "AskUserQuestion":
                asked = [str(q.get("question") or "") for q in args.get("questions") or [] if isinstance(q, dict)]
                if block.get("id") and asked:
                    state["asks"][block["id"]] = cut(" / ".join(asked), ASK)
                    while len(state["asks"]) > 20:
                        del state["asks"][next(iter(state["asks"]))]
            elif name.endswith("start_session") and args.get("title"):
                mine = args.get("initiation") in ("offer", "user_asked")
                _add(state, at, "proposed", text=cut(str(args["title"]), TITLE), by="you" if mine else "session")
        return
    if record.get("isMeta") or record.get("isCompactSummary"):
        return
    answered = False
    for block in blocks:
        if isinstance(block, dict) and block.get("type") == "tool_result":
            answered = True
            ask = state["asks"].pop(block.get("tool_use_id"), None)
            if ask and not block.get("is_error"):
                _add(state, at, "answered", text=cut(session_index.output_text(block.get("content")), 300), ask=ask)
    if answered:
        return
    text = _text(content)
    if text.lstrip().startswith("[Request interrupted"):  # the app writes this when you stop a turn
        state["offer"] = None
        return _add(state, at, "stopped")
    first, state["begun"] = not state["begun"], True
    if _human(record, text):
        return _say(state, at, text)
    if first:  # a session another session started opens with that session's brief
        brief = _TAGS.sub(" ", text).strip()
        if brief and not brief.startswith(("<", "[")):
            _add(state, at, "brief", text=cut(brief, BRIEF))


def summary(voice):
    """How the person steered one session: turns in their own words against turns that accepted what it offered."""
    counts = (voice or {}).get("counts") or {}
    own = counts.get("typed", 0) + counts.get("stopped", 0) + counts.get("answered", 0)
    accepted = counts.get("button", 0) + counts.get("ack", 0) + counts.get("started", 0)
    its = sum(1 for e in (voice or {}).get("events", []) if e["k"] == "proposed" and e.get("by") == "session")
    return {"own": own, "accepted": accepted, "typed": counts.get("typed", 0), "buttons": counts.get("button", 0),
            "acks": counts.get("ack", 0), "started": counts.get("started", 0), "stopped": counts.get("stopped", 0),
            "proposedByIt": its, "briefed": bool(counts.get("brief")),
            "pending": (voice or {}).get("offer")}


def path():
    return config.LOCAL / "session-voice.json"


def collect(files):
    """{session key: voice} for these transcripts ({key: (path, provider)}), reading only what was appended since the
    last time. Sessions not asked for lately are dropped from the store."""
    from pathlib import Path
    with _lock:
        saved = config.read_json(path(), {}) or {}
        old = saved.get("files", {}) if saved.get("version") == VERSION else {}
        now, kept, out = time.time(), {}, {}
        for key, (file, provider) in files.items():
            try:
                state = session_index.update_file(Path(file), provider, old.get(file), make=fresh, take=take, want=want)
            except OSError:
                continue
            state["askedAt"] = now
            kept[file] = state
            out[key] = state
        for file, state in old.items():
            if file not in kept and now - state.get("askedAt", 0) < KEEP_DAYS * 86400:
                kept[file] = state
        config.write_json(path(), {"version": VERSION, "files": kept})
        return out
