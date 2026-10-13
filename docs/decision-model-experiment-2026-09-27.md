# Decision model experiment — 27 September 2026

*Jev added 2 October 2026, once it was generally available.*

## Recommendation

**No: zero-shot Laya is not right often enough to replace an LLM call for any of
the six decisions tested.** On this box's own decisions, hand-labelled, Laya
scored 17-65% depending on checkpoint and set (the best checkpoint on each set:
37-65%), where Claude Haiku scored 83-100% and Jev, a hosted decision model
built for exactly this, 69-100%. It mostly fails one way: it collapses
onto one label. It said "local" to 38 of 40 routing requests, "medium" to 33 of
36 Reddit posts, and "bug" to 31 of 40 feedback items. The model itself works: it
reproduces the vendor's AG News result on this box (95%, ECE 0.040) through the
same code. What it cannot do out of the box is the judgement these decisions are
made of.

**The best decision-maker measured was Gemma 4 31B, on this box.** Asked through
`/api/decide` with its reasoning switched off, it scored:

| Set | Gemma 4 | Haiku |
|---|---|---|
| Arabic dialect | 100% | 89% |
| Console intent | 100% | 100% |
| Router escalation | 100% | 93% |
| Feedback triage | 98% | 95% |
| Moderation | 94% | 83% |
| Reddit relevance | 72% | **83%** |

