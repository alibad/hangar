"""AI Router -> BeTenshi Requests view.

LiteLLM knows things nothing else does: which model actually served a call, how
long it took, and what it cost. Without this bridge every router call is either
invisible (cloud providers never touch a local service) or indistinguishable
(one "ai-router" row for GPT, Claude, Gemini and the local models alike).

Wired via `litellm_settings.callbacks` in ai-router.yaml.

Best-effort by construction: every hook is wrapped and the POST runs on a daemon
thread with a short timeout, so the console being down can never slow down or
fail an inference call.
"""

import json
import os
import threading
import urllib.request
from collections import OrderedDict

from litellm.integrations.custom_logger import CustomLogger

TRAFFIC_URL = os.environ.get("BETENSHI_TRAFFIC_URL", "http://localhost:8003/api/traffic")

# ── Fire once per call, not once per handler ────────────────────────────────
# LiteLLM invokes BOTH the sync and the async handler for the same event on some
# paths. Observed on failures: every 500 arrived as two rows with an identical
# timestamp AND identical latency, which reads as "it failed twice". Which
# handler fires depends on the call path, so dropping one pair isn't safe —
# dedupe on the call id instead.
_SEEN_MAX = 512
_seen_lock = threading.Lock()
_seen: "OrderedDict[str, None]" = OrderedDict()


def _first_time(call_id) -> bool:
    if not isinstance(call_id, str) or not call_id:
        return True  # nothing to key on — a duplicate row beats a missing one
    with _seen_lock:
        if call_id in _seen:
            return False
        _seen[call_id] = None
        while len(_seen) > _SEEN_MAX:
            _seen.popitem(last=False)  # bounded: this runs for the process's life
    return True


def _post(event: dict) -> None:
    def send():
        try:
            urllib.request.urlopen(
                urllib.request.Request(
                    TRAFFIC_URL,
                    data=json.dumps(event).encode(),
                    headers={"Content-Type": "application/json"},
                    method="POST",
                ),
                timeout=2,
            )
        except Exception:
            pass  # visibility must never break inference

    threading.Thread(target=send, daemon=True).start()


def _path_for(call_type: str) -> str:
    ct = (call_type or "").lower()
    if "image" in ct:
        return "/v1/images/generations"
    if "transcription" in ct:
        return "/v1/audio/transcriptions"
    if "speech" in ct:
        return "/v1/audio/speech"
    if "embedding" in ct:
        return "/v1/embeddings"
    return "/v1/chat/completions"


def _caller(params: dict, meta: dict) -> str | None:
    """Who asked for this. Callers set X-Source; the proxy keeps the raw headers
    on `litellm_params.proxy_server_request` (NOT under metadata — that nesting
    silently yields nothing). `metadata` is checked as a fallback in case a
    future version moves it."""
    for src in (params, meta):
        try:
            req = (src or {}).get("proxy_server_request") or {}
            headers = {k.lower(): v for k, v in (req.get("headers") or {}).items()}
            hit = headers.get("x-source")
            if hit:
                return hit
        except Exception:
            continue
    # `user` is the OpenAI-standard way to self-identify when headers can't be set.
    try:
        body = ((params or {}).get("proxy_server_request") or {}).get("body") or {}
        if isinstance(body.get("user"), str) and body["user"]:
            return body["user"]
    except Exception:
        pass
    return None


# How much prompt/completion text to ship to the console.
#
# This is a MEMORY budget, not a display choice: the console keeps these in a
# bounded in-memory ring. The UI decides how much to show, but it can only ever
# show what arrives here.
#
# It was 300, with an ellipsis glued on. That is a caption, not a record — every
# real agent prompt was cut mid-sentence, and the detail panel had nothing to
# expand to because the rest of the text never left this process. The console
# reports the original length alongside the text, so when this cap does bite it
# can say how much is missing rather than trailing off.
_TEXT_MAX = 8000


