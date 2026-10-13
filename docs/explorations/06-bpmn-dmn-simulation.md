# 06 — BPMN + DMN: a simulated business with real AI in it

> Paste into a fresh Claude Code session opened in
> `C:\Users\Admin\Code\AI\betenshi-console`. Best started after 05 has a working
> `/api/decide`; otherwise stub that step and come back.

---

Read `docs/explorations/README.md` first, then `docs/labs.md` if it exists.

I want the whole story working end to end on this box: a realistic **catalog of
services**, **real BPMN process definitions** executed by a real engine, **DMN
decision tables** for the rules, and **real AI** at the steps where judgement is
needed — then a simulation that pushes cases through and shows me what happened.

This is a larger project than the other briefs. It should live in **its own
directory** (for example `C:\Users\Admin\Code\AI\process-lab`), with the console
providing only an entry point: engine status with Start/Stop, the processes,
launch a simulation, and a link to the engine's own UI.

**The architecture this is testing** — the thing Camunda, Flowable and others
converged on in 2026 — is *deterministic structure, non-deterministic judgement
at the gateways*. Three kinds of decision, and the point is to see which kind
each step really needs:

- **DMN** for rules that can be written down (eligibility, fees, deadlines).
- **A decision model** (`/api/decide`, from brief 05) for bounded judgements
  learned from examples (triage, routing, risk).
- **An LLM** for unstructured work (reading a document, drafting a reply,
  summarising a case) — local first, cloud when local is not good enough, and
  the case record says which was used.

**Choose the engine on evidence.** Candidates: Camunda 8 (Zeebe; **its
self-managed licence changed and may require an enterprise licence for
production — check**), Flowable (Apache 2.0, added an agent engine in 2026),
Operaton (Apache 2.0 fork of Camunda 7), jBPM/Kogito, SpiffWorkflow (Python). I
want something I can run locally, that executes standard BPMN 2.0 and DMN 1.x
files, and whose licence does not trap me. Say why you picked it.

**The scenario — recommended, but propose better if you have it:** a
**relocation services agency**. It fits because the domain data already exists
in Globe Quest and exercises every AI capability on this box:

- **Service catalog:** visa application, residency permit, housing search, bank
  account opening, school enrolment, driving-licence conversion — each with
  inputs, SLAs, fees and required documents.
- **Processes:** client intake → document collection → eligibility check →
  case preparation → submission → follow-up, with timers, escalations, human
  review tasks and rework loops.
- **DMN:** visa eligibility by passport and destination — globe_quest already
  has a generated entry matrix and curated residency routes in
  `C:\Users\Admin\Code\hq\globe_quest\src\lib\data\visa\`. **Read it as
  fixtures. Do not modify globe_quest, and do not connect it to any local
  service** — it is a cloud project.
- **AI steps:** reading uploaded documents including Arabic (Gemma 4 won the
  Arabic OCR experiment), classifying incoming requests (`/api/decide`),
  drafting client emails (LLM), a spoken status update in a cloned voice
  (the TTS service) if it earns its place.

**The simulation:** generate synthetic clients and documents — the image models
can produce synthetic document images — and run them through. Include the cases
that break processes: missing documents, ineligible applicants, ambiguous
requests, a document in the wrong language, an applicant who never replies.

**What I want to see in the console:** each process instance on its diagram
with the current step highlighted (bpmn-js can render this); an inbox for the
human tasks; per-case history of every decision — which kind of decision, what
it decided, with what confidence, how long it took; and aggregate numbers —
cycle time, where cases wait, how often AI escalated to a human, how often the
human overrode it.

**Phase it**, and stop at each phase with something working:

1. Engine running locally, the catalog, one process and its DMN, executed by
   hand.
2. The AI steps wired in, each recording its decision and provenance.
3. The simulator and the console entry point with instance and inbox views.

**Deliverables:** the process lab, its BPMN and DMN files, the simulator, the
console entry, and `docs/process-lab-2026-09-XX.md` — what worked end to end,
where each kind of decision earned its place, and what I would need to change
to run a real process on it. Commit to `master` in whichever repo each part
lives in.