That is at least as good as Haiku on five of six sets, at 0.6-1.4 s a decision
(about Haiku's speed) and no per-call cost. Its catch is memory: ~20 GB of VRAM,
loaded on demand by Ollama, which fits only when quote-forge's `vllm-small`
(13 GB) is not resident. When it does not fit, the coordinator refuses it and
Haiku is the fallback.

Qwen2.5-7B (`local-small`, resident on vLLM for quote-forge) is the cheap local
option: ~0.2 s, 83-98% on four sets. But it is weak on Reddit (61%) and Arabic
(31%), and the Process Lab measured it at 3 of 8 on relocation triage (below),
so check it per decision.

**Jev is what a decision model that works looks like, and it is cheap.** Jev is
TypeSafe's hosted decision model: like Laya it returns a distribution over typed
answers and never generates text. When this experiment ran it was a waitlist; by
2 October it was generally available on OpenRouter as `typesafe/jev-1.13`, and it
ran on the same 229 items through the same `/api/decide`:

| Set | Laya | Jev | Gemma 4 | Haiku |
|---|---|---|---|---|
| Arabic dialect | 37% | 80% | 100% | 89% |
| Console intent | 60% | 100% | 100% | 100% |
| Router escalation | 63% | 93% | 100% | 93% |
| Feedback triage | 40% | 95% | 98% | 95% |
| Moderation | 42% | 86% | 94% | 83% |
| Reddit relevance | 22% | 69% | 72% | 83% |

It beat the best Laya checkpoint on every set by 19-44 points. It matched Haiku
on three sets, beat it on moderation and lost on Reddit and Arabic. It answers in
~0.3 s from this box against Haiku's ~0.9 s, at **$0.018-0.020 per 1,000
decisions**, about 25 times cheaper than Haiku's $0.43-0.67. The whole run cost
$0.0043.

Three caveats:

- **Moderation.** Two of Jev's five misses let a post that needed a person
  (`review`) through as `allow` (mo-21, mo-25). Haiku's misses all went to review.
- **Reddit.** Jev over-rates posts, like Gemma: eight `low` posts called `medium`.
- **Calibration.** Its ECE is 0.014-0.12, except Reddit at 0.31.

The labels were written by a Claude session; if that biases anything, it is
toward Claude Haiku's reading.

| Use case | Use | Not | Why |
|---|---|---|---|
| **Router escalation**: local or cloud? (AI Router) | `local-gemma4` (100%) when loaded; `local-small` (98%, 161 ms) as the resident choice; Haiku or Jev (both 93%) if neither is up | Laya (60-65%) | Laya answers "local" 95% of the time, which is the majority class. Local models are good at knowing what a local model can do. |
| **Feedback triage** (Globe Quest) | Jev or Claude Haiku (both 95%), called **by globe_quest with its own key** | anything on this box, however good (Gemma 98%); Laya (35-40%, typed-decisions 63%) | Globe Quest is a cloud project and must not call this box. Jev costs ~$0.02 per 1,000 issues, Haiku ~$0.64; at Globe Quest's volume either is pennies. |
| **Moderation** (Globe Quest feed, Ask Locals) | Claude Haiku (83%) from globe_quest, with a person on "review" | anything on this box (Gemma 94%); Laya (39-42%) | Same boundary. Haiku's six misses are all in the safe direction: every one was sent to "review". Jev scored higher (86%), but two of its misses let a `review` post through as `allow`. |
| **Reddit relevance** (reddit-scout) | Claude Haiku (83%) in place of the keyword score | Gemma (72%), Jev (69%), `local-small` (61%), the keyword heuristic (44%), Laya (17-50%) | The one set where Haiku beats Gemma. Both over-rate borderline posts as "high". This is judgement about intent. |
| **Console intent** | `local-gemma4` (100%) when loaded, `local-small` (88%) resident, Haiku or Jev (both 100%) | Laya alone (52-64%) | All local and fast enough. The Laya-first cascade saves 21% of Haiku calls, which is not worth it. |
| **Arabic dialect** | `local-gemma4` (100%), matching the Arabic experiment's pick; Haiku (89%) when it will not fit | Jev (80%), Laya (23-37%), `local-small` (31%) | Laya routes Arabic to the right checkpoint, but that checkpoint cannot tell dialects apart: it calls most of them MSA or Gulf. |

**For a local LLM decider, turn its reasoning off.** Gemma 4 via Ollama reasons
by default, even for a one-word answer. `/api/decide` now sends it
`extra_body: {reasoning_effort: "none"}`. On the resident model that cut 177
completion tokens and 662 characters of reasoning to 2 tokens and none, and
~3 s to 115-194 ms, with the same answer. The field has to be in `extra_body`:
under the router's `drop_params`, a bare `reasoning_effort` is **dropped
silently** for an unrecognised model on the openai provider. That was verified
against the router's own litellm with an echo server, then end to end.

**Keep Laya installed, stopped by default, on CPU.** It is the decision model
behind the Decision Lab and the BPMN gateways (06), and those are experiments.
On this machine, holding it resident was never free:

- On the GPU it holds 5.7 GB, and during this run the coordinator refused to
  start it for lack of that room.
- On CPU it holds 3.7-5.5 GB of RAM. That is also contended: Qwen-Image's load
  crashed at 0.3 GB of free RAM while this ran.
- Under that pressure, Windows trims an idle CPU service's working set. The
  morning after, Laya's had shrunk from 3.7 GB to 1.5 GB, and its first
  decision took 13.4 s while the weights paged back in. The next ones took
  0.74, 0.41, 0.33 and 0.20 s. A caller that needs a steady ~0.2 s has to keep
  it warm, or accept a slow first call after idle.

**Reconsider it if**

1. **A decision is coarse and vocabulary-level** (topic, language, "is this
   about billing"). There it is as good as the vendor says and 5-30x faster
   than a cloud LLM call. It is no faster than the resident 7B model.
2. **Someone fine-tunes it.** The vendor's own numbers say its accuracy comes
   from fine-tuning (0.36 → 0.77 on their benchmark). Tens of labelled items per
   task, as here, are enough to *measure* it, not to *train* it.
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

### How Gemma 4 got measured

The first two attempts failed:

1. **During another session's GPU claim.** The run started inside 3D's claim,
   which this session had not seen. It was stopped and unloaded within minutes.
   It was reasoning then, at over 15 s a decision.
2. **Refused by the coordinator.** *"VRAM needs 20 GB more … but only 9.21 GB
   is currently free"*, while quote-forge's `vllm-small` was resident.

It ran on 28 September, in a window where `vllm-small` was paused and the
sessions agreed an order for the card. By then the reasoning switch was in
place. Its misses are nearly all items marked borderline when they were
labelled (ft-37, mo-23, mo-28). The exception is Reddit, where it over-rates
"medium" posts as "high": seven of its ten misses there.

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
| 7.8x faster than Jev | **Faster, yes; better, no.** Measured 2 October through OpenRouter (`typesafe/jev-1.13`, $0.042 / M input tokens; a TypeSafe waitlist when this experiment began). Jev's p50 is 312-335 ms per decision from this box, network included; Laya's is 30-56 ms on the GPU (6-10x faster) and 93-235 ms on CPU (1.5-3x). The card's accuracy comparison (Laya 0.766 vs Jev 0.727) uses the *fine-tuned* typed-decisions checkpoint; zero-shot on these sets Jev beat the best Laya checkpoint by 19-44 points. | ✔ speed / ✘ as a reason to pick Laya |

## Measured

Every row goes through `POST /api/decide` on BeTenshi. Laya runs on the GPU here (its CPU latency is under *Speed*). **Bold** marks the best accuracy on each set. `local-small` is Qwen2.5-7B-Instruct-AWQ on vLLM. `local-gemma4` is Gemma 4 31B QAT on Ollama with reasoning off. `jev` is TypeSafe's Jev 1.13 through OpenRouter, added on 2 October. Cost is the router's own figure; Jev's is OpenRouter's `usage.cost`.

### Arabic dialect — n=35, 5 labels (chance 20%)

| model | accuracy | macro F1 | ECE | ECE, tempered | Brier | p50 | p95 | $ / 1,000 |
|---|---|---|---|---|---|---|---|---|
| laya | 37% | 29% | 0.201 | 0.132 | 0.905 | 30 ms | 42 ms | local |
| laya-english | 23% | 17% | 0.117 | 0.005 | 0.817 | 45 ms | 101 ms | local |
| laya-multilingual | 37% | 29% | 0.201 | 0.132 | 0.905 | 56 ms | 131 ms | local |
| laya-typed-decisions | 29% | 18% | 0.075 | 0.032 | 0.796 | 53 ms | 140 ms | local |
| local-small | 31% | 26% | 0.548 | 0.142 | 1.145 | 346 ms | 375 ms | local |
| local-gemma4 | **100%** | 100% | 0.123 | 0.006 | 0.048 | 1.3 s | 1.5 s | local |
| claude-haiku | 89% | 88% | 0.059 | 0.116 | 0.204 | 1.2 s | 3.2 s | $0.60 |
| jev | 80% | 79% | 0.121 | 0.056 | 0.299 | 335 ms | 868 ms | $0.02 |

### Console intent — n=42, 7 labels (chance 14%)

| model | accuracy | macro F1 | ECE | ECE, tempered | Brier | p50 | p95 | $ / 1,000 |
|---|---|---|---|---|---|---|---|---|
| laya | 60% | 59% | 0.222 | 0.235 | 0.583 | 46 ms | 64 ms | local |
| laya-english | 60% | 60% | 0.171 | 0.186 | 0.571 | 38 ms | 51 ms | local |
| laya-multilingual | 52% | 51% | 0.316 | 0.202 | 0.689 | 36 ms | 60 ms | local |
| laya-typed-decisions | 64% | 62% | 0.145 | 0.097 | 0.487 | 102 ms | 183 ms | local |
| local-small | 88% | 89% | 0.245 | 0.524 | 0.300 | 374 ms | 384 ms | local |
| local-gemma4 | **100%** | 100% | 0.068 | 0.000 | 0.014 | 1.4 s | 1.6 s | local |
| claude-haiku | **100%** | 100% | 0.090 | 0.000 | 0.014 | 1.2 s | 1.8 s | $0.67 |
| jev | **100%** | 100% | 0.014 | 0.000 | 0.003 | 324 ms | 350 ms | $0.02 |

### Feedback triage (Globe Quest) — n=40, 5 labels (chance 20%)

| model | accuracy | macro F1 | ECE | ECE, tempered | Brier | p50 | p95 | $ / 1,000 |
|---|---|---|---|---|---|---|---|---|
| laya | 40% | 33% | 0.194 | 0.196 | 0.672 | 56 ms | 129 ms | local |
| laya-english | 38% | 29% | 0.180 | 0.207 | 0.678 | 55 ms | 92 ms | local |
| laya-multilingual | 35% | 26% | 0.381 | 0.120 | 1.007 | 42 ms | 65 ms | local |
| laya-typed-decisions | 63% | 60% | 0.306 | 0.215 | 0.663 | 52 ms | 81 ms | local |
| local-small | 90% | 90% | 0.079 | 0.056 | 0.171 | 308 ms | 323 ms | local |
| local-gemma4 | **98%** | 97% | 0.070 | 0.043 | 0.060 | 1.3 s | 2.0 s | local |
| claude-haiku | 95% | 95% | 0.106 | 0.059 | 0.085 | 1.0 s | 2.4 s | $0.64 |
| jev | 95% | 95% | 0.056 | 0.092 | 0.101 | 317 ms | 387 ms | $0.02 |

### Moderation (community feed and Ask Locals) — n=36, 3 labels (chance 33%)

| model | accuracy | macro F1 | ECE | ECE, tempered | Brier | p50 | p95 | $ / 1,000 |
|---|---|---|---|---|---|---|---|---|
| laya | 42% | 33% | 0.093 | 0.072 | 0.627 | 54 ms | 117 ms | local |
| laya-english | 39% | 30% | 0.068 | 0.019 | 0.652 | 49 ms | 64 ms | local |
| laya-multilingual | 39% | 37% | 0.264 | 0.133 | 0.706 | 48 ms | 118 ms | local |
| laya-typed-decisions | 39% | 36% | 0.077 | 0.120 | 0.658 | 43 ms | 66 ms | local |
| local-small | 83% | 81% | 0.149 | 0.232 | 0.312 | 190 ms | 225 ms | local |
| local-gemma4 | **94%** | 92% | 0.099 | 0.050 | 0.103 | 904 ms | 971 ms | local |
| claude-haiku | 83% | 82% | 0.106 | 0.042 | 0.225 | 908 ms | 1.5 s | $0.46 |
| jev | 86% | 83% | 0.111 | 0.099 | 0.143 | 312 ms | 345 ms | $0.02 |

### Reddit relevance (reddit-scout) — n=36, 3 labels (chance 33%)

| model | accuracy | macro F1 | ECE | ECE, tempered | Brier | p50 | p95 | $ / 1,000 |
|---|---|---|---|---|---|---|---|---|
| laya | 22% | 19% | 0.279 | 0.127 | 0.772 | 44 ms | 58 ms | local |
| laya-english | 22% | 19% | 0.279 | 0.127 | 0.772 | 49 ms | 85 ms | local |
| laya-multilingual | 50% | 43% | 0.177 | 0.177 | 0.655 | 37 ms | 49 ms | local |
| laya-typed-decisions | 17% | 10% | 0.279 | 0.178 | 0.721 | 45 ms | 81 ms | local |
| local-small | 61% | 49% | 0.286 | 0.145 | 0.670 | 204 ms | 273 ms | local |
| local-gemma4 | 72% | 55% | 0.146 | 0.250 | 0.401 | 819 ms | 1.0 s | local |
| claude-haiku | **83%** | 77% | 0.091 | 0.044 | 0.279 | 880 ms | 1.7 s | $0.51 |
| jev | 69% | 61% | 0.306 | 0.143 | 0.463 | 323 ms | 414 ms | $0.02 |
| reddit-scout-heuristic | 44% | 45% | 0.556 | 0.221 | 1.111 | 0 ms | 0 ms | local |

### Router escalation — n=40, 2 labels (chance 50%)

| model | accuracy | macro F1 | ECE | ECE, tempered | Brier | p50 | p95 | $ / 1,000 |
|---|---|---|---|---|---|---|---|---|
| laya | 63% | 48% | 0.121 | 0.100 | 0.412 | 46 ms | 75 ms | local |
| laya-english | 63% | 48% | 0.102 | 0.096 | 0.418 | 47 ms | 73 ms | local |
| laya-multilingual | 60% | 56% | 0.120 | 0.110 | 0.501 | 34 ms | 89 ms | local |
| laya-typed-decisions | 65% | 56% | 0.089 | 0.155 | 0.434 | 43 ms | 57 ms | local |
| local-small | 98% | 97% | 0.056 | 0.012 | 0.064 | 161 ms | 174 ms | local |
| local-gemma4 | **100%** | 100% | 0.083 | 0.001 | 0.028 | 632 ms | 759 ms | local |
| claude-haiku | 93% | 92% | 0.061 | 0.032 | 0.121 | 829 ms | 1.5 s | $0.43 |
| jev | 93% | 92% | 0.049 | 0.038 | 0.094 | 323 ms | 389 ms | $0.02 |

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

| | Laya, GPU | Laya, CPU | Qwen2.5-7B (`local-small`) | Gemma 4 31B, reasoning off | Jev (OpenRouter) | Claude Haiku |
|---|---|---|---|---|---|---|
| p50, one decision, end to end | 30-56 ms (p95 42-129 ms) | 93-235 ms (p95 125-481 ms) | 161-374 ms (p95 174-384 ms) | 0.6-1.4 s (p95 0.8-2.0 s) | 312-335 ms (p95 345-868 ms) | 0.8-1.2 s (p95 1.5-3.2 s) |
| Memory held | 5.7 GB VRAM (all three checkpoints) | 3.7 GB RAM (two checkpoints), 5.5 GB with typed-decisions; 0 VRAM | ~13 GB VRAM (vLLM, held for quote-forge anyway) | ~20 GB VRAM while loaded (Ollama evicts it when idle) | — | — |
| Cost per 1,000 decisions | local | local | local | local | $0.018-0.020 (OpenRouter's figure) | $0.43-0.67 (router-metered) |

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
  probabilities, latency. Local Ollama models are asked with reasoning off. Jev is
  a cloud decision model, called through OpenRouter directly: it is not a chat
  model, so the router cannot carry it. The same shape from Laya or from any router chat
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
- **Jev is asked natively**, not with the LLM prompt: the question becomes one
  System One `choice` question with each label's description as its criterion,
  and Jev returns the distribution itself. It was added on 2 October to the same
  results file, so every model's other numbers are unchanged.
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
