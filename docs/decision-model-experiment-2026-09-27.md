# Decision model experiment — 27 September 2026

## Recommendation

**No: zero-shot Laya is not right often enough to replace an LLM call for any of
the six decisions tested.** On this box's own decisions, hand-labelled, Laya scored 17-65% depending on checkpoint and set (the best checkpoint on each set: 37-65%), where Claude Haiku scored 83-100%. It mostly fails
one way: it collapses onto one label. It said "local" to 38 of 40 routing
requests, "medium" to 33 of 36 Reddit posts, and "bug" to 31 of 40 feedback
items. The model itself works: it reproduces the vendor's AG News result on this
box (95%, ECE 0.040) through the same code. What it cannot do out of the box is
the judgement these decisions are made of.

**The better local replacement was already running.** Qwen2.5-7B on vLLM
(`local-small`, resident for quote-forge) answered in 160-370 ms, about the same
as Laya on CPU, and matched or beat Haiku on two sets: router escalation 98%
(Haiku 93%) and moderation 83% (Haiku 83%). It came close on two more: feedback
triage 90% (95%) and console intent 88% (100%). Its costs are that it holds 13 GB
of VRAM and is quote-forge's service, not a guaranteed one.

| Use case | Use | Not | Why |
|---|---|---|---|
| **Router escalation**: local or cloud? (AI Router) | `local-small`, 98%, 161 ms, free. Claude Haiku (93%) when it is not resident. | Laya (60-65%) | Laya answers "local" 95% of the time, which is the majority class. A 7B model is good at knowing what a 7B model can do. |
| **Feedback triage** (Globe Quest) | Claude Haiku, 95%, called **by globe_quest with its own key** | anything local; Laya (35-40%, typed-decisions 63%) | Globe Quest is a cloud project and must not call this box. Haiku costs ~$0.64 per 1,000 issues. |
| **Moderation** (Globe Quest feed, Ask Locals) | Claude Haiku (83%) from globe_quest, with a person on "review" | anything local; Laya (39-42%) | Haiku's six misses are all in the safe direction: clear removals held for review, harmless posts sent to review. |
| **Reddit relevance** (reddit-scout) | Claude Haiku (83%) in place of the keyword score | the keyword heuristic (44%), `local-small` (61%), Laya (17-50%) | The skill's HIGH/MED/LOW is right 44% of the time, and Laya is worse. This is judgement about intent, and it needs the bigger model. |
| **Console intent** | `local-small` (88%) or Haiku (100%) | Laya alone (52-64%) | The only set where a Laya-first cascade saves anything without losing accuracy: 21% of Haiku calls, at 100%. At the console's volume that saves nothing worth the complexity. |
| **Arabic dialect** | Claude Haiku (89%) | Laya (23-37%), `local-small` (31%) | Laya routes Arabic to the right checkpoint, but that checkpoint cannot tell dialects apart: it calls most of them MSA or Gulf. Gemma 4 is the Arabic experiment's pick for dialect, and it could not be measured here (below). |

**Keep Laya installed, stopped by default, on CPU.** It is the decision model
behind `/api/decide`, the Decision Lab and the BPMN gateways (06), and those
are experiments. On this machine, holding it resident was never free:

- On the GPU it holds 5.7 GB, and during this run the coordinator refused to
  start it for lack of that room.
- On CPU it holds 3.7-5.5 GB of RAM. That is also contended: Qwen-Image's load
  crashed at 0.3 GB of free RAM while this ran.

**Reconsider it if**

