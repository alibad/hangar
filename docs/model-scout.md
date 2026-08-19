# Model scout

Keeps the Models tab aware of models that are **not on this box yet** — the question
`config/model-meta.json` could never answer, because it only describes what is already wired.

Four parts, with different failure modes and different refresh rates.

| | Source | Refreshes | Can it be wrong? |
| --- | --- | --- | --- |
| Discovery | vendor `/models` endpoints | 15 min | No — it only reports ids and dates |
| Leaderboard | llm-stats.com | 12 h | Only as wrong as the source |
| Report | a weekly Claude routine | 7 days | Yes — it is judgment, so it is dated and reviewable |
| Fit | this machine, live | every read | It is an estimate, and says so |

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

## 1b. The leaderboard — llm-stats.com, pulled whole

`src/lib/llm-stats.ts`. `config/model-meta.json` used to *link* to this site, which is an
admission that the console cannot answer the question. It now pulls the whole board — 358
models with prices, GPQA / SWE-bench / HLE scores, throughput, parameter counts and an
`is_open_source` flag — and uses it two ways:

- **Cloud**: joined onto each discovered vendor model, so "should I wire this" is decided
  on price and benchmark rather than on the id looking newer.
- **Open weights**: ~205 models publish a parameter count, and a parameter count plus this
  card is enough to size all of them at once. That is the Leaderboard tab.

There is no public API (every `/api` path 404s and robots.txt disallows `/api/`; the
homepage is explicitly allowed), so the data comes out of the Next.js RSC payload embedded
in the homepage — the `initialHomepageLLMModels` key. That is a private key in someone
else's markup and can vanish without notice. Three things keep that from mattering: every
field is optional and the UI degrades to "—"; the last good pull is cached on disk so a
change upstream *freezes* the data rather than emptying it, with `fetchedAt` making the
freeze visible; and nothing here is load-bearing — wiring, routing and fit all work with
this module returning nothing at all.

**Ranking.** Rows are ordered by capability *among what runs here*, never by capability
overall — a 744B model at the top of the chart is not information on a 32 GB card. The
composite uses all four benchmarks as **percentile ranks with missing scores imputed at the
median**. Both simpler schemes are wrong in ways that showed up immediately in the output:
averaging raw scores ranked a GPQA-0.855 model below a GPQA-0.817 one because the former
also had an HLE score and HLE tops out lower; min-max normalising fixed the scale but still
penalised a mediocre HLE relative to *no* HLE. Percentiles fix the scale, median imputation
makes coverage neutral.

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
4. **Do not re-list what the leaderboard already covers.** The Leaderboard tab ranks every
   open-weights text model with a parameter count against this card automatically, and the
   cloud discovery list carries prices and benchmarks. A candidate earns its place by
   saying something those cannot: a measured footprint, a licence caveat, an image/audio
   model llm-stats does not track, or a reason this specific box should adopt it.
5. Rewrite `config/model-scout.json` **whole**, keeping the `_doc` and `_schema` keys.
6. Commit it to `master` with a message naming what changed.

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

**Wire all** does the same thing for every cloud model the configured vendors offer and the
router does not already serve — in **one** config write and **one** restart. It is not a
loop over the single-wire path: that would mean twenty-one restarts of most of a minute
each, with the gateway unusable throughout. The candidate list is recomputed server-side
rather than taken from the request body, so "all" means all as of now rather than all as of
whenever the page last loaded. Partial success is reported, not thrown — one bad alias
should not discard the twenty that were fine — and a repeat click with nothing to add skips
the restart entirely.

Wiring an alias **changes no route**. It makes a model reachable and costs nothing until
something calls it; what actually gets used is still the routing cards' decision.

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

For a model that is not installed, `bestPrecisionFor()` walks a quantisation ladder —
bf16 → fp8 → NVFP4 → AWQ 4-bit → GGUF Q3 → Q2 — and returns the first rung that runs here,
plus every rung it evaluated. That is the honest shape of the answer: "does this 32B fit"
is not yes/no, it is "yes, at 4-bit, and here is what bf16 would have needed". NVFP4 is on
the ladder because this card is Blackwell (sm_120) and executes it in hardware.

The KV-cache constant is calibrated against published GQA geometry, not guessed:
Qwen2.5-7B (28 layers × 4 KV heads × 128) is 56 KB/token, Qwen3-32B (64 × 8 × 128) is
256 KB/token, Qwen3-30B-A3B (48 × 4 × 128) is 96 KB/token. Dense models land near
0.0078 GB per 1k per B and MoE near half that; 0.006 sits between. The earlier value of
0.0125 was inferred from vLLM's `--gpu-memory-utilization` flag — a number vLLM *claims*,
not one it needs — and over-reserved by ~6 GB on a 32B, reporting models as Q3-only that
run fine at 4-bit. `scripts/model-fit.test.mjs` pins both worked examples.

### The machine profile

Read live (`src/lib/machine.ts`): nothing about the card, the RAM, or the weights drive is
hardcoded, so the verdicts stay correct after a GPU swap or a disk that quietly filled up.
The one configured value is which drive weights land on (`WEIGHTS_DRIVE`, default `D:`),
because that is a decision rather than something the machine can report.

Disk comes from the **storage module**, not a private probe. `discoverDrives()` gives the
drive and its label; the index gives the size of `HF_HOME` — currently 189 GB of weights
under `D:\AI Models\huggingface`. "Won't fit, no disk" is far more useful when the same
surface can say what is already down there taking up the room.

Two failure modes are kept distinct on purpose: a drive the indexer has never scanned
reports `weightsIndexed: false` and **no** usage figure, rather than 0 GB. Zero would read
as "nothing downloaded yet", which is the opposite of unknown. If the storage index is
unavailable entirely, free space falls back to a direct query — a fit verdict that silently
assumed a full disk would refuse every local candidate.

Occupancy uses the **configured** footprint, not a live reading. A live number says what a
service is using this instant; the fit question is what it will be using when the candidate
also wants memory, and for Qwen-Image those differ by 20 GB.