def _prompt_text(kwargs):
    """The caller's side of the request: the latest user message, or the image
    prompt. Returns (text, original_length), both None if there is nothing.

    Whitespace is no longer collapsed. Folding a multi-line agent prompt onto
    one line was harmless at 300 characters and destroys readability at 8000 —
    the detail panel renders it pre-wrapped, so the structure survives.
    """
    try:
        for m in reversed(kwargs.get("messages") or []):
            if m.get("role") != "user":
                continue
            c = m.get("content")
            if isinstance(c, list):  # multimodal parts
                c = "\n".join(p.get("text", "") for p in c if isinstance(p, dict))
            if isinstance(c, str) and c.strip():
                s = c.strip()
                return s[:_TEXT_MAX], len(s)
        # image endpoints carry a prompt instead of messages
        p = kwargs.get("prompt")
        if isinstance(p, str) and p.strip():
            s = p.strip()
            return s[:_TEXT_MAX], len(s)
    except Exception:
        pass
    return None, None


def _completion_text(response_obj):
    """What came back. Returns (text, original_length).

    The success hook is handed the completion object, so a router row can show
    the reply directly. Without this the console fell back to its generic
    previewer, which re-fetches a URL to show a body — and correctly refuses to
    do that for a POST, since re-sending one could repeat the action. So every
    chat completion displayed "not previewed" while the text had been sitting
    right here, unread, at log time.
    """
    try:
        choices = getattr(response_obj, "choices", None)
        if choices is None and isinstance(response_obj, dict):
            choices = response_obj.get("choices")
        if not choices:
            return None, None

        first = choices[0]
        msg = getattr(first, "message", None)
        if msg is None and isinstance(first, dict):
            msg = first.get("message")

        parts = []
        if msg is not None:
            get = (lambda k: msg.get(k)) if isinstance(msg, dict) else (lambda k: getattr(msg, k, None))
            # A reasoning model splits its answer across two fields; showing only
            # `content` would render an empty reply for a model that thought its
            # whole budget away.
            for key in ("reasoning_content", "content"):
                v = get(key)
                if isinstance(v, str) and v.strip():
                    parts.append(v.strip())
            # When the model chose to call a tool, the call IS the reply — and
            # `content` is usually empty, so without this the row looks blank.
            #
            # Rendered by hand as `name(arguments)`. Dumping the objects with
            # `default=str` instead produced the SDK's Python repr —
            # "ChatCompletionMessageToolCall(function=Function(arguments='{}',
            # name='battlefield'), id=..., type='function')" — which buries the
            # two fields anyone actually wants inside constructor noise.
            calls = get("tool_calls")
            if calls:
                rendered = []
                for call in (calls if isinstance(calls, list) else [calls]):
                    fn = getattr(call, "function", None)
                    if fn is None and isinstance(call, dict):
                        fn = call.get("function")
                    if fn is None:
                        continue
                    fget = (lambda k: fn.get(k)) if isinstance(fn, dict) else (lambda k: getattr(fn, k, None))
                    name = fget("name")
                    args = fget("arguments")
                    if not name:
                        continue
                    if not isinstance(args, str):
                        try:
                            args = json.dumps(args, default=str)
                        except Exception:
                            args = str(args)
                    rendered.append(f"→ {name}({args or ''})")
                if rendered:
                    parts.append("\n".join(rendered))

        if not parts:
            # Legacy completions put the text on the choice itself.
            text = getattr(first, "text", None)
            if text is None and isinstance(first, dict):
                text = first.get("text")
            if isinstance(text, str) and text.strip():
                parts.append(text.strip())

        if not parts:
            return None, None
        s = "\n\n".join(parts)
        return s[:_TEXT_MAX], len(s)
    except Exception:
        pass
    return None, None


