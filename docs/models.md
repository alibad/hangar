# Models

**One page.** It was briefly three — a routing tab, a scouting tab, a leaderboard tab — which
was three answers to one question. Those surfaces were about the same objects, differing only
in how far away they were: running here, wired but idle, buyable from a vendor, downloadable
from the Hub. Making the reader pick a tab before seeing them meant they could never compare
across that distance, which is the only comparison that matters when deciding what to run.

`src/components/models-page.tsx` is the page; `models-page.types.ts` flattens every source
into one `Entry` list; `models-page.parts.tsx` draws it. Two lanes — this machine, cloud —
because they are different kinds of commitment: one costs memory and a download, the other
costs money per call, and ranking them against each other compares quantities that do not
convert. Filtered by default to what actually runs on this card, because a console that opens
on 200 models it cannot run is just a leaderboard.

Four data sources feed it, with different failure modes and refresh rates.

| | Source | Refreshes | Can it be wrong? |
| --- | --- | --- | --- |
| Discovery | vendor `/models` endpoints | 15 min | No — it only reports ids and dates |
| Leaderboard | llm-stats.com | 12 h | Only as wrong as the source |
| Report | a weekly Claude routine | 7 days | Yes — it is judgment, so it is dated and reviewable |
| Fit | every known machine | every read | It is an estimate, and says so |

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

Its picks are **rows in the list**, marked `scout`, ranked above every leaderboard row and
below anything already wired — a considered recommendation outranks a ranked list, and both
lose to a model already serving traffic. The `why` gets its own framed block in the details
panel, dated, because it is the one field on the page that is an argument rather than a
reading and should never be mistaken for one. For a long time these were shipped to the
browser and rendered only as prose notes at the foot of the page, which meant the most
considered items on it were the least visible.

### What the routine must do

1. Read this file and `config/model-meta.json` (what is already here, and its measured
   footprints) and `config/ai-router.yaml` (what is already wired).
2. Search Hugging Face — trending and recent — for `text-generation`, `text-to-image`,
   `automatic-speech-recognition`, `text-to-speech`. The hub API gives exact parameter
   counts and licences; prefer it over prose about a model.
2b. **For speech-to-text, rank on the Open ASR Leaderboard, not on trending.** Parameter
   counts, licences and a `language:` list are not accuracy, and ranking ASR on them got
   this report's picks wrong twice. Pull the CSVs directly rather than scraping the Space —
   `hf-audio/open-asr-leaderboard-results/english_short_latest.csv`,
   `hf-audio/leaderboard_longform/longform_latest.csv`, and
   `hf-audio/multilingual_evals/multilingual_<lang>.csv`; the current revisions are listed
   in the Space's `init.py` under `VERSIONS`. Report WER **per board**: models routinely win
   one and lose another, and a single average hides exactly the trade the reader is making.
   A model absent from a board is unmeasured there — say so rather than ranking it on the
   board it happens to appear in.
3. Read the live vendor model lists for anything new worth an opinion.
4. **Do not re-list what the leaderboard already covers.** The Leaderboard tab ranks every
   open-weights text model with a parameter count against this card automatically, and the
   cloud discovery list carries prices and benchmarks. A candidate earns its place by
   saying something those cannot: a measured footprint, a licence caveat, an image/audio
   model llm-stats does not track, or a reason this specific box should adopt it.
5. Set `runtimes` on any candidate whose weights are tied to one stack — `["metal"]`
   for an MLX repo, `["cuda"]` for TensorRT or NVFP4. **Omit it for portable weights**,
   which is most of them: absent means "runs anywhere", and a `runtimes` field set
   defensively on everything would refuse everything the first time a rule was wrong.
   GGUF is portable; do not pin it.
6. Rewrite `config/model-scout.json` **whole**, keeping the `_doc` and `_schema` keys.
7. Commit it to `master` with a message naming what changed.

### Rules the report must follow

- **Every candidate must beat something already here**, and `why` must say what and by
  how much. "It is new" is not a reason; "a third the size of the model whose 28 GB of
  standing host RAM has already killed a service" is.
- **Say which machine you mean.** The console computes a verdict per host and shows them
  side by side, so a flat "does not fit here" in `why` or `notes` is now ambiguous and
  usually wrong on one of the two. BeTenshi is 31.8 GB of VRAM beside 63 GB of host RAM;
  B5 is a single 128 GB pool. A model ruled out on size for the first is very often
  unremarkable on the second, and that difference is worth a sentence rather than a
  silent omission. Name the box, or say "on both".
- **Sourced numbers over estimates.** Give `requirement` when the authors published
  usable figures, with a `basis` saying where they came from. Give `spec` otherwise and
  let `estimateFromParams()` do the arithmetic — it labels its own output as estimated.
  Never write a number into `requirement` that you cannot defend in `basis`.
