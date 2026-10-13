# Process lab — 27 September 2026

## Recommendation

**The architecture works end to end on this box, and each kind of decision has a clear place:**

- **The engine** carries the structure: sequence, timers, rework loops, human tasks, escalation.
- **DMN** carries every rule that can be written down.
- **A decision model**, then an LLM, then a person, handle the typed judgement at intake.
- **An LLM** does the unstructured work: reading documents, including Arabic; drafting client emails in the client's language; briefing the reviewer.

In the final measured runs, every AI hand-off was recorded with its model, confidence, latency and cost, and a person's disagreement with the AI was recorded as such.

**Split the LLM work by kind:**
- **Generation from a structured brief** (client emails) runs well on a small local model: sub-second, one check failure in 36.
- **Judgement** (triage behind Laya, the reviewer's brief) needs a stronger model. With Haiku there, 14 to 15 of 16 cases ended right, as the right service. With the local 7B there, 12 of 16.
- **Gemma 4 31B**, the box's strong local model, never answered a lab call. It was loaded once, early, and unloaded at another session's request before a call completed on it. After that, other sessions' GPU claims or the coordinator kept it off the card: the user's own app keeps a 13 GB vLLM resident, and the coordinator correctly refused Gemma's 20 GB. So the judgement steps ran on the cloud fallback, and every such decision says so.

Use **Operaton 2.1.4** (Apache 2.0, the Camunda 7 fork) as the engine. The reasons are in `process-lab/docs/engine-choice.md`. In short:

- Camunda 8 needs a paid licence for production from 8.6.
- Flowable's open edition has no UI, and its agent features are Enterprise-only.
- SpiffWorkflow's DMN is a "baseline implementation" under LGPL.

**What earned its place, and what did not:**

| Decision | Earned it? | Evidence |
|---|---|---|
| **DMN** for eligibility, entry, residency route, income floor, school age, EU licence recognition, fees, SLAs, required documents, document language | **Yes, unreservedly.** | 4 ms median; every result traceable to a rule row; a rule gap found in testing was fixed by adding one table row and redeploying, with no code change. |
| **LLM** reading documents | **Yes.** | 95.7% of fields right across 43 documents, including every Arabic one. The one unreadable scan was flagged for a person, as designed. |
| **LLM** drafting client emails | **Yes, and locally.** | A resident 7B (Qwen2.5-7B) drafted 35 of 36 emails correctly in under a second each. The step's own check sent the one bad one (an English subject on an Arabic email) to the cloud. |
| **LLM** case brief for the reviewer | **Yes, with a strong model and context.** | Haiku caught every inconsistency I had accidentally planted in the synthetic data. Without context it also rejected every case for its SPECIMEN watermark, and called a lease that began last month "future-dated". The local 7B rubber-stamped everything at 0.95. |
| **Decision model (Laya)** as tier 1 of triage | **Yes, as a first pass.** | On CPU at ~0.3 s it settled 15 of 23 intake questions alone in the live run, and passed the unsure ones on. Alone it gets only 16 of 24 right, against Haiku's 22. Its one confident error (0.93) is the case the tiers cannot catch. |
| **LLM** as tier 2 of triage | **Yes, a strong one.** | Haiku was right on 7 of the 8 questions Laya passed on; the eighth was the deliberately vague request, correctly left to a person. The local 7B got 3 of 8, and filed three residency clients as visa applications. Asked everything (the triage-only evaluation), Haiku got 22 of 24. |
| **Spoken status update** | **No.** | Not exercised with a running voice service; see below. |

**What has to change to run a real process on it** is at the end. The short list:

- A real database.
- Engine authentication.
- A client channel.
- Consent for any cloud call on personal data.
- A business calendar instead of simulated days.
- Thresholds calibrated on labelled real requests.

## What was built

| Part | Where |
|---|---|
| Engine (Operaton 2.1.4, Docker, loopback :8085, H2 in a volume) | `C:\Users\Admin\Code\AI\process-lab\docker-compose.yml` |
| Service catalog: six services, six destinations | `process-lab/catalog/services.json` |
| BPMN: `relocation-case`, 34 nodes, timers, two rework loops, three human tasks, an escalation | `process-lab/bpmn/relocation-case.bpmn` |
| DMN: a DRD `eligibility` ← `entry-policy` + `residency-route`; `service-terms`, `required-documents`, `document-language` | `process-lab/dmn/*.dmn` |
| Fixtures from Globe Quest, read-only, with the source commit recorded | `process-lab/fixtures/` (globe_quest@9255358) |
| Workers (external tasks), simulator, JSON API on :8086 | `process-lab/src/` |
| Synthetic documents: passport, statements, letters, lease, birth certificate, licence, police certificate; English, Arabic, Spanish, German; clean and degraded | `process-lab/render/render_docs.py` |
| Console entry: **Process Lab** tab | `src/components/labs/process-lab.tsx` |
| MCP tool `process_lab` | `scripts/mcp-betenshi.mjs` |

The Process Lab tab has five views:
- **Services**: engine, lab, Laya, Ollama and voice, each with Start and Stop, plus links to Cockpit and Tasklist.
- **Cases**: each instance on its BPMN diagram (bpmn-js) with the current step in orange and the path taken in green, and a per-case table of every decision: its kind, what it decided, confidence, time, model, cloud cost, hand-offs, overrides and correctness against ground truth. Also the documents, the emails and any audio.
- **Inbox**: the three human tasks, with the AI's suggestion beside each form.
- **Simulate**: 16 scenarios, or one real case by hand, with a document upload.
- **Numbers**: cycle time, where cases wait, hand-off and override rates, reading accuracy, cost.

### The process

```
Request → [decision model → LLM → person] classify → DMN fee/SLA → DMN required documents
  → LLM asks for documents → wait (message) | timer → LLM reminder → give up after 2
  → LLM reads each document; DMN decides whether its language is accepted
  → [person verifies anything read with confidence < 0.6]
  → complete? else ask again (max 3 rounds)
  → DMN eligibility (DRD) → ineligible / not-required → LLM closing email
  → LLM case brief + recommendation → person approves (timer escalates if overdue)
  → submit → timer → (simulated) authority: granted / refused / more-info (loops back for a police certificate)
  → LLM good-news email (+ spoken update if a voice service is up)
```

All timers are `PT${n * secondsPerDay}S`. A simulation runs at 10 s per day; a real case would run at 86 400.

### The three kinds of decision, and the tiers

| Kind | Executed by | Recorded in |
|---|---|---|
| DMN | the engine: business-rule tasks, plus `document-language` evaluated per document by the reader worker | the engine's decision history, with inputs, outputs and matched rule |
| Decision model | `POST /api/decide` on the console (brief 05), model `laya` | the lab's ledger |
| LLM | the AI Router: local `local-gemma4` first, `claude-haiku` when local is unavailable or its answer fails the step's check | the ledger, with every attempt, including failed local ones |
| Human | the Inbox or Tasklist | the ledger, linked to the AI decision it reviewed, marked as an override when it disagreed |

The triage question runs in tiers:
1. Laya.
2. Below 0.7, or on "unclear", the same `/api/decide` request to an LLM.
3. Below 0.7 again, a person.

"Local unavailable" means one of three things:
- the resource coordinator refused the `ollama-chat` lease;
- another session holds a claim under 30 minutes old in `logs/gpu-claim.txt` (the sessions sharing the card use this file);
- the local answer failed the step's check.

## Three measured runs, side by side

Every AI step runs local first. What "local" could mean today was set by the box, not by the design:

- **Gemma 4 could not stay loaded.** The 31B needs 20 GB. The one early load was given back to a session measuring 3D. After that, the user's quote-forge app kept `vllm-small` (Qwen2.5-7B, 13 GB) resident and in use, and the coordinator refused Gemma.
- **The GPU was shared.** Four other exploration sessions measured on the card in turn, coordinating through `logs/gpu-claim.txt`.

So the local text model in the third run is **`local-small`**, already resident, so it costs no new memory, with Laya on CPU in front of it. Document reading, which needs a vision model, went to the cloud in every run: while another session's claim was fresh, the lab never even queued for Gemma.

| | A: cloud tiers | B: Laya → Haiku | C: Laya → local-small |
|---|---|---|---|
| Run | `SIM2609271639` | `SIM2609271711` | `SIM2609271829` |
| Triage tier 1 | (Laya down) | Laya (CPU) | Laya (CPU) |
| Triage tier 2, emails, case brief | Claude Haiku | Claude Haiku | **local-small**, Haiku only on a failed check |
| Document reading | Haiku (GPU claimed) | reading bug; all to people | Haiku (GPU claimed) |
| **Right ending, as the right service** | **14 / 16** | **15 / 16** | **12 / 16** |
| Triage tier 2 right | 94% service, 75% purpose (tier 2 was everything) | 7 / 8 | **3 / 8** |
| Case briefs a person overrode | 0 | 0 | 1 of 13 |
| Document fields read right | 95.7% | n/a (bug) | 96.4% |
| Emails drafted locally | 0 | 0 | **35 / 36** (median 0.75 s; one Arabic email fell back) |
| Median LLM step | 2.2 s | 2.2 s | **0.84 s** |
| Cloud cost | $0.181 | $0.063 | $0.089 |

**What the local run shows:**

- **Drafting emails from a brief is a local job.**
  - Qwen2.5-7B wrote 35 of 36 emails, correctly, in under a second each.
  - The one failure: an Arabic body under an English subject, missing its first letter. The step's own check caught it, and it went to the cloud with the reason recorded.
  - "Local first, cloud when local is not good enough" worked as designed: one fallback in 36, for $0.001.
- **Triage is not a 7B job.**
  - `local-small` got 3 of the 8 questions Laya passed on right. It called three residency-permit clients "visa-application".
  - Each of them then went down the visa branch. The rules did exactly what they should for a visa, and the ending looked plausible: "completed", or "refused".
  - The earlier scoring missed this. Scoring now requires the right service as well as the right ending. Under that scoring the local run is 12 of 16, against 14 and 15 with Haiku as tier 2.
- **The case brief is not a 7B job either.**
  - `local-small` recommended "submit" at 0.95 with boilerplate reasons ("documents valid and consistent") on nearly every case.
  - It waved through a nurse whose case had been filed as a visa application.
  - Haiku's briefs found real contradictions in the same data.
- **What this means for the design.**
  - Local model for generation from a structured brief. A stronger model (Gemma 4 when it can load, the cloud when it cannot) for judgement.
  - The lab now takes `LOCAL_DRAFT_MODEL` for exactly this. Set it to `local-small` in the `process-lab` entry of `scripts/service-commands.json` to adopt it; it is not set there yet.
  - The simulated consultant now also declines a case filed under the wrong service, as a real one would. This was added after this run.

**Gemma 4 itself was not measured in this process.** No lab call completed on it. The Arabic experiment's numbers for it stand (`docs/arabic-model-experiment-2026-09-14.md`).

The lab now asks Ollama for no reasoning through `extra_body.reasoning_effort: "none"`. Brief 05 has since confirmed it end to end on resident Gemma 4 through the router: without it, about 3 s and 662 characters of reasoning; with it, 0.12 to 0.19 s, no reasoning, the same answer.

Brief 05 also measured Gemma 4 as a decider with the switch on, on its own sets:
- It beat Haiku on five of six sets, at 0.6 to 1.4 s.
- It needs the ~20 GB window, so it is available only when `vllm-small` is down.

That makes it the natural tier 2 for this lab's triage whenever it can load.

## Run A in detail: the cloud-fallback run

Run `SIM2609271639`, 27 Sep 16:39Z:
- **Conditions.** 16 synthetic clients at 10 s per simulated day, with the simulated consultant working the inbox. During the whole run the GPU was held by the 3D exploration's claim and Laya was stopped for its move to CPU. So **every AI step ran on Claude Haiku through the router**, as the recorded fallback. Every such decision says so.
- **Scope of the numbers.** They describe the process and the cloud model, not the local stack.

| Metric | Value |
|---|---|
| Right ending vs ground truth | **14 / 16** |
| Cycle time, simulated days | median 13.4, mean 15.1, max 47.5 |
| Completed within the service's SLA | 9 / 9 |
| AI judgements handed to a person | 2 / 67 (3%): one vague request, one unreadable scan |
| Person overrode the AI | 0 / 15 reviews |
| Document fields read correctly | 156 / 163 (95.7%) over 43 documents; Arabic 16/16 |
| Decisions: LLM / DMN / human / system | 119 / 90 / 15 / 32 |
| Median latency: DMN / LLM / human | 4 ms / 2.2 s / 18 s (simulated consultant think-time) |
| Cloud cost for the run | $0.18 (119 Haiku calls) |

The two wrong endings are the two findings below: the French passport, and the purpose misread as "work".

Endings: completed 9 · ineligible 1 · declined by the consultant 2 · no reply 1 · not required 1 · refused by the authority 1 · documents incomplete 1.

**Where cases wait** (share of all case time):

| Step | Share | Mean per visit |
|---|---|---|
| Await authority decision | 47.6% | 10.4 d |
| Wait for client | 22.7% | 2.5 d |
| Approve submission (person) | 11.2% | 2.1 d |
| Read documents (AI) | 4.8% | 0.6 d |
| Ask client for documents (AI) | 3.3% | 0.4 d |
| Summarise case (AI) | 2.2% | 0.4 d |
| Classify request (AI) | 1.7% | 0.3 d |

AI steps show up at all only because simulated time is compressed: a 2-second call is a fifth of a day at 10 s per day. At real time scale they vanish.

### Triage alone: Laya against an LLM, on the same 24 questions

Laya came back, on CPU, after the run. So the triage question was measured on its own, per model:
- **Set:** the 16 scenario requests, 8 of which also ask the purpose question.
- **Shape:** the exact questions and choice descriptions the classify worker sends.
- **Script:** `process-lab/scripts/triage-eval.mjs`.

| Model | Right | Median latency | Answers alone at ≥ 0.7 | Wrong among those | Cost |
|---|---|---|---|---|---|
| Laya (CPU) | 16 / 24 | 308 ms | 15 / 24 | 1 | not metered |
| Claude Haiku | 22 / 24 | 1.1 s | 23 / 24 | 1 | $0.021 |

Laya's misses split two ways:
- **Mostly** it says "unclear" or scores below 0.5. The tier design passes these on to the LLM, which is what the threshold is for.
- **One confident error:** "…want the Portuguese digital nomad visa…" came back "visa-application" at 0.93. A calibrated model can still be confidently wrong on a label whose name contains the answer's words.

So in tiers, Laya settles ~60% of intake questions in a third of a second, with one error in fifteen, and the LLM handles the rest. That matches brief 05's recommendation (`docs/decision-model-experiment-2026-09-27.md`): Laya first, escalate below a threshold. It is not a replacement for the LLM on this task.

Haiku's two misses:
- **The vague request.** Correctly "unclear", which the process sends to a person.
- **The retiree who wants to live "near my daughter".** Read as "family" at 0.85.

In the full run, the same model misread a different purpose ("digital nomad" as "work", 0.75), so **run-to-run variation at temperature 0 is real**.

### The tiers live in the process: run `SIM2609271711`

Run `SIM2609271711`, 17:11Z: the same 16 cases with Laya up (CPU) as tier 1 and Haiku as tier 2, the GPU still claimed.

| Tier | Question | Answers | Right | Median latency |
|---|---|---|---|---|
| 1 · Laya | service | 16 | 56% | 306 ms |
| 1 · Laya | purpose | 7 | 86% | 211 ms |
| 2 · Haiku (only what Laya was unsure of) | service | 7 | 86% | 1.06 s |
| 2 · Haiku | purpose | 1 | 100% | 1.29 s |

- **Laya settled 15 of 23 answers alone** and handed 8 to the LLM.
- **One person.** The vague request reached a person, as designed.
- **Endings.** 15 of 16 were right.
- **One misroute, and the one wrong ending.** A confident Laya error ("visa-application", 0.93, for a request that names the digital nomad visa) sent the low-income nomad down the visa branch. There the entry rule correctly found that Brazilians need no short-stay visa for Portugal, and closed the case as "not required".
  - The rule was right for the question it was given. The question was wrong.
  - A confident tier-1 error is the one failure the tiers do not catch. Only the threshold, or a second question, can.
  - This argues for tuning Laya's threshold per label, or asking it the narrower question first ("short visit or long stay?").

**A bug found by this run, and what it showed.**
- **The bug.** A variable-shadowing error made every document reading fail before a model was called. So in this run all 40 documents went to "Verify documents".
- **The safety net held.** The process still ended right in 15 of 16 cases, because a person checked everything the AI could not. That is the design working as intended: a failing AI step turned into work for people, not into a wrong decision. It cost 40 human tasks, and the verification step became 14.5% of all case time.
- **The fix and the test.** The bug is fixed. `process-lab/test/workers.test.mjs` now runs the reader, the income guard and the local-to-cloud fallback against a stub router, so it cannot come back silently.
- **Which numbers to trust.** This run's reading, escalation and override figures measure the bug, not the models. The table above is only its triage tiers.

## Findings

**1. DMN was never the problem; its inputs were.**
- The only eligibility result that disagreed with the ground truth came from a purpose the LLM got wrong: "work" instead of "nomad", at 0.75.
- The work route has no written income floor, so the case was ruled eligible. The consultant then declined it.
- Rules are exactly as good as the facts handed to them. That is the argument for keeping the fact-finding (AI) and the rule (DMN) as separate, separately recorded steps.

**2. The tests found a rule gap that no one would have written down in advance.**
- A French passport was read as a French-language document, and the document-language table asked for a certified translation of the client's passport, three rounds in a row, until the case gave up.
- Passports are never translated: ICAO 9303 data pages are machine-readable Latin script.
- The fix was one DMN row keyed on the document type, deployed as `document-language v2` with no code change.

**3. The LLM brief is a better reviewer than expected, and needs to be told the rules of the game.**
- In the first full run it recommended "decline" on 7 of 8 cases. It saw the SPECIMEN watermark every synthetic document carries by design, and called the documents fake.
- It also found real contradictions I had introduced by accident: a nurse whose letter said "Senior Data Engineer", and a lease starting after the date the client said they already lived there.
- Told that the case is a simulation and the watermark is intentional, and given today's date, it stopped flagging the watermark and still reasons about everything else.
- Models do not know today's date. Every prompt that judges a date now carries it.

**4. Read the fact, then apply the rule in code.**
- The reader reported a lease's rent as "monthly income".
- The worker now keeps income only from bank statements and employment letters.
- A written rule should not depend on a prompt being obeyed.

**5. A model's self-reported confidence is not a probability.**
- Haiku put "digital nomad visa" at 0.20 nomad and 0.75 work.
- A 0.7 threshold let that through.
- This is brief 05's point about calibration, seen here in the wild.

**6. Where cases wait is outside the agency.**
- About 48% of case time was the authority and about 23% the client (run A).
- Of the time under the agency's control, the consultant's approval (about 11%) dominates.
- AI processing is a few percent, even with each 2 s call counted as 0.2 of a simulated day.

**7. Engine behaviours worth knowing:**
- **Json variables.** Operaton returns Json variables as a Spin node dump unless asked with `deserializeValues=false`.
- **Timers.** Timers fire up to about 5 s late at default job-executor settings.
- **Killed workers.** A killed worker's long-poll can still lock a task after its successor started. The lab sweeps stale locks twice on boot.
- **History TTL.** Operaton 2.x refuses any process or decision without `historyTimeToLive`.

## The spoken status update

The notify step calls the voice service (Chatterbox at :8004, else Kokoro at :8002) when one is running, and records "skipped" with the reason when none is. Neither was running during the measured runs, so it was skipped every time.

**Verdict: it has not earned its place.**
- A two-sentence spoken update carries nothing the email does not.
- It costs a GPU service being resident.
- A cloned voice speaking for an agency to a client raises consent questions the email does not.

Keep the step as an option; do not turn it on for real clients.

## What would have to change to run a real process on it

- **Database.** H2 in a Docker volume would become PostgreSQL, with backups, history cleanup scheduled, and the lab's sqlite ledger moved into the same database or tied to the engine's history.
- **Security.**
  - The engine REST API is unauthenticated and bound to loopback. It would need authentication (basic or OIDC), real users and groups instead of `demo/demo`, and TLS.
  - Human tasks would be assigned to named consultants with notifications, not to one "consultants" group.
- **Client channel.**
  - Documents arrive today by `POST /api/cases/:key/documents` or from the simulator. A portal or inbound email would need identity verification and message correlation from it.
  - The emails are drafted and stored, not sent.
- **Personal data.**
  - Passports, bank statements and birth certificates are special-category material.
  - Local first matters here. The cloud fallback must be **off** (`WHEN_LOCAL_UNAVAILABLE=fail`) unless the client consented and a data-processing agreement covers the vendor.
  - Rendered-document storage needs retention rules and encryption at rest.
- **Rules ownership.**
  - The entry and residency tables are generated from Globe Quest's curated data (verified July 2026).
  - The income floors are a hand-curated overlay that moves every January.
  - A real deployment needs a named owner and a review date on each table. DMN's versioning makes each change auditable, and the engine keeps which version decided each case.
- **Calendar.** `secondsPerDay` would become business days, with a working-day calendar for SLAs and reminder timers.
- **Calibration.** The 0.7 and 0.6 thresholds were chosen, not tuned. Tune them on a few hundred labelled real requests and documents, per model: Laya's probabilities and an LLM's are not comparable.
- **Legal.** In many jurisdictions immigration advice is regulated; the UK's OISC is one example. The AI drafts and briefs; a registered adviser must own every recommendation that reaches a client.
- **The authority** is simulated. A real one is a portal a person submits to, so that step would become a human task with the reference recorded.

## Verified versus assumed

**Verified on this box:**
- **Engine.** Operaton 2.1.4 executes the BPMN and DMN as written, including DRD required-decision outputs, COLLECT tables, FEEL expressions, boundary timers and message correlation.
- **Runs.** Every number above comes from runs stored in the engine's history and the lab's ledger.
- **Console.** The Process Lab tab was checked in the browser pane. The diagram with markers, the decision table, the inbox approve flow (a real click, recorded as an override of the AI's "decline"), the Numbers and Catalog views, and a manual case with document upload through the console proxy all worked.
- **Tests.** The process lab's 23 tests pass: units; engine-backed DMN checks; the triage tiers against a stub `/api/decide`; and the workers against a stub router. The console's `npm test` and `tsc` pass on the exact committed tree, checked out alone.
- **Operations.** Start and Stop from the console work for both services, through the manager: the engine as a Docker container, the lab as a spawned process. The engine restarted with its H2 data intact. The lab picked up interrupted simulation runs and stale task locks after a restart.

**Assumed, or not measured:**
- Laya on the GPU. It ran on CPU here, where brief 05 has moved it.
- Laya's calibration beyond these 24 questions.
- Throughput beyond 16 concurrent cases.
- Anything about real (non-synthetic) documents. Clean renders flatter every reader; only one heavily degraded scan was in the set.

**Licences:**
- Operaton, Apache 2.0.
- bpmn-js: the bpmn.io licence, MIT-like, which requires its watermark to stay visible. It does.
- Globe Quest's entry matrix derives from passport-index-data, MIT.

**Cost:** $0.71 of Claude Haiku across all 468 cloud calls in every run, including the development runs, plus $0.02 for the triage-only evaluation.