def _emit(kwargs, response_obj, start_time, end_time, status: int) -> None:
    try:
        if not _first_time(kwargs.get("litellm_call_id")):
            return
        params = kwargs.get("litellm_params") or {}
        meta = params.get("metadata") or {}
        # The alias the caller asked for is what a human recognises; fall back to
        # the resolved vendor id.
        model = meta.get("model_group") or kwargs.get("model") or "unknown"

        ms = None
        if start_time and end_time:
            ms = int((end_time - start_time).total_seconds() * 1000)

        slo = kwargs.get("standard_logging_object") or {}
        cost = kwargs.get("response_cost")
        if cost is None:
            cost = slo.get("response_cost")

        usage = {}
        try:
            u = getattr(response_obj, "usage", None) or (
                response_obj.get("usage") if isinstance(response_obj, dict) else None
            )
            if u is not None:
                get = (lambda k: u.get(k)) if isinstance(u, dict) else (lambda k: getattr(u, k, None))
                usage = {
                    "in": get("prompt_tokens"),
                    "out": get("completion_tokens"),
                }
        except Exception:
            pass

        call_id = kwargs.get("litellm_call_id")
        prompt, prompt_chars = _prompt_text(kwargs)
        answer, answer_chars = _completion_text(response_obj)
        _post({
            "service": "ai-router",
            "method": "POST",
            "path": _path_for(kwargs.get("call_type") or ""),
            "status": status,
            "ms": ms,
            # Same rid as the pre-call event, so this REPLACES the in-flight row
            # instead of appearing beside it.
            "rid": f"router-{call_id}" if call_id else None,
            "pending": False,
            "model": model,
            "costUsd": cost,
            # The transparency payload: who called, what they asked for, what
            # came back, what it consumed. Without these a row is an anonymous
            # billable POST.
            "caller": _caller(params, meta),
            "prompt": prompt,
            "promptChars": prompt_chars,
            "response": answer,
            "responseChars": answer_chars,
            "tokensIn": usage.get("in"),
            "tokensOut": usage.get("out"),
            "error": slo.get("error_str") if status >= 400 else None,
        })
    except Exception:
        pass


def _emit_start(kwargs) -> None:
    """Announce a call before it runs.

    A local image generation holds the GPU for minutes; reporting only on
    completion meant the feed showed nothing while the box was visibly busy.
    Shares `rid` with the finishing event, so the console updates that row in
    place rather than adding a second one.
    """
    try:
        call_id = kwargs.get("litellm_call_id")
        if not call_id:
            return  # nothing to correlate on — the completion event still lands
        params = kwargs.get("litellm_params") or {}
        meta = params.get("metadata") or {}
        prompt, prompt_chars = _prompt_text(kwargs)
        _post({
            "service": "ai-router",
            "method": "POST",
            "path": _path_for(kwargs.get("call_type") or ""),
            "status": None,
            "ms": None,
            "pending": True,
            "rid": f"router-{call_id}",
            "model": meta.get("model_group") or kwargs.get("model") or "unknown",
            "caller": _caller(params, meta),
            "prompt": prompt,
            "promptChars": prompt_chars,
        })
    except Exception:
        pass


class BetenshiTrafficLogger(CustomLogger):
    # Pre-call hooks are what make an in-flight call visible at all. Both the
    # sync and async variants exist because which one fires depends on the call
    # path; _first_time() on the completion side keeps that from double-posting.
    def log_pre_api_call(self, model, messages, kwargs):
        _emit_start(kwargs)

    async def async_log_pre_api_call(self, model, messages, kwargs):
        _emit_start(kwargs)

    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
        _emit(kwargs, response_obj, start_time, end_time, 200)

    async def async_log_failure_event(self, kwargs, response_obj, start_time, end_time):
        _emit(kwargs, response_obj, start_time, end_time, 500)

    def log_success_event(self, kwargs, response_obj, start_time, end_time):
        _emit(kwargs, response_obj, start_time, end_time, 200)

    def log_failure_event(self, kwargs, response_obj, start_time, end_time):
        _emit(kwargs, response_obj, start_time, end_time, 500)


betenshi_logger = BetenshiTrafficLogger()

# `litellm_settings.callbacks` in ai-router.yaml wires success/failure ONLY.
# Pre-call hooks are driven off a different list — litellm_logging.py builds
# `litellm.input_callback + dynamic_input_callbacks` and calls log_pre_api_call
# on those alone. Without this line the hook is defined, never invoked, and the
# in-flight row silently never appears. Verified: registering here is what makes
# a running call visible at all.
try:
    import litellm as _litellm

    if betenshi_logger not in _litellm.input_callback:
        _litellm.input_callback.append(betenshi_logger)
except Exception:
    pass  # completion events still land; only the in-flight row is lost