- **There are two machines.** The Windows box is a 32 GB Blackwell (RTX 5090, sm_120)
  where NVFP4 runs natively; B5 is Apple silicon with unified memory, where NVFP4 does
  not load at all and the MLX rungs take its place. A 70B at bf16 fits neither; do not
  list one. Where a candidate is tied to one stack — an MLX-only repo, a CUDA-only
  kernel — say so, because that is a fact neither llm-stats nor a parameter count carries.
- **On the discrete box, host RAM is the tighter constraint, not VRAM.** 63 GB total,
  and a CPU-offloaded diffusion model holds its full weight set resident for as long as
  its service is up. This was written here as a law and it is not one: it is a fact
  about *that* machine. On unified memory there is nowhere to offload to, so the same
  model costs one copy rather than two and the constraint is simply the size of the
  pool. `evaluateFit()` now branches on `memoryModel` instead of assuming the first case.
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
`docs/models.md` and follow it exactly", so this file stays the single copy and the
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

### One model, two answers

"Can I run this" stopped being one question the moment there were two hosts, and for a
good number of models the two answers differ — not marginally, but oppositely. So every
scout candidate carries `fit` for the live machine plus `elsewhere[]`, one verdict per
other host. The examples that make the point:

| | BeTenshi | B5 |
| --- | --- | --- |
| Edge0-35B-A3B — Apache-2.0, 19.74 GB | won't fit: MLX needs Metal | fits |
| Qwen-Image — 20.3 GB VRAM + 28 GB offload | the offload is what collides | fits, counted once |
| VibeVoice-ASR-Streaming-7B — 17.4 GB | runs alone, blocks the image models | unremarkable |

The asymmetry is deliberate and has to stay visible. The live machine is **measured**: free
memory, running services, real disk, so it can answer `needs a swap` and name what to stop.
Every other host is **declared** from `config/hosts/*.json` — idle by construction, no
occupants, and `weightsDiskFreeGb` absent because the other box cannot be asked. A verdict
there means "would fit on an idle B5" and nothing stronger, and `vramBasis` says so in
words. Absent free-disk is treated as unknown, never as zero: assuming zero would refuse
every candidate on the machine we are not standing on, which is the same mistake
`weightsIndexed: false` exists to avoid.

Before any of this, `runtimes` decides whether the machine can execute the weights at all.
`runtimesFor()` reads the Hub's `library_name` and tags during download resolution — free,
since that call already runs to price the download — and the weekly report can set it by
hand. It speaks only where the format genuinely pins the hardware (MLX and CoreML → Metal;
TensorRT, NVFP4, exllama → CUDA; AWQ and GPTQ → CUDA or ROCm, not Metal) and returns
undefined everywhere else. **Absent means portable, not unknown** — GGUF is checked first
and returns portable deliberately, because repos routinely carry both a GGUF tag and a
quantisation word that would otherwise pin them.

For a model that is not installed, `bestPrecisionFor()` walks a quantisation ladder and
returns the first rung that runs here, plus every rung it evaluated. That is the honest
shape of the answer: "does this 32B fit" is not yes/no, it is "yes, at 4-bit, and here is
what bf16 would have needed".

**The ladder depends on the machine**, because a rung the GPU cannot execute is not a
worse option, it is not an option — and since the walk stops at the first rung that fits,
a phantom rung at the top would hide the real answer. On the 5090 it is
bf16 → fp8 → NVFP4 → AWQ 4-bit → GGUF Q3 → Q2, with NVFP4 present because sm_120 executes
it in hardware. On B5 it is bf16 → MLX 8-bit → MLX 4-bit → GGUF Q4 → Q3 → Q2. A
pre-Blackwell CUDA card loses the NVFP4 rung. `precisionLadderFor()` decides.

Before any of that, `evaluateFit()` asks whether the machine can run the weights at all.
A `Requirement` may declare `runtimes` — `["metal"]` for an MLX repo, say — and a
mismatch is refused immediately, with a reason saying the size was never the problem.
This is the verdict the Leaderboard tab structurally cannot reach: Edge0-35B-A3B is
Apache-2.0 and 19.74 GB, every number says it fits this card, and it is MLX.

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
The one configured value is which drive weights land on (`WEIGHTS_DRIVE`, default `D:` on
Windows), because that is a decision rather than something the machine can report.

**Which machine, from the host profile.** The console runs on BeTenshi and on B5, and
`src/lib/host.ts` resolves which at build time from `config/hosts/*.json`. The numbers come
from `src/lib/sysinfo.ts` — `nvidia-smi` on one, the unified pool and `vm_stat` on the other.
`readMachineProfile()` composes the two and adds what the *fit* arithmetic needs on top:

