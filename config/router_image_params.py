"""Make the AI Router forward every GPT-image parameter OpenAI accepts.

LiteLLM 1.94.0 silently drops four of them (measured against an echo server and
against the real API, 2026-10-03 — docs/cloud-image-params.md):

  /v1/images/generations  background, moderation, output_format,
                          output_compression sent at the top level vanish.
                          They are in the gpt-image config's supported list but
                          not in the image path's default-param list, so
                          get_optional_params_image_gen() neither maps them nor
                          passes them through. A caller can work around it by
                          nesting them in `extra_body` (the console does).
  /v1/images/edits        moderation, output_format, output_compression vanish:
                          the request is filtered through the
                          ImageEditOptionalRequestParams TypedDict, which lacks
                          them, and extra_body is ignored on that path. There
                          is no client-side workaround.

`drop_params: true` makes both silent: a request for a webp edit is billed and
answered with a PNG. `allowed_openai_params` cannot help — the image entry
points strip it as a LiteLLM-internal param before it is ever read.

This module patches both paths at import. It is loaded by router_callback.py,
so it takes effect on the next router start. Every patch is guarded: a LiteLLM
upgrade that moves these internals leaves the router exactly as unpatched
(logged once), never broken. Remove this file once LiteLLM forwards them.
"""

from typing import Optional

GENERATION_PARAMS = ("background", "moderation", "output_format", "output_compression")
EDIT_PARAMS = ("moderation", "output_format", "output_compression")
OPENAI_PROVIDERS = ("openai", "azure")

applied: list[str] = []


def _patch_generations() -> None:
    import litellm.images.main as images_main

    original = images_main.get_optional_params_image_gen
    if getattr(original, "_betenshi_patched", False):
        return

    def get_optional_params_image_gen(*args, **kwargs):
        # Move the four params into extra_body, which the OpenAI path forwards
        # verbatim. An explicit extra_body value from the caller wins.
        if kwargs.get("custom_llm_provider") in OPENAI_PROVIDERS:
            moved = {k: kwargs.pop(k) for k in GENERATION_PARAMS if kwargs.get(k) is not None}
            if moved:
                extra = dict(kwargs.get("extra_body") or {})
                for key, value in moved.items():
                    extra.setdefault(key, value)
                kwargs["extra_body"] = extra
        return original(*args, **kwargs)

    get_optional_params_image_gen._betenshi_patched = True  # type: ignore[attr-defined]
    images_main.get_optional_params_image_gen = get_optional_params_image_gen
    applied.append("generations")


def _patch_edits() -> None:
    from litellm.llms.openai.image_edit.transformation import OpenAIImageEditConfig
    from litellm.types.images.main import ImageEditOptionalRequestParams

    # get_requested_image_edit_optional_param() keeps only the TypedDict's keys.
    hints = ImageEditOptionalRequestParams.__annotations__
    hints.setdefault("moderation", Optional[str])
    hints.setdefault("output_format", Optional[str])
    hints.setdefault("output_compression", Optional[int])

    original = OpenAIImageEditConfig.get_supported_openai_params
    if getattr(original, "_betenshi_patched", False):
        return

    def get_supported_openai_params(self, model: str) -> list:
        supported = list(original(self, model))
        return supported + [p for p in EDIT_PARAMS if p not in supported]

    get_supported_openai_params._betenshi_patched = True  # type: ignore[attr-defined]
    OpenAIImageEditConfig.get_supported_openai_params = get_supported_openai_params
    applied.append("edits")


def apply() -> list[str]:
    for patch in (_patch_generations, _patch_edits):
        try:
            patch()
        except Exception as exc:  # never take the router down over this
            print(f"[router_image_params] {patch.__name__} not applied: {exc!r}")
    return applied


apply()

# Loadable on its own as a LiteLLM callback (`router_image_params.image_params_patch`),
# which is how it was tested on a throwaway proxy without the traffic logger.
try:
    from litellm.integrations.custom_logger import CustomLogger

    image_params_patch = CustomLogger()
except Exception:  # pragma: no cover
    image_params_patch = None