1. **A decision is coarse and vocabulary-level** (topic, language, "is this
   about billing"). There it is as good as the vendor says and 5-30x faster
   than a cloud LLM call. It is no faster than the resident 7B model.
2. **Someone fine-tunes it.** The vendor's own numbers say its accuracy comes
   from fine-tuning (0.36 → 0.77 on their benchmark). Their Kaggle notebook
   does it on free T4s, but it needs hundreds of labelled decisions per task.
   Tens, as here, are enough to *measure* it, not to *train* it.
3. **Latency truly matters** and 20-40 points of accuracy do not.

### The boundary

Laya wins where the answer is in the words: topic (AG News 95%), language
routing, "is this about a refund". It loses where the answer needs reading
between the lines:
- **Pragmatics.** A scam versus a warning about a scam (mo-33).
- **World knowledge.** Whether a task needs a frontier model.
- **Degree.** HIGH versus MEDIUM relevance.
- **Morphology.** Egyptian versus Levantine.

The vendor names one more limit, more than ~20 options; the most here is seven.

### A second opinion: the Process Lab

The BPMN session (06) called `/api/decide` from its gateways on its own
hand-labelled relocation-agency requests
([process-lab-2026-09-27.md](process-lab-2026-09-27.md)). Its numbers qualify
two of the conclusions above:

- **Laya did better on that domain than on these six sets.** It got 16 of
  24 alone. Answering only at confidence ≥ 0.7, it took 15 of the 24 and got
  one wrong. That one wrong answer came at 0.93: a Portuguese digital-nomad visa
  question answered as a visa application. So a confidence gate works most of
  the time, but a high score does not make an answer safe.
- **`local-small` is not a universal answer.** Behind Laya it got 3 of 8
  relocation cases right, filing residency clients as visa applications. Haiku
  got 7 of 8. The 7B model is strong on the four sets above and weak on this
  one, so check it per decision rather than trusting it by default. It drafted
  fine (35 of 36 emails correct, median 0.75 s).

Both sessions' sets are small (8-42 items) and hand-labelled. Read the
two as agreeing on the shape: Laya is fast and sometimes usable behind a gate,
and a decision that matters still goes to Haiku.

### Gemma 4 was not measured

The brief's local comparison, `local-gemma4` (Gemma 4 31B via Ollama), has no
numbers here.

1. **First attempt.** It started during 3D's GPU claim, which this session had
   not seen, and was stopped and unloaded within minutes. At that point it was
   taking over 15 s per decision, because it was reasoning before answering.
2. **Second attempt.** The resource coordinator refused it: *"VRAM needs 20 GB
   more … but only 9.21 GB is currently free"*. The holder was quote-forge's
   `vllm-small`, which was in use and is not this experiment's to stop.

To finish it, run the command below when ~20 GB is free. The bench resumes, and
the Lab shows the new rows.

```
node scripts/decide-bench.mjs --models local-gemma4
```

That run will also be the first end-to-end test of the reasoning switch
`/api/decide` now sends to Ollama models. The switch is
`extra_body: { reasoning_effort: "none" }`, and only that form survives the
router. It was verified against the router's own litellm: a bare
`reasoning_effort` is **dropped silently** under `drop_params`, and the
`extra_body` form is forwarded. Whether Ollama 0.34.4 then stops reasoning is
not yet observed.

## What was claimed, and what held

The claims were days old when this ran. Each was checked here, not taken from
the model card.

| Claim (vendor) | Verified here | |
|---|---|---|
| Open weights, Apache-2.0 | **Yes** — `license: apache-2.0` on `convaiinnovations/laya`, and on the `laya` 0.3.20 package's metadata. No regional or commercial restriction. | ✔ |
| ~421M params, ModernBERT-large backbone | **Yes** — 421.3M counted from the safetensors header; encoder config: ModernBERT, 28 layers, hidden 1024. | ✔ |
| Multilingual checkpoint: 322M, mmBERT-base, 100+ languages | **322M and mmBERT-base: yes** (321.9M; 22 layers, 256k vocabulary). 100+ languages: not tested beyond Arabic, Spanish and Hindi-script routing. | ✔ / – |
| Three checkpoints, one repo | **Yes** — English at the root, `multilingual/` and `typed-decisions/` as subfolders, revision `55cf4c4`, 2.3 GB together. | ✔ |
| Router picks the checkpoint by script and language | **Yes** — Arabic went to `multilingual` ("non-Latin script (arabic, 100% of letters)"), English to `english`. | ✔ |
| 32.8 ms on a T4 | **Consistent** — on the RTX 5090 a forward pass is 28-35 ms (single question), 40-55 ms end to end through `/api/decide`. On CPU (24 threads) 150-300 ms, matching the card's 193-464 ms CPU figure. | ✔ |
| AG News 0.950 | **Reproduced** — 95/100 on the first 100 test rows, ECE 0.040. | ✔ |
| Calibrated probabilities (ECE 0.081) | **Only on easy tasks.** 0.040 on AG News. On our sets 0.09-0.28, and the multilingual checkpoint ships **no fitted temperature at all** (`temperature: [1,1,1]` in its config); only the English one does. The vendor's 0.081 is explicitly post-temperature on its own domain. | ✘ on these tasks |
| Zero-shot typed decisions | **Weak.** The card itself says the base checkpoints score *below the majority class* on the vendor's typed-decisions benchmark (0.362 vs 0.461); that is what happened here too. | ✘ |
| Adoption | **Not evidence either way.** The Hub API (27 Sept) reports `downloads` (30-day) = 0 and `downloadsAllTime` = 0 for both official repos, most likely because the Hub counts a library-specific file this custom format does not have; 4,045 likes on `laya`, 301 on `laya-multilingual`. Community ports show real pulls (`mys/laya-multilingual-GGUF` 6,055 and `mys/laya-GGUF` 4,021, 30-day). Popularity, per docs/models.md, is attention, not quality. | – |
| 7.8x faster than Jev | **Not comparable here.** Jev is TypeSafe's closed API (`POST api.typesafe.ai/v1/systemone`, $0.042 / M input tokens, waitlisted early access since 15 September). There is no key on this box. Every Jev number on the Laya card is third-party. | – |

## Measured

Every row goes through `POST /api/decide` on BeTenshi. Laya runs on the GPU here (its CPU latency is under *Speed*). **Bold** marks the best accuracy on each set. `local-small` is Qwen2.5-7B-Instruct-AWQ on vLLM. Cost is the router's own figure.

### Arabic dialect — n=35, 5 labels (chance 20%)

| model | accuracy | macro F1 | ECE | ECE, tempered | Brier | p50 | p95 | $ / 1,000 |
|---|---|---|---|---|---|---|---|---|
| laya | 37% | 29% | 0.201 | 0.132 | 0.905 | 30 ms | 42 ms | local |
| laya-english | 23% | 17% | 0.117 | 0.005 | 0.817 | 45 ms | 101 ms | local |
| laya-multilingual | 37% | 29% | 0.201 | 0.132 | 0.905 | 56 ms | 131 ms | local |
| laya-typed-decisions | 29% | 18% | 0.075 | 0.032 | 0.796 | 53 ms | 140 ms | local |
| local-small | 31% | 26% | 0.548 | 0.142 | 1.145 | 346 ms | 375 ms | local |
| claude-haiku | **89%** | 88% | 0.059 | 0.116 | 0.204 | 1.2 s | 3.2 s | $0.60 |

### Console intent — n=42, 7 labels (chance 14%)

| model | accuracy | macro F1 | ECE | ECE, tempered | Brier | p50 | p95 | $ / 1,000 |
|---|---|---|---|---|---|---|---|---|
| laya | 60% | 59% | 0.222 | 0.235 | 0.583 | 46 ms | 64 ms | local |
| laya-english | 60% | 60% | 0.171 | 0.186 | 0.571 | 38 ms | 51 ms | local |
| laya-multilingual | 52% | 51% | 0.316 | 0.202 | 0.689 | 36 ms | 60 ms | local |
| laya-typed-decisions | 64% | 62% | 0.145 | 0.097 | 0.487 | 102 ms | 183 ms | local |
| local-small | 88% | 89% | 0.245 | 0.524 | 0.300 | 374 ms | 384 ms | local |
| claude-haiku | **100%** | 100% | 0.090 | 0.000 | 0.014 | 1.2 s | 1.8 s | $0.67 |

### Feedback triage (Globe Quest) — n=40, 5 labels (chance 20%)

| model | accuracy | macro F1 | ECE | ECE, tempered | Brier | p50 | p95 | $ / 1,000 |
|---|---|---|---|---|---|---|---|---|
| laya | 40% | 33% | 0.194 | 0.196 | 0.672 | 56 ms | 129 ms | local |
| laya-english | 38% | 29% | 0.180 | 0.207 | 0.678 | 55 ms | 92 ms | local |
| laya-multilingual | 35% | 26% | 0.381 | 0.120 | 1.007 | 42 ms | 65 ms | local |
| laya-typed-decisions | 63% | 60% | 0.306 | 0.215 | 0.663 | 52 ms | 81 ms | local |
| local-small | 90% | 90% | 0.079 | 0.056 | 0.171 | 308 ms | 323 ms | local |
| claude-haiku | **95%** | 95% | 0.106 | 0.059 | 0.085 | 1.0 s | 2.4 s | $0.64 |

### Moderation (community feed and Ask Locals) — n=36, 3 labels (chance 33%)

| model | accuracy | macro F1 | ECE | ECE, tempered | Brier | p50 | p95 | $ / 1,000 |
|---|---|---|---|---|---|---|---|---|
| laya | 42% | 33% | 0.093 | 0.072 | 0.627 | 54 ms | 117 ms | local |
| laya-english | 39% | 30% | 0.068 | 0.019 | 0.652 | 49 ms | 64 ms | local |
| laya-multilingual | 39% | 37% | 0.264 | 0.133 | 0.706 | 48 ms | 118 ms | local |
| laya-typed-decisions | 39% | 36% | 0.077 | 0.120 | 0.658 | 43 ms | 66 ms | local |
| local-small | **83%** | 81% | 0.149 | 0.232 | 0.312 | 190 ms | 225 ms | local |
| claude-haiku | **83%** | 82% | 0.106 | 0.042 | 0.225 | 908 ms | 1.5 s | $0.46 |

### Reddit relevance (reddit-scout) — n=36, 3 labels (chance 33%)

| model | accuracy | macro F1 | ECE | ECE, tempered | Brier | p50 | p95 | $ / 1,000 |
|---|---|---|---|---|---|---|---|---|
| laya | 22% | 19% | 0.279 | 0.127 | 0.772 | 44 ms | 58 ms | local |
| laya-english | 22% | 19% | 0.279 | 0.127 | 0.772 | 49 ms | 85 ms | local |
| laya-multilingual | 50% | 43% | 0.177 | 0.177 | 0.655 | 37 ms | 49 ms | local |
| laya-typed-decisions | 17% | 10% | 0.279 | 0.178 | 0.721 | 45 ms | 81 ms | local |
| local-small | 61% | 49% | 0.286 | 0.145 | 0.670 | 204 ms | 273 ms | local |
| claude-haiku | **83%** | 77% | 0.091 | 0.044 | 0.279 | 880 ms | 1.7 s | $0.51 |
| reddit-scout-heuristic | 44% | 45% | 0.556 | 0.221 | 1.111 | 0 ms | 0 ms | local |

### Router escalation — n=40, 2 labels (chance 50%)

| model | accuracy | macro F1 | ECE | ECE, tempered | Brier | p50 | p95 | $ / 1,000 |
|---|---|---|---|---|---|---|---|---|
| laya | 63% | 48% | 0.121 | 0.100 | 0.412 | 46 ms | 75 ms | local |
| laya-english | 63% | 48% | 0.102 | 0.096 | 0.418 | 47 ms | 73 ms | local |
| laya-multilingual | 60% | 56% | 0.120 | 0.110 | 0.501 | 34 ms | 89 ms | local |
| laya-typed-decisions | 65% | 56% | 0.089 | 0.155 | 0.434 | 43 ms | 57 ms | local |
| local-small | **98%** | 97% | 0.056 | 0.012 | 0.064 | 161 ms | 174 ms | local |
| claude-haiku | 93% | 92% | 0.061 | 0.032 | 0.121 | 829 ms | 1.5 s | $0.43 |

### Cascades: Laya first, Claude Haiku below a confidence threshold

For each set, the threshold that saves the most Haiku calls while staying within two points of Haiku alone. This is where calibration earns money, and on five of six sets it saves almost nothing.

| set | Laya alone | best cascade | at threshold | LLM calls saved | Haiku alone |
|---|---|---|---|---|---|
| Arabic dialect | 37% | 89% (laya) | 0.9 | 3% | 89% |
| Console intent | 64% | 100% (laya-typed-decisions) | 0.7 | 21% | 100% |
| Feedback triage (Globe Quest) | 63% | 95% (laya-english) | 0.7 | 5% | 95% |
| Moderation (community feed and Ask Locals) | 42% | 83% (laya) | 0.6 | 11% | 83% |
| Reddit relevance (reddit-scout) | 50% | 83% (laya-multilingual) | 0.8 | 8% | 83% |
| Router escalation | 65% | 95% (laya-typed-decisions) | 0.6 | 22% | 93% |

### Does the harness handicap Laya?

Checked, because a collapse onto one label can be a prompt-format bug. Same
items, CPU, auto-routed unless stated:

| set | laya: as sent | options budget 512 | bare labels | typed-decisions: as sent | budget 512 | bare labels |
|---|---|---|---|---|---|---|
| Feedback triage | 40% | 40% | 55% | 63% | 63% | 53% |
| Router escalation | 63% | 63% | 73% | 68% | 68% | 68% |
| Reddit relevance | 22% | 22% | 22% | 17% | 17% | 22% |
| Moderation | 42% | 42% | 39% | 39% | 39% | 36% |
| Console intent | 60% | 60% | 55% | 64% | 64% | 55% |
| Arabic dialect | 37% | 37% | 26% | 29% | 29% | 31% |
| AG News (first 100 test rows) | 94% with descriptions | — | 95% (ECE 0.040) | — | — | — |

Run on CPU in float32 (the GPU run is bf16), which moves a few items: typed-decisions routing is 68% here and 65% on the GPU. Script: `AI/laya/ablation.py`; results: `experiments/decide/results/ablation-2026-09-27.json`.

- **Raising the option budget to 512 tokens changed nothing** on any set. The
  descriptions were never being cut (each option is capped at 48 tokens and
  the questions fit).
- **Dropping the descriptions** helped feedback triage (40% → 55%) and routing
  (63% → 73%) and hurt Arabic and moderation. Neither form rescues it.
- **AG News through the same code reproduces the vendor.** So the collapse is
  the model on these tasks, not the wrapper.

## Speed, memory and cost

| | Laya, GPU | Laya, CPU | Qwen2.5-7B (`local-small`) | Claude Haiku |
|---|---|---|---|---|
| p50, one decision, end to end | 30-56 ms (p95 42-129 ms) | 93-235 ms (p95 125-481 ms) | 161-374 ms (p95 174-384 ms) | 0.8-1.2 s (p95 1.5-3.2 s) |
| Memory held | 5.7 GB VRAM (all three checkpoints) | 3.7 GB RAM (two checkpoints), 5.5 GB with typed-decisions; 0 VRAM | ~13 GB VRAM (vLLM, held for quote-forge anyway) | — |
| Cost per 1,000 decisions | local | local | local | $0.43-0.67 (router-metered) |

The whole Haiku baseline, 229 decisions, cost **$0.127** by the router's own figures. Latency ranges are the spread of per-set medians; the forward pass alone is 27-50 ms on the GPU and 85-231 ms on CPU, so the console adds ~5 ms.

**Why CPU.** On the GPU Laya holds ~6 GB for as long as it runs. During this
run five explorations shared the card, and the resource coordinator refused to
restart Laya because Music, Bonsai, ComfyUI and SAM 3 had it (it said: *"VRAM
needs 5.5 GB more … but only 16.16 GB is currently free"*). For a model that
answers in a fifth of a second on CPU, holding a quarter of the card is the
wrong trade. `LAYA_DEVICE=cuda` in `service-commands.json` switches it back for
a bulk run.

## What was built

- **The service** — `AI/laya/server.py`, its own venv, `127.0.0.1:8040`,
  service id `laya` (host profile, `service-commands.json`, `resource-policy.json`,
  `model-meta.json`). Serves `laya` (auto-routed), `laya-english`,
  `laya-multilingual`, `laya-typed-decisions` under capability `decision`.
- **`POST /api/decide`** — question, typed choices, context → choice,
  probabilities, latency. The same shape from Laya or from any router chat
  model, so a caller can swap one for the other. Contract:
  [decide-api.md](decide-api.md).
- **The Decision Lab** (`#lab-decide`) — the labelled sets as presets, the
  distribution as bars, Laya beside an LLM through the new `compareCapability`
  on the Labs registry (see [labs.md](labs.md)), and this page's numbers with
  reliability plots.
- **The MCP tool `decide`** — with a description that says when not to use it.
- **The labelled sets** — `experiments/decide/sets/*.json`, 229 items.
- **The bench** — `node scripts/decide-bench.mjs`: every set × every model
  through `/api/decide`, resumable, writes the results and the summary the Lab
  shows.

## Method, and what is assumed

- **Labels.** Every item was written and labelled by hand for this experiment
  by the Claude session running it (Claude Opus 5.5) — not by any model under
  test. The real sources the brief pointed at (Globe Quest's GitHub issues,
  router and console prompts, community posts, saved reddit-scout reports) hold
  other people's text and were deliberately **not** read. The label vocabularies
  are the real ones: the feedback widget's own categories, Globe Quest's
  critical-report reasons, reddit-scout's HIGH/MED/LOW, the console's own
  surfaces. Each set's rubric is in its file. Hard and borderline items are
  marked with a `note`.
- **What that costs.** A hand-written set is cleaner than real traffic. Real
  feedback is messier and real Reddit posts are longer, which should hurt every
  model; it is unlikely to reverse a 30-60 point gap. Arabic dialect items were
  not checked by a native speaker of every dialect.
- **Sizes.** 35-42 items a set. A difference under ~10 points between two
  models on one set is within noise; the Laya-vs-LLM gaps are 20-60 points.
- **LLMs are asked for a JSON distribution** (`buildLlmPrompt` in
  `src/lib/decide.ts`), temperature 0. Claude exposes no token log-probabilities,
  so a stated probability is what a caller replacing an LLM call would actually
  have. Its ECE is that stated probability's calibration.
- **ECE** is 10 equal-width bins on the top-label probability. "Tempered" fits
  one temperature per model per set on half the items and scores the other half
  (then swaps), so it never flatters by fitting on what it scores.
- **Latency** is wall-clock through `/api/decide` on BeTenshi, with other
  sessions using the machine; treat it as typical, not best-case.

## Reproduce

```
node scripts/decide-bench.mjs                       # every set × default models; resumable
node scripts/decide-bench.mjs --models laya --sets moderation
node --test scripts/decide.test.mjs                 # the parser and the metrics
```

Results: `experiments/decide/results/2026-09-27.json` (every prediction) and
`2026-09-27.summary.json` (the scores; the Decision Lab reads the newest).