| | BeTenshi | B5 |
| --- | --- | --- |
| `runtime` | `cuda` (+ `computeCapability`) | `metal` |
| `memoryModel` | `discrete` — two budgets | `unified` — one pool |
| Ladder | bf16 → fp8 → NVFP4 → AWQ4 → Q3 → Q2 | bf16 → MLX8 → MLX4 → Q4 → Q3 → Q2 |
| Weights | `D:\AI Models\huggingface`, storage index | `~/.cache/huggingface`, `statfs` |

`runtime` and `memoryModel` come off the host profile rather than `process.platform`, per
the rule host.ts sets. `computeCapability` is asked of `nvidia-smi` once and kept, since
silicon does not change between reads; only NVFP4 depends on it, and an unknown value keeps
the rung.

The storage index is Windows-only — it enumerates `Win32_LogicalDisk` and normalises with
`path.win32` — so on B5 the weights volume is read with `statfs` instead. That gives free
space correctly and reports `weightsIndexed: false`, which is honestly what it is: no index
has walked that volume, so there is no "what else is down there" breakdown to show. The
cache size itself does not need the index and is summed from the filesystem either way.

One number on a unified host has no honest source: how much of the pool the OS lets the GPU
wire. `sysinfo` reports the whole pool for both figures, which is right until someone pins
`iogpu.wired_limit_mb`; where that is pinned, set `vramTotalGb` below `ramTotalGb` and
`evaluateFit()` applies it as a second ceiling — the failure that otherwise looks
impossible, with tens of gigabytes free and the model still refusing to load.

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

## 5. Downloading weights

`src/lib/hf-download.ts`. The page can tell you a 27B fits and then leave you to go find the
repo — which is where the decision gets lost, because llm-stats ids (`qwen3.8-27b`) are not
Hub repo ids (`Qwen/Qwen3.8-27B`) and the useful repo is usually a sibling (`-FP8`, `-AWQ`,
`-GGUF`) at a third the size.

So Download resolves first and shows what it found, with real byte counts from the Hub's own
`usedStorage`, before pulling anything. A 55 GB transfer is not something to start on a guess.
Candidates are ranked by downloads rather than string similarity: the canonical repo is
overwhelmingly the most-pulled one, while similarity happily picks somebody's fine-tune
because the name is longer.

Jobs run **detached**, via the `hf` CLI with `HF_HOME` set so weights land where the services
that will load them expect. Detached because these run for tens of minutes and the console is
a dev server that reloads on save — a child tied to this process would die halfway through and
leave a half-populated cache. The pid goes to `var/downloads/state.json` so a reloaded server
picks the job back up; progress is scraped from the CLI's own output (split on `\r`, since it
draws progress bars rather than printing lines).

Completion is decided by **whether the weights are on disk**, not by an exit code — a detached
process's status is not ours to read, and "are the weights there" is the question that matters.

### Sizing the cache

`installedRepos()` walks each repo directory with `lstat` and skips symlinks. That is what
makes it correct for both Hub layouts: the documented one puts real files in `blobs/` and
symlinks in `snapshots/`, while on Windows without developer mode the CLI copies instead,
leaving real files in `snapshots/` and `blobs/` nearly empty. Summing only `blobs/` reported
5.4 GB for a cache holding 189 GB; following symlinks would double-count the other layout.

This live sum is what the weights meter shows, in preference to the storage index's figure.
The index reports its last scan, so a model downloaded five minutes ago left "189.4 GB of
weights" unchanged while the free-space figure beside it moved — two numbers about the same
event disagreeing on screen. The index remains the fallback, and the two agree to within a
gigabyte, which is a useful independent check on both.

## 6. List, cards, and the details panel

**List is the default.** The question this page answers is comparative — which of these is
best for what it costs — and a grid of cards makes you hold numbers in your head between one
card and the next. Cards remain for browsing, where the prose matters more than the columns.

Columns differ by lane because the costs do: local shows size / quantisation / VRAM / disk,
cloud shows price in / price out / throughput / context. Both end in GPQA, SWE-bench and HLE.

Every column sorts. Two details that matter:

- **Missing values sink in both directions.** A model with no GPQA score is not the cheapest
  or the best at anything — it is unmeasured, and floating it to the top of an ascending sort
  would read as a claim.
- **A third click returns to the default ranking**, which is the server's: runnable first,
  then quality by percentile. That ordering encodes a judgement a column sort cannot — that a
  model which does not fit is not a candidate however well it scores — so it needs to be
  reachable again without a reload.

Clicking a row opens the **details panel**: the fit verdict with its reasons, the full
quantisation ladder with the chosen rung marked, the arithmetic behind the estimate, and
every action. Keeping those there is what lets the table stay narrow enough to read across.
The panel resolves its model from the live payload on each render rather than holding a
snapshot, so a download's progress and a service coming up both land in an open panel instead
of leaving it stale behind the list.
