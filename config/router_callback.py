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


def _prompt_preview(kwargs) -> str | None:
    """First user message, truncated. Turns an anonymous billable POST into
    something you can recognise without storing whole conversations."""
    try:
        for m in reversed(kwargs.get("messages") or []):
            if m.get("role") != "user":
                continue
            c = m.get("content")
            if isinstance(c, list):  # multimodal parts
                c = " ".join(p.get("text", "") for p in c if isinstance(p, dict))
            if isinstance(c, str) and c.strip():
                s = " ".join(c.split())
                return s[:300] + ("…" if len(s) > 300 else "")
        # image endpoints carry a prompt instead of messages
        p = kwargs.get("prompt")
        if isinstance(p, str) and p.strip():
            s = " ".join(p.split())
            return s[:300] + ("…" if len(s) > 300 else "")
    except Exception:
        pass
    return None


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
            # The transparency payload: who called, what they asked for, what it
            # consumed. Without these a row is an anonymous billable POST.
            "caller": _caller(params, meta),
            "prompt": _prompt_preview(kwargs),
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
            "prompt": _prompt_preview(kwargs),
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
