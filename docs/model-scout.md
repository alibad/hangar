# Model scout

Keeps the Models tab aware of models that are **not on this box yet** — the question
`config/model-meta.json` could never answer, because it only describes what is already wired.

Two halves, with different failure modes and different refresh rates.

## 1. Discovery — facts, live, no review needed

`src/lib/model-scout.ts` asks each configured vendor for its own model list:

| Provider  | Endpoint                                                     | Publishes dates? |
| --------- | ------------------------------------------------------------ | ---------------- |
| OpenAI    | `GET https://api.openai.com/v1/models`                        | yes (`created`)  |
| Anthropic | `GET https://api.anthropic.com/v1/models`                     | yes (`created_at`) |
| Gemini    | `GET .../v1beta/models` (ListModels)                          | no               |

Only three claims are ever made from this: **this id exists**, **it shipped on this date**,
and **you have not wired it**. Nothing about quality or price. A model list cannot
hallucinate, which is why this half runs on a timer and needs nobody to check it.

Cached for 15 minutes server-side. A provider with no key set reports `reachable: false`
and an empty list — the same discipline `getCatalogue()` follows, and better than
implying the vendor has shipped nothing.

`supersedes` is a **heuristic** (`familyKey()`): strip version-ish tokens and match what
is left. It catches `claude-opus-4-8` → `claude-opus-5`. It misses `gpt-5.5` →
`gpt-5.6-terra`, because OpenAI puts meaning in tokens that look like words. Misses still
show up under "newer than anything wired here"; they just do not get the stronger label.
It is only ever used to sort a suggestion higher — never to change a route.

## 2. The report — judgment, weekly, versioned in git

`config/model-scout.json`, written by a **Claude routine that runs weekly**. This is the
half that needs a brain: which local checkpoint is worth 20 GB of download, what it
actually needs to run, what it would replace.

It is committed, so `git log config/model-scout.json` is a record of how the landscape
moved. It carries `generatedAt`, and the UI marks it stale after 10 days rather than
silently presenting an old opinion as current.

### What the routine must do

1. Read this file and `config/model-meta.json` (what is already here, and its measured
   footprints) and `config/ai-router.yaml` (what is already wired).
2. Search Hugging Face — trending and recent — for `text-generation`, `text-to-image`,
   `automatic-speech-recognition`, `text-to-speech`. The hub API gives exact parameter
   counts and licences; prefer it over prose about a model.
3. Read the live vendor model lists for anything new worth an opinion.
4. Rewrite `config/model-scout.json` **whole**, keeping the `_doc` and `_schema` keys.
5. Commit it to `master` with a message naming what changed.

### Rules the report must follow

- **Every candidate must beat something already here**, and `why` must say what and by
  how much. "It is new" is not a reason; "a third the size of the model whose 28 GB of
  standing host RAM has already killed a service" is.
- **Sourced numbers over estimates.** Give `requirement` when the authors published
  usable figures, with a `basis` saying where they came from. Give `spec` otherwise and
  let `estimateFromParams()` do the arithmetic — it labels its own output as estimated.
  Never write a number into `requirement` that you cannot defend in `basis`.
- **This card is a 32 GB Blackwell (RTX 5090, sm_120).** NVFP4 runs natively on it. A
  70B at bf16 does not fit and never will; do not list one.
- **Host RAM is the tighter constraint, not VRAM.** 63 GB total, and a CPU-offloaded
  diffusion model holds its full weight set resident for as long as its service is up.
- **Licence is a fact, not a footnote.** Gated repos and bespoke licences go in `notes`,
  not in `candidates`, until someone has read the terms.
- Do not put vendor model ids in `candidates` when discovery already surfaces them —
  use `upgrades` for a like-for-like repoint, and `candidates` only when there is
  something to say that the model list cannot say itself.

### Scheduling it

It runs as a **Claude Code cloud routine**, not a local script. Two reasons: there is no
`claude` CLI on this box's PATH, and the work wants web search plus repo write access
rather than a shell on this machine. Running in the cloud means it cannot see the GPU —
which costs nothing, because fit is computed locally at read time and the routine's job is
judgment, not measurement.

| | |
| --- | --- |
| Routine | **BeTenshi model scout (weekly)** — [`trig_01DneSxh17mZUzNNcnvUf5s2`](https://claude.ai/code/routines/trig_01DneSxh17mZUzNNcnvUf5s2) |
| Schedule | `47 5 * * 1` UTC — Mondays, 08:47 Asia/Riyadh |
| Model | `claude-opus-5` |
| Source | `github.com/alibad/betenshi-console`, commits `config/model-scout.json` to master |

The routine's prompt deliberately does **not** restate the rules above. It says "read
`docs/model-scout.md` and follow it exactly", so this file stays the single copy and the
schedule cannot drift away from it. Change the brief here; the routine picks it up on its
next run.

Manage it at <https://claude.ai/code/routines> — including **Run now**, which is how you
force an off-schedule refresh.

## 3. Wiring a cloud model in

`src/lib/wired-models.ts`. The console **never parses or rewrites** `ai-router.yaml` —
that file is hand-written and most of its value is in comments recording what was measured
about litellm's retry behaviour. Instead:

- `config/wired-models.json` is the source of truth for console-added models;
- a single **managed block** between two marker comments is spliced into `model_list`,
  rendered from that JSON;
- everything outside the markers is byte-for-byte untouched.

Aliases and targets are validated against strict shapes and **rejected, not sanitised** —
these become unquoted YAML scalars in a file configuring a process that holds three API
keys. An alias that collides with a hand-written one is refused by name.

After a change the router is restarted through the service manager, because litellm reads
its config once at startup and has no reload signal. If the restart fails the wiring still
stands and the UI says so, rather than reporting success for a model `/model/info` has
never heard of.

### Why local models have no "wire in" button

A local alias needs a service listening on a port and an entry in
`scripts/service-commands.json`. Wiring a route to a port with nothing behind it produces
exactly the silent dead model this whole tab exists to prevent. Adding a local model is
still a deliberate act: download the weights, add the service, then add the alias.

## 4. Fit

`src/lib/model-fit.ts` — pure, dependency-free, unit-tested in
`scripts/model-fit.test.mjs`. Verdicts are computed **at read time against the live
machine**, never stored: a verdict written a week ago describes a machine with different
services running and different free disk.

| Verdict     | Means                                                        |
| ----------- | ------------------------------------------------------------ |
| `fits`      | Runs, and leaves room for something else                      |
| `fits alone`| Runs on an idle card, nothing fits beside it                  |
| `needs a swap` | Would fit if the named services stopped                    |
| `won't fit` | Exceeds the machine even with everything else stopped         |
| `off-box`   | Cloud — costs money, not memory                               |

The machine profile is read live (`src/lib/machine.ts`): nothing about the card, the RAM,
or the weights drive is hardcoded, so the verdicts stay correct after a GPU swap or a disk
that quietly filled up. The one configured value is which drive weights land on
(`WEIGHTS_DRIVE`, default `D:`), because that is a decision rather than something the
machine can report.

Occupancy uses the **configured** footprint, not a live reading. A live number says what a
service is using this instant; the fit question is what it will be using when the candidate
also wants memory, and for Qwen-Image those differ by 20 GB.
