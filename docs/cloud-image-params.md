# Cloud image parameters — 3 October 2026

The Image Studio sent hosted image models `prompt`, `size` and `n: 1`, nothing else.
It now sends every parameter each model accepts, validated per model, through the
AI Router. This page records what each model takes, what the router actually
forwards, and what was proven with real calls.

- Source of truth in code: [`src/lib/cloud-image-models.ts`](../src/lib/cloud-image-models.ts)
  (the server validates against it, the Studio draws its controls from it).
- Wire format and response handling: [`src/lib/cloud-image-gen.ts`](../src/lib/cloud-image-gen.ts);
  run + save: [`src/lib/cloud-image-run.ts`](../src/lib/cloud-image-run.ts).
- Re-run the billable proof: `node scripts/verify-cloud-image-params.mjs` (temp gallery and DuckDB, X-Source `console/cloud-image-params-test`).
- Unit tests: `scripts/cloud-image-params.test.mjs` (registry, forwarding against a mocked router, the multipart builder, non-PNG saving).

## Summary

| Question | Answer |
| --- | --- |
| Does the console send every parameter? | Yes, for every OpenAI parameter that changes the image, and for Gemini aspect ratio, resolution and Search grounding. A few are not exposed on purpose (see the end of this page). |
| Does the router forward them? | **Generations: yes, but only when they are nested in `extra_body`.** LiteLLM 1.94.0 silently drops `background`, `moderation`, `output_format` and `output_compression` at the top level. The console nests them. **Edits: it drops `moderation`, `output_format` and `output_compression` whatever you do.** A router patch is ready and needs a restart (see [Router change](#router-change-needs-a-restart)). |
| Proven with real calls? | All OpenAI parameters: 11 of 12 cases passed; the 12th found that gpt-image-2 refuses transparency. Gemini: **no**. This box's Gemini key is on the free tier, whose image quota is 0, so every Gemini image call returns 429. |
| Spend | **$0.104** in total: $0.100 on 15 billable calls tagged `console/cloud-image-params-test`, plus one $0.0037 call from the Studio UI tagged `console/image-studio`. Refused calls cost nothing. |

## What each model accepts

The table was read from the vendors' own docs on 2026-10-03, and **bold** marks what real calls changed or confirmed.

Docs:
- OpenAI [guide](https://developers.openai.com/api/docs/guides/image-generation) and [API reference](https://developers.openai.com/api/reference/resources/images); model pages at `https://developers.openai.com/api/docs/models/<id>`.
- Google [image generation](https://ai.google.dev/gemini-api/docs/generate-content/image-generation) and [pricing](https://ai.google.dev/gemini-api/docs/pricing); model pages at `https://ai.google.dev/gemini-api/docs/models/<id>`.

### OpenAI (router aliases = vendor ids)

**Parameters every GPT image model shares:**
- `moderation`: auto or low.
- `output_format`: png, jpeg or webp.
- `output_compression`: 0–100, jpeg/webp only, default 100. **Measured: it acts as a quality level.** The same webp prompt came back at 48 KB at 5 and 310 KB at 95, despite the docs' "compress by N%".
- `n`: 1–10.
- Edits:
  - up to 16 reference images (`image[]`);
  - an optional `mask`: a PNG with alpha, the size of the first image. It guides the edit and is not a hard boundary.
- Prompt: up to 32,000 characters.

| Model | quality | size | transparent background | input_fidelity (edits) | $ / 1M image out |
| --- | --- | --- | --- | --- | --- |
| [gpt-image-2.5-sunburst](https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst) | auto, low, medium, high, **xhigh, max** | auto or custom WxH | yes | not documented, so not sent | 30 |
| [gpt-image-2.5-flare](https://developers.openai.com/api/docs/models/gpt-image-2.5-flare) | same as Sunburst (**xhigh measured**) | auto or custom (**1536x864 measured**) | **yes (measured)** | not documented, so not sent | 30 |
| [gpt-image-2](https://developers.openai.com/api/docs/models/gpt-image-2) | auto, low, medium, high | auto or custom WxH | **no.** The real API answers 400 "Transparent background is not supported for this model"; the docs only call it a Responses-tool preview | must be omitted (always high) | 30 |
| [gpt-image-1.5](https://developers.openai.com/api/docs/models/gpt-image-1.5) | auto, low, medium, high | auto, 1024x1024, 1536x1024, 1024x1536 | yes | low (default), high | 32 |
| [chatgpt-image-latest](https://developers.openai.com/api/docs/models/chatgpt-image-latest) | auto, low, medium, high | 3 fixed + auto | yes | not listed, so not sent | 32 |
| [gpt-image-1](https://developers.openai.com/api/docs/models/gpt-image-1) | auto, low, medium, high | 3 fixed + auto | yes | low (default), high | 40 |
| [gpt-image-1-mini](https://developers.openai.com/api/docs/models/gpt-image-1-mini) | auto, low, medium, high | 3 fixed + auto | **yes (measured)** | low only, so not sent | 8 |

**Custom sizes** (2.5 and gpt-image-2) must meet all of these:
- both edges are multiples of 16;
- aspect ratio between 1:3 and 3:1;
- no edge longer than 3840 px;
- between 655,360 and 8,294,400 pixels in total.

Sizes above 2560x1440 are labelled "experimental". The console validates all of these before sending. Callers that ask for pixels instead of a size (Compare's 768², old clients) are snapped to the nearest valid size, with a warning.

**Price estimates** are output image tokens × the model's rate:
- gpt-image-2 and 2.5 use OpenAI's calculator formula, which matched the real bills exactly: **1,700 tokens** for flare xhigh at 1024x640, **120** for flare low at 1536x864.
- The older models use OpenAI's token table: **272** tokens for low and **1,056** for medium at 1024², measured on gpt-image-1-mini. The guide's per-image table says $0.005 for 1-mini at low, but neither the rate nor the bill reproduces that; both give $0.0022.
- A 1024² reference image cost **1,024 input image tokens** at low fidelity.

**Refusals:**
- OpenAI returns HTTP 400 with `code: moderation_blocked`. The console turns this into a message suggesting fictional or game-art framing.
- Gemini answers a blocked prompt with no image at all, and the console says so.

### Gemini (router aliases → vendor ids)

None of these models takes quality, background, format, compression or moderation. The Gemini API has no output compression, and its only MIME option, JPEG via `responseFormat`, cannot pass through the router.

| Alias → model | aspect ratios | resolution | references | Search grounding | price per image |
| --- | --- | --- | --- | --- | --- |
| `gemini-image` → [gemini-3-pro-image](https://ai.google.dev/gemini-api/docs/models/gemini-3-pro-image) | 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9 | 1K, 2K, 4K | 14 (6 objects, 5 characters, 3 style) | yes | $0.134 (1K/2K), $0.24 (4K) |
| `nano-banana-pro-preview` | same as 3 Pro | same | same | yes | same. **Undocumented id** (its model page 404s); treated as 3 Pro |
| `gemini-image-fast` → [gemini-3.1-flash-image](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-image) | those 10 plus 1:4, 4:1, 1:8, 8:1 | 512, 1K, 2K, 4K | 14 (10 objects, 4 characters) | yes | $0.045 / 0.067 / 0.101 / 0.151 |
| `gemini-3.1-flash-lite-image` → [model](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite-image) | 14 | 1K only | 14 (not optimised for several) | no | $0.0336 |
| `gemini-2.5-flash-image` → [model](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-image) | 10 | none (~1024 px) | 3 | no | $0.039. **Deprecated: shutdown listed for 2 Oct 2026** |

Notes on the Gemini models:
- `n` is limited to 1. The router maps `n` to `candidateCount`, but Google documents no count above 1 for image models, and this could not be measured here.
- There is no mask. Describe the region in the prompt.
- Grounding: 5,000 searches a month are free, then $14 per 1,000.

## What LiteLLM 1.94.0 forwards

**How it was measured.** Two methods:
1. Reading the installed source (`litellm/images/main.py`, `utils.get_optional_params_image_gen`, `llms/openai/image_generation/gpt_transformation.py`, `llms/openai/image_edit/transformation.py`, `llms/gemini/common_utils.py`, `llms/gemini/image_edit/transformation.py`).
2. Throwaway LiteLLM 1.94.0 proxies on ports 4096, 4097 and 4099, pointed at an echo server that logs exactly what arrives upstream. The real router was never touched.

Negative controls on the **real** router then confirmed both behaviours.

| Path | Parameter | Forwarded? | Proof |
| --- | --- | --- | --- |
| generations | `n`, `quality`, `size`, `user` | yes | echo |
| generations | `background`, `moderation`, `output_format`, `output_compression` at the top level | **dropped silently** | echo. Real router: `background: "bogus"` + `output_format: "webp"` returned **200 and a PNG**, billed $0.0022 |
| generations | the same four inside `extra_body` | **yes** | echo. Real router: `extra_body.moderation: "bogus"` returned OpenAI's own 400, "Supported values are: 'auto' and 'low'" |
| generations | unknown params (`partial_images`, `stream`, `negative_prompt`) | yes, verbatim (why local knobs used to 400 OpenAI) | echo |
| generations | `response_format` | dropped (GPT image models always return base64 anyway) | echo |
| edits | `image[]` ×N, `mask`, `n`, `quality`, `size`, `background`, `input_fidelity`, `user` | yes | echo. Real router: `background: "bogus"` on an edit returned OpenAI's 400 |
| edits | `moderation`, `output_format`, `output_compression` | **dropped silently. No workaround**: `extra_body` is ignored on this path | echo. Real router: `moderation: "bogus"` + `output_format: "webp"` returned **200 and a PNG** |
| Gemini generations | `n` → `candidateCount`; `size` → imageConfig; `imageConfig` verbatim; `web_search_options` → `tools: [{googleSearch: {}}]` | yes | echo |
| Gemini generations | `thinkingConfig`, `safetySettings`, OpenAI-only params | dropped | echo |
| Gemini edits | images as `inlineData` parts, `imageConfig` (JSON string, parsed), `n` (sent as a string) | yes. `mask` and grounding are dropped | echo |
| any | `X-Source` | forwarded upstream and logged as the caller in Activity | real router |
| any | per-call price | the `x-litellm-response-cost` response header, which the console reads and stores | real router |

**`allowed_openai_params` cannot fix the drops.** Both image entry points strip it as a LiteLLM-internal param before it is ever read.

**What the console does:**
- **Generations:** it nests the four params in `extra_body`, so they work today without a router change.
- **Edits:**
  - The four params are still sent; the router will forward them once patched.
  - When the returned bytes are not the requested format, the console transcodes the image itself and records `transcoded: true`, which the details panel shows as "converted by the console".
  - `moderation: low` on an edit is not applied until the patch is live. The edit form says so.

## Router change (needs a restart)

[`config/router_image_params.py`](../config/router_image_params.py) is loaded by `config/router_callback.py` at router start. **No YAML change is needed.** It patches two code paths:
- **Generations:** top-level `background`, `moderation`, `output_format` and `output_compression` are moved into `extra_body` for OpenAI and Azure. An explicit `extra_body` value wins. This fixes other callers on the box too.
- **Edits:** `ImageEditOptionalRequestParams` and `OpenAIImageEditConfig` learn `moderation`, `output_format` and `output_compression`.

Every patch is guarded: if a LiteLLM upgrade moves these internals, the router runs unpatched and logs one line; it does not fail.

Verification on a throwaway proxy, loaded both directly and via `router_callback.py`: all of these now reach the echo server:
- generations: top-level `background`, `moderation`, `output_format` and `output_compression`;
- edits: `moderation`, `output_format` and `output_compression`.

Gemini requests were unchanged.

The same restart also picks up a callback fix. Activity used to log hosted edits as `/v1/images/generations` with 0 tokens, because edit usage arrives as `input_tokens`/`output_tokens`.

## Verification through the real router

Calls went through the console's own code path (`runCloudImage`) into a temp gallery and DuckDB, with X-Source `console/cloud-image-params-test` and the cheapest quality.

The costs below are the router's `x-litellm-response-cost`. Activity (`/api/traffic` on :8003) lists every call under that caller. `/api/router-usage` caps its caller list at 12, so the test caller does not appear there.

| Case | Model | Result | Cost |
| --- | --- | --- | --- |
| transparent background | gpt-image-1-mini, png | PASS: alpha channel, 61.5% of pixels transparent | $0.0022 |
| webp | gpt-image-1-mini, compression 60 | PASS: `RIFF…WEBP` magic, saved `.webp`, provider says webp | $0.0022 |
| jpeg | gpt-image-1-mini, compression 70 | PASS: `FF D8 FF` magic, saved `.jpg` | $0.0022 |
| n = 2 | gpt-image-1-mini | PASS: two images, two files, no name collision | $0.0044 |
| quality changes usage | gpt-image-1-mini low → medium | PASS: 272 → 1,056 output tokens; provider echoes `quality: medium` | $0.0022 + $0.0085 |
| moderation: low | gpt-image-1-mini | PASS: accepted, and forwarded (see the negative control above) | $0.0022 |
| edit, 2 references | gpt-image-1-mini, a webp and a jpeg as references | PASS: one image from both. 2,048 input image tokens. Webp output **transcoded** (router dropped it) | $0.0063 |
| edit with mask | gpt-image-1-mini | PASS | $0.0043 |
| custom size + webp | gpt-image-2.5-flare 1536x864 | PASS: 1536x864 webp | $0.0037 |
| xhigh quality | gpt-image-2.5-flare 1024x640 | PASS: provider echoes `xhigh`, 1,700 tokens | $0.0511 |
| transparent | gpt-image-2 | **FAIL (finding)**: 400 "Transparent background is not supported". The registry no longer offers it | $0 |
| compression semantics | gpt-image-1-mini webp at 5 and at 95 | 48 KB and 310 KB: a quality level | $0.0044 |
| negative controls | see the forwarding table | 2 refused (free), 2 billed | $0.0064 |
| Gemini, all 3 aliases tried | 3.1 flash lite, 3.1 flash, 3 pro | 429: free-tier image quota is 0 | $0 |
| UI smoke test (Studio, `console/image-studio`) | gpt-image-2.5-flare, transparent webp 1536x864 | rendered over the checkerboard. Details panel and Recreate work | $0.0037 |

## Not exposed, and why

- `stream` / `partial_images`: the Studio saves finished images, and each partial costs 100 output tokens.
- `response_format`: legacy, because GPT image models always return base64.
- `user`: an end-user id for abuse monitoring, meaningless on a single-user box.
- `style`: DALL·E only.
- Gemini:
  - `thinkingLevel`, `safetySettings` and image-search grounding: the router does not forward them.
  - Person-generation controls: Vertex only.
- **Batch** stays local-only: its queue dispatches across local services and has no cloud path.
- **DuckDB schema** is unchanged. The full parameter set, what was sent, the provider's echo, usage and cost live in each image's sidecar, served by `/api/qwen/images/meta`.

**Possible schema change, not made:** a `params_json` column on `images` would let the gallery filter by quality, format or cost without opening sidecars.
