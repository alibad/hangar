# `POST /api/decide`

One typed decision: a question, the allowed answers, and the thing being
decided about → a probability for every answer. Served by the console
(`http://localhost:8003`), answered by a decision model on this box (Laya) or,
on request, by any LLM the AI Router knows, in the same shape.

Callers: the Decision Lab, the MCP `decide` tool, and the BPMN decision gateways
(brief 06). Which model to trust for which decision is in
[decision-model-experiment-2026-09-27.md](decision-model-experiment-2026-09-27.md).

## Request

```json
{
  "question": "What kind of feedback is this?",
  "choices": {
    "bug": "something is broken",
    "feature_request": "asks for something new",
    "noise": "a test, spam, or nothing actionable"
  },
  "type": "choice",
  "context": "Clicking 'Start quest' does nothing, no error.",
  "model": "laya"
}
```

| field | | |
|---|---|---|
| `question` | required | What is being decided, as a question. |
| `choices` | required unless `yesno` | A list of labels (`["bug", "noise"]`), or an object of label → what it means. **Descriptions help**: Laya scores each option beside its description. 2 to 64 options, but see *Limits*. |
| `type` | optional | `"choice"` (default), `"yesno"` (choices are ignored; labels are `yes` and `no`), or `"score"` (choices are levels, ordered low → high). |
| `context` | optional | The text being decided about, or a JSON object (sent to Laya as structured state, and pretty-printed for an LLM). |
| `model` | optional | `"laya"` (default: the checkpoint is picked per request by script and language), `"laya-english"`, `"laya-multilingual"`, `"laya-typed-decisions"`, or any router **chat** alias such as `"claude-haiku"` or `"local-gemma4"`. |

`X-Source: <your-app>` tags the call in the console's Requests view.

## Response — 200

```json
{
  "choice": "bug",
  "probabilities": { "bug": 0.91, "feature_request": 0.05, "noise": 0.04 },
  "confidence": 0.91,
  "latencyMs": 41.2,
  "modelLatencyMs": 33.8,
  "model": "laya",
  "local": true,
  "checkpoint": "english",
  "routingReason": "…",
  "costUsd": null
}
```

- `probabilities` always has **every** label, and sums to 1.
- `confidence` is the probability of `choice`. Gate on it: act above a
  threshold, send the rest to a person or a bigger model.
- `latencyMs` is wall-clock for the whole call. `modelLatencyMs`, for decision
  models only, is the forward pass alone.
- `costUsd` is the router's figure for a cloud LLM, and `null` for anything
  local ("not metered", not "free").
- LLMs only: `parsed: false` means the reply was not the requested JSON and the
  distribution is a fallback (one-hot on the first label named, or uniform).
  Treat it as low confidence whatever `confidence` says.
- `score` questions from Laya also return `score`, the expected level (0-based).

## Errors

The body is always `{ "error": "<a sentence>" }`.

| status | meaning |
|---|---|
| 400 | The request is malformed; the sentence says which field. |
| 404 | No service on this host serves that decision model. |
| 503 | The decision service is not running, or is still loading its checkpoints (about 15 s from start). Start it: Services → *Laya decisions*, or the MCP tool `start_service("laya")`. |
| 409 | LLM path only: the resource coordinator refused to load a local model; the body has `resourceBlocked: true`. |
| 502 | The model failed or timed out. |

## Limits worth knowing

- **Many options.** Laya's option texts share a fixed token budget, and the
  vendor's own benchmark shows accuracy collapsing above ~20 options (Banking77:
  0.425). Keep a decision to a handful of options, or split it into two.
- **Laya is zero-shot here.** The shipped checkpoints were not trained on these
  decisions. The experiment doc says, per use case, whether that is good enough.
- **Context length.** 512 tokens per question for the English checkpoint,
  1,024 for multilingual. Longer context is cut off without an error.
- **Not recorded.** `/api/decide` does not write to the Lab runs record, so a
  process engine calling it per item does not bury the Lab's history. The
  Decision Lab records its own runs through `/api/labs/decide/run`.
- **Local only.** The Laya service binds 127.0.0.1 and has no auth, like the AI
  Router. Cloud projects must not call this.

`GET /api/decide` returns this host's decision models and the shape above as JSON.
The contract in code is `src/lib/decide.ts`.
