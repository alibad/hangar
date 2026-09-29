"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import LabShell from "./lab-shell";
import type { LabComponentProps } from "@/lib/labs";
import type { LabRunResult } from "@/lib/lab-types";
import type { DecisionLabOutput } from "@/app/api/labs/decide/run/route";
import { choicesToText, itemContext, textToChoices, type LabelledSet } from "@/lib/decide-sets";
import type { DecideType } from "@/lib/decide";

/**
 * The Decision Lab: a question, typed choices and a context in; a probability
 * distribution out, from Laya or — in the comparison column — an LLM asked the
 * same question through /api/decide.
 *
 * The page is written for someone arriving cold. It opens with the question
 * the Lab answers and the answer, per task, in plain words; then numbered
 * steps to try one example by hand; the full measurements (calibration,
 * latency percentiles, cascades) stay available but folded, with a glossary.
 * The owner's first reaction to the measured-first version was that it was
 * too hard to follow.
 *
 * Presets are the labelled sets the experiment was measured on
 * (experiments/decide/sets), so any example can be re-run by hand and its label
 * checked against what each model says. Numbers come from the latest
 * scripts/decide-bench.mjs run.
 */

type Summary = {
  file: string;
  date: string;
  host: string;
  models: string[];
  sets: {
    id: string;
    title: string;
    n: number;
    labels: string[];
    scores: Record<string, ModelScore>;
    cascades?: {
      fallback: string;
      models: Record<string, { threshold: number | string; accuracy: number; escalated: number; costPer1000Usd: number | null }[]>;
    } | null;
  }[];
};

type ModelScore = {
  n: number;
  accuracy: number;
  macroF1: number;
  ece: number;
  eceAfterTemperature: number;
  brier: number;
  errors: number;
  unparsed: number;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  costPer1000Usd: number | null;
  reliability: { lo: number; hi: number; n: number; confidence: number; accuracy: number }[];
};

type SetsPayload = { sets: LabelledSet[]; summary: Summary | null };

/**
 * Each labelled set as a task a reader recognises, and what to use for it.
 * `use` mirrors the per-use-case table in the experiment doc
 * (docs/decision-model-experiment-2026-09-27.md); change both together.
 */
const TASKS: Record<string, { name: string; asks: string; use: string }> = {
  "feedback-triage": {
    name: "Feedback type",
    asks: "Is a Globe Quest report a bug, a feature request, a UI complaint, a content fix or noise?",
    use: "Claude Haiku, called by Globe Quest itself",
  },
  moderation: {
    name: "Moderation",
    asks: "Should a community post be allowed, held for review, or removed?",
    use: "Claude Haiku, with a person checking “review”",
  },
  "reddit-relevance": {
    name: "Reddit posts",
    asks: "Is this Reddit post a good one for reddit-scout to reply to?",
    use: "Claude Haiku",
  },
  "router-escalation": {
    name: "Local or cloud",
    asks: "Can a model on this machine handle this request, or does it need a cloud model?",
    use: "Gemma 4 or Qwen 7B, on this machine",
  },
  "console-intent": {
    name: "Console requests",
    asks: "Is a console message asking for chat, code, an image, speech, vision, a service or models?",
    use: "Gemma 4 or Qwen 7B, on this machine",
  },
  "arabic-dialect": {
    name: "Arabic dialect",
    asks: "Which variety of Arabic is this text: MSA, Egyptian, Levantine, Gulf or Maghrebi?",
    use: "Gemma 4; Claude Haiku when it can't load",
  },
};

const MODEL_NAMES: Record<string, string> = {
  laya: "Laya (picks its version)",
  "laya-english": "Laya, English version",
  "laya-multilingual": "Laya, multilingual version",
  "laya-typed-decisions": "Laya, typed-decisions version",
  "local-small": "Qwen 2.5 7B, this machine",
  "local-gemma4": "Gemma 4 31B, this machine",
  "claude-haiku": "Claude Haiku, cloud",
  "reddit-scout-heuristic": "reddit-scout's keyword score",
};
const modelName = (id: string) => MODEL_NAMES[id] ?? id;
const isLaya = (id: string) => id === "laya" || id.startsWith("laya-");

const inputCls =
  "w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-100 outline-none placeholder:text-gray-600 focus:border-gray-500";

export default function DecisionLab({ lab }: LabComponentProps) {
  const [question, setQuestion] = useState("");
  const [type, setType] = useState<DecideType>("choice");
  const [choicesText, setChoicesText] = useState("");
  const [context, setContext] = useState("");
  const [data, setData] = useState<SetsPayload | null>(null);
  const [presetSet, setPresetSet] = useState("");
  const [presetItem, setPresetItem] = useState("");

  useEffect(() => {
    fetch("/api/labs/decide/sets", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: SetsPayload) => setData(j))
      .catch(() => setData({ sets: [], summary: null }));
  }, []);

  const set = data?.sets.find((s) => s.id === presetSet);
  const expected = set?.items.find((i) => i.id === presetItem)?.label;

  const applySet = (id: string) => {
    setPresetSet(id);
    setPresetItem("");
    const s = data?.sets.find((x) => x.id === id);
    if (!s) return;
    setQuestion(s.question);
    setType(s.type);
    setChoicesText(choicesToText(s.choices));
    setContext("");
  };

  const applyItem = (id: string) => {
    setPresetItem(id);
    const item = set?.items.find((i) => i.id === id);
    if (set && item) setContext(itemContext(set, item));
  };

  const choices = useMemo(() => textToChoices(choicesText), [choicesText]);
  const canRun = !!question.trim() && (type === "yesno" || Object.keys(choices).length >= 2);

  return (
    <div className="space-y-5">
      <LabShell<DecisionLabOutput>
        lab={lab}
        canRun={canRun}
        compareLabel="Also ask an LLM, to compare"
        toolbar={
          <>
            <Overview summary={data?.summary ?? null} loading={!data} />
            <Step n={1} title="Choose who answers">
              Leave <b className="text-gray-200">laya</b> selected: it picks its English or multilingual version for each question by
              itself. The other three rows force one version, for testing. Laya runs on this machine&apos;s CPU and holds about 6 GB of
              RAM while started; if it shows as stopped, press Start and give it a minute.
            </Step>
          </>
        }
        input={
          <div className="space-y-4">
            <div className="space-y-2">
              <Step n={2} title="Pick a real example" inline>
                Each one has a correct answer, set by hand before any model saw it. Or leave the task on “write your own” and fill in the
                fields below.
              </Step>
              <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
                <select
                  value={presetSet}
                  onChange={(e) => applySet(e.target.value)}
                  aria-label="Labelled set"
                  className="rounded-md border border-gray-700 bg-gray-950 px-2 py-1.5 text-xs text-gray-200"
                >
                  <option value="">Task: write your own</option>
                  {data?.sets.map((s) => (
                    <option key={s.id} value={s.id}>
                      Task: {TASKS[s.id]?.name ?? s.title} ({s.items.length} examples)
                    </option>
                  ))}
                </select>
                {set && (
                  <select
                    value={presetItem}
                    onChange={(e) => applyItem(e.target.value)}
                    aria-label="Labelled example"
                    className="max-w-full rounded-md border border-gray-700 bg-gray-950 px-2 py-1.5 text-xs text-gray-200 sm:max-w-[30rem]"
                  >
                    <option value="">Pick an example…</option>
                    {set.items.map((i) => (
                      <option key={i.id} value={i.id}>
                        {(i.context ?? i.title ?? "").slice(0, 70)} → {i.label} ({i.id})
                      </option>
                    ))}
                  </select>
                )}
                {expected && (
                  <span
                    className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-300"
                    title="Set by hand when the example was written"
                  >
                    Correct answer: <b>{expected}</b>
                  </span>
                )}
              </div>
              {set && TASKS[set.id] && <p className="text-[11px] text-gray-500">{TASKS[set.id].asks}</p>}
            </div>

            <Field label="The question the model is asked">
              <input
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="e.g. Is this feedback a bug report?"
                aria-label="Question"
                className={inputCls}
              />
            </Field>

            <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-400">
                  <span className="font-medium text-gray-300">Kind of answer</span>
                  {(["choice", "yesno", "score"] as const).map((t) => (
                    <label key={t} className="flex items-center gap-1">
                      <input type="radio" name="decide-type" checked={type === t} onChange={() => setType(t)} className="accent-orange-500" />
                      {t === "yesno" ? "Yes or no" : t === "score" ? "A rating, low → high" : "Pick one"}
                    </label>
                  ))}
                </div>
                {type === "yesno" ? (
                  <p className="rounded-lg border border-dashed border-gray-800 px-3 py-6 text-xs text-gray-500">The answers are yes and no.</p>
                ) : (
                  <Field label="The possible answers" hint={type === "score" ? "lowest first, one per line" : "one per line, as  name: what it means"}>
                    <textarea
                      value={choicesText}
                      onChange={(e) => setChoicesText(e.target.value)}
                      rows={5}
                      placeholder={"bug: something is broken\nfeature_request: asks for something new\nnoise"}
                      aria-label="Choices"
                      className={`${inputCls} resize-y font-mono text-xs`}
                    />
                  </Field>
                )}
              </div>
              <Field label="The text to judge" hint="any language">
                <textarea
                  value={context}
                  onChange={(e) => setContext(e.target.value)}
                  rows={type === "yesno" ? 4 : 7}
                  placeholder="The feedback, post or message the decision is about."
                  aria-label="Context"
                  className={`${inputCls} resize-y`}
                />
              </Field>
            </div>

            <Step n={3} title="Run it" inline>
              Tick “Also ask an LLM” to see an LLM answer the same question beside Laya. Claude Haiku costs about $0.0005 a question; the
              local LLMs cost nothing but need room on the GPU.
            </Step>
          </div>
        }
        run={async (model, { compareGroup, signal }) => {
          const r = await fetch("/api/labs/decide/run", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: model.id, question, type, choices, context, compareGroup: compareGroup || null }),
            signal,
          });
          const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
          if (!r.ok) return { ok: false, model: model.id, local: model.local, error: j.error ?? `HTTP ${r.status}` };
          return j as LabRunResult<DecisionLabOutput>;
        }}
        renderOutput={(r) => (r.output ? <Distribution out={r.output} expected={expected} laya={isLaya(r.model)} /> : null)}
      />
      <Results summary={data?.summary ?? null} />
    </div>
  );
}

function Step({ n, title, inline, children }: { n: number; title: string; inline?: boolean; children: ReactNode }) {
  return (
    <div className={`flex gap-3 ${inline ? "" : "px-1"}`}>
      <span
        className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border border-orange-500/50 bg-orange-500/10 text-xs font-semibold text-orange-300"
        aria-hidden="true"
      >
        {n}
      </span>
      <div className="min-w-0">
        <h2 className="text-sm font-medium text-gray-100">
          <span className="sr-only">Step {n}: </span>
          {title}
        </h2>
        <p className="mt-0.5 text-xs leading-relaxed text-gray-400">{children}</p>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-gray-300">
        {label}
        {hint && <span className="ml-2 font-normal text-gray-500">{hint}</span>}
      </p>
      {children}
    </div>
  );
}

/**
 * The top of the page: what the Lab is for, the answer, and how each model did
 * on each task. Laya's figure is its best version on that task, which flatters
 * it; the verdict holds anyway.
 */
function Overview({ summary, loading }: { summary: Summary | null; loading: boolean }) {
  const rows = (summary?.sets ?? []).map((s) => {
    const laya = Object.entries(s.scores)
      .filter(([m]) => isLaya(m))
      .sort((a, b) => b[1].accuracy - a[1].accuracy)[0];
    return {
      id: s.id,
      n: s.n,
      task: TASKS[s.id],
      title: s.title,
      laya: laya ? { model: laya[0], accuracy: laya[1].accuracy } : null,
      gemma: s.scores["local-gemma4"]?.accuracy ?? null,
      haiku: s.scores["claude-haiku"]?.accuracy ?? null,
    };
  });
  const range = (xs: (number | null | undefined)[]) => {
    const v = xs.filter((x): x is number => x != null);
    return v.length ? `${pct(Math.min(...v))}–${pct(Math.max(...v))}` : null;
  };
  const layaRange = range(rows.map((r) => r.laya?.accuracy));
  const haikuRange = range(rows.map((r) => r.haiku));
  const gemmaRange = range(rows.map((r) => r.gemma));
  const examples = rows.reduce((a, r) => a + r.n, 0);

  return (
    <section className="space-y-4 rounded-xl border border-gray-800 bg-gray-900/40 p-4 sm:p-5" aria-labelledby="decide-overview">
      <div className="space-y-2">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-orange-300">What this Lab is for</p>
        <h2 id="decide-overview" className="text-lg font-semibold text-gray-50">
          Can a small, free model make our apps&apos; quick decisions instead of an LLM?
        </h2>
        <p className="max-w-4xl text-sm leading-relaxed text-gray-300">
          Several of our apps ask an AI the same kind of multiple-choice question over and over: is this feedback a bug? Should this
          post be removed? Today an LLM answers, and Claude Haiku costs about $0.50 per 1,000 questions.{" "}
          <b className="text-gray-100">Laya</b> is a small open model that runs free on this machine and answers in a fraction of a
          second. To see whether it could take over, we gave Laya and two LLMs the same{" "}
          {examples ? `${examples} ` : ""}examples. Each example has a correct answer, set by hand, and we counted how often each model
          got it right.
        </p>
      </div>

      <div className="rounded-lg border border-red-500/30 bg-red-500/[0.06] px-4 py-3">
        <p className="text-sm text-gray-100">
          <b className="text-red-300">The answer: no, not yet.</b>{" "}
          {layaRange && haikuRange ? (
            <>
              Laya got {layaRange} right, even taking its best version on each task. Claude Haiku got {haikuRange}
              {gemmaRange ? <>, and Gemma 4 on this machine got {gemmaRange}</> : null}.
            </>
          ) : (
            <>Laya was right far less often than the LLMs.</>
          )}
        </p>
        <p className="mt-1 text-xs leading-relaxed text-gray-400">
          Laya is quick, about 0.2 s a question here, but it tends to give the same answer to almost everything. It said “local” to 38 of
          40 routing requests. Speed doesn&apos;t help when the answer is wrong.
        </p>
      </div>

      {loading ? (
        <p className="text-xs text-gray-500">Loading the measurements…</p>
      ) : rows.length ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-medium text-gray-200">How often each model was right, task by task</h3>
            <Legend />
          </div>
          <ul className="divide-y divide-gray-800/70 rounded-lg border border-gray-800">
            {rows.map((r) => (
              <li key={r.id} className="grid gap-x-6 gap-y-2 px-3 py-3 md:grid-cols-[minmax(0,19rem)_minmax(0,1fr)]">
                <div className="min-w-0">
                  <p className="text-sm text-gray-100">
                    {r.task?.name ?? r.title} <span className="text-[11px] text-gray-500">{r.n} examples</span>
                  </p>
                  {r.task && <p className="text-[11px] leading-snug text-gray-500">{r.task.asks}</p>}
                  {r.task && (
                    <p className="mt-1 text-[11px] text-gray-400">
                      Use: <b className="font-medium text-emerald-300">{r.task.use}</b>
                    </p>
                  )}
                </div>
                <div className="space-y-1 self-center">
                  <Bar label="Laya" title={r.laya ? `best version: ${modelName(r.laya.model)}` : undefined} value={r.laya?.accuracy ?? null} color="bg-orange-500" />
                  <Bar label="Gemma 4" value={r.gemma} color="bg-emerald-500" />
                  <Bar label="Claude Haiku" value={r.haiku} color="bg-sky-500" />
                </div>
              </li>
            ))}
          </ul>
          <p className="text-[11px] leading-relaxed text-gray-500">
            Why Claude Haiku for the Globe Quest tasks, even where Gemma 4 scored higher: Globe Quest runs in the cloud and must not call
            this machine. Gemma 4 needs about 20 GB of the GPU, so it can only load when nothing big is running. The full numbers are at
            the bottom of the page.
          </p>
        </div>
      ) : (
        <p className="text-xs text-gray-500">No measurements yet: run node scripts/decide-bench.mjs.</p>
      )}

      <div className="rounded-lg bg-gray-950/60 px-4 py-3 text-xs leading-relaxed text-gray-400">
        <b className="text-gray-200">Try it yourself below</b> in three steps: choose who answers, pick an example, and run it. Laya and an
        LLM can answer side by side, and each answer is checked against the correct one. Further down are every run you have made, the
        full measurements and the write-up.
      </div>
    </section>
  );
}

function Legend() {
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-gray-400">
      <span className="flex items-center gap-1.5">
        <span className="size-2 rounded-full bg-orange-500" /> Laya, this machine&apos;s CPU
      </span>
      <span className="flex items-center gap-1.5">
        <span className="size-2 rounded-full bg-emerald-500" /> Gemma 4 31B, this machine&apos;s GPU
      </span>
      <span className="flex items-center gap-1.5">
        <span className="size-2 rounded-full bg-sky-500" /> Claude Haiku, cloud
      </span>
    </span>
  );
}

function Bar({ label, value, color, title }: { label: string; value: number | null; color: string; title?: string }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)_3rem] items-center gap-2 text-xs" title={title}>
      <span className="truncate text-gray-400">{label}</span>
      <span className="h-2.5 overflow-hidden rounded-full bg-gray-800">
        {value != null && <span className={`block h-full rounded-full ${color}`} style={{ width: `${Math.max(1, value * 100)}%` }} />}
      </span>
      <span className="text-right tabular-nums text-gray-200">{value == null ? "—" : pct(value)}</span>
    </div>
  );
}

function Distribution({ out, expected, laya }: { out: DecisionLabOutput; expected?: string; laya: boolean }) {
  const rows = Object.entries(out.probabilities).sort((a, b) => b[1] - a[1]);
  const right = expected ? expected === out.choice : null;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <p className="text-sm text-gray-200">
          <span className="text-gray-500">Answer: </span>
          <b className="text-base text-gray-50">{out.choice}</b>
          <span className="ml-2 tabular-nums text-gray-400">{(out.confidence * 100).toFixed(0)}% sure</span>
        </p>
        {right === true && (
          <span className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-300">✓ Right</span>
        )}
        {right === false && (
          <span className="rounded-md border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-xs text-red-300">
            ✕ Wrong: the correct answer is <b>{expected}</b>
          </span>
        )}
      </div>
      <div>
        <p className="mb-1.5 text-[11px] text-gray-500">How likely it rated each possible answer</p>
        <ul className="space-y-1.5" aria-label="Probability distribution">
          {rows.map(([label, p]) => (
            <li key={label} className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_3.5rem] items-center gap-2 text-xs">
              <span className={`truncate ${label === out.choice ? "text-gray-100" : "text-gray-400"}`} title={label}>
                {label}
                {label === expected && <span className="ml-1 text-emerald-300" title="The correct answer">✓</span>}
              </span>
              <span className="h-2.5 overflow-hidden rounded-full bg-gray-800">
                <span
                  className={`block h-full rounded-full ${label === out.choice ? "bg-orange-500" : "bg-gray-500"}`}
                  style={{ width: `${Math.max(0.5, p * 100)}%` }}
                />
              </span>
              <span className="text-right tabular-nums text-gray-300">{(p * 100).toFixed(1)}%</span>
            </li>
          ))}
        </ul>
      </div>
      <p className="text-[11px] leading-relaxed text-gray-500">
        {laya && out.checkpoint && (
          <>
            Laya used its <b className="text-gray-400">{out.checkpoint}</b> version
            {out.routingReason ? <>, because: {out.routingReason}</> : null}.{" "}
          </>
        )}
        {out.modelLatencyMs != null && <>The model itself took {fmtMs(out.modelLatencyMs)}. </>}
        {!laya && out.parsed !== false && <>The LLM was asked to reply with a chance for each answer. </>}
        {out.parsed === false && (
          <span className="text-amber-300">The LLM didn&apos;t reply in the requested format, so these chances are a best guess from its text. </span>
        )}
      </p>
    </div>
  );
}

function pct(n: number | null | undefined, digits = 0) {
  return n == null ? "—" : `${(n * 100).toFixed(digits)}%`;
}

/**
 * The cascade worth quoting for a set: Laya first, the fallback LLM below a
 * threshold, saving the most LLM calls while staying within two points of the
 * fallback alone. Null when no threshold saves anything at that accuracy.
 */
function bestCascade(set: Summary["sets"][number]) {
  const c = set.cascades;
  const fb = c ? set.scores[c.fallback] : undefined;
  if (!c || !fb) return null;
  let best: { model: string; threshold: number; accuracy: number; saved: number } | null = null;
  for (const [model, rows] of Object.entries(c.models)) {
    for (const r of rows) {
      if (typeof r.threshold !== "number" || r.threshold === 0 || r.accuracy < fb.accuracy - 0.02) continue;
      const saved = 1 - r.escalated;
      if (saved > 0 && (!best || saved > best.saved || (saved === best.saved && r.accuracy > best.accuracy))) {
        best = { model, threshold: r.threshold, accuracy: r.accuracy, saved };
      }
    }
  }
  return best ? { ...best, fallback: c.fallback, fallbackAccuracy: fb.accuracy } : null;
}

/** Every model on every set: folded by default, since the overview carries the verdict. */
function Results({ summary }: { summary: Summary | null }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!summary) {
    return (
      <p className="text-xs text-gray-600">
        No benchmark yet. <code>node scripts/decide-bench.mjs</code> runs every labelled set against Laya and the LLMs and writes the table
        that appears here.
      </p>
    );
  }
  return (
    <details className="rounded-xl border border-gray-800 bg-gray-900/40">
      <summary className="cursor-pointer px-4 py-2.5 text-sm font-medium text-gray-200">
        Full measurements{" "}
        <span className="ml-1 text-[11px] font-normal text-gray-500">
          every model on every task: accuracy, confidence, speed, cost · {summary.date} · {summary.file}
        </span>
      </summary>
      <div className="border-t border-gray-800 px-4 py-3">
        <Glossary />
      </div>
      <div className="divide-y divide-gray-800/70 border-t border-gray-800">
        {summary.sets.map((s) => {
          const models = summary.models.filter((m) => s.scores[m]);
          const best = Math.max(...models.map((m) => s.scores[m].accuracy));
          return (
            <div key={s.id} className="px-4 py-3">
              <button
                type="button"
                onClick={() => setOpen(open === s.id ? null : s.id)}
                className="mb-2 flex w-full flex-wrap items-baseline justify-between gap-2 text-left"
              >
                <span className="text-sm text-gray-200">
                  {TASKS[s.id]?.name ?? s.title}{" "}
                  <span className="text-[11px] text-gray-500">
                    {s.n} examples · {s.labels.length} possible answers
                  </span>
                </span>
                <span className="text-[11px] text-orange-300">{open === s.id ? "hide confidence plots" : "show confidence plots"}</span>
              </button>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[44rem] text-left text-xs">
                  <thead className="text-[10px] uppercase tracking-wide text-gray-500">
                    <tr>
                      <th className="py-1 pr-2 font-medium">Model</th>
                      <th className="px-2 py-1 text-right font-medium">Accuracy</th>
                      <th className="px-2 py-1 text-right font-medium">Macro F1</th>
                      <th className="px-2 py-1 text-right font-medium" title="Expected calibration error, 10 bins. Lower is better.">Confidence error</th>
                      <th className="px-2 py-1 text-right font-medium" title="After one fitted temperature, cross-fitted over halves">…after tuning</th>
                      <th className="px-2 py-1 text-right font-medium">Typical time</th>
                      <th className="px-2 py-1 text-right font-medium">Slow case</th>
                      <th className="py-1 pl-2 text-right font-medium">Per 1,000</th>
                    </tr>
                  </thead>
                  <tbody className="text-gray-300">
                    {models.map((m) => {
                      const sc = s.scores[m];
                      return (
                        <tr key={m} className="border-t border-gray-800/50">
                          <td className="py-1 pr-2" title={m}>
                            {modelName(m)}
                            {(sc.errors > 0 || sc.unparsed > 0) && (
                              <span className="ml-1 text-[10px] text-amber-300">
                                {sc.errors ? `${sc.errors} failed ` : ""}
                                {sc.unparsed ? `${sc.unparsed} unreadable replies` : ""}
                              </span>
                            )}
                          </td>
                          <td className={`px-2 py-1 text-right tabular-nums ${sc.accuracy === best ? "text-emerald-300" : ""}`}>{pct(sc.accuracy)}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{pct(sc.macroF1)}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{sc.ece.toFixed(3)}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{sc.eceAfterTemperature.toFixed(3)}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{fmtMs(sc.latencyP50Ms)}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{fmtMs(sc.latencyP95Ms)}</td>
                          <td className="py-1 pl-2 text-right tabular-nums">
                            {sc.costPer1000Usd == null ? "free" : `$${sc.costPer1000Usd.toFixed(2)}`}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <CascadeLine set={s} />
              {open === s.id && (
                <div className="mt-3 space-y-2">
                  <p className="max-w-3xl text-[11px] leading-relaxed text-gray-500">
                    Each dot is a group of answers. Across: how sure the model said it was. Up: how often it was actually right. Dots on the
                    dashed line mean its confidence can be trusted; dots below it mean it was more sure than it should have been. Bigger dots
                    hold more answers.
                  </p>
                  <div className="flex flex-wrap gap-4">
                    {models.map((m) => (
                      <ReliabilityPlot key={m} title={modelName(m)} bins={s.scores[m].reliability} />
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </details>
  );
}

function Glossary() {
  const terms: [string, string][] = [
    ["Accuracy", "the share of examples where the model's answer matched the correct one. The best on each task is green."],
    ["Macro F1", "like accuracy, but every answer counts equally, so always giving the most common answer scores badly."],
    ["Confidence error", "how far the model's “% sure” is from how often it is actually right (ECE). 0 is perfect; lower is better."],
    ["…after tuning", "the same after one correction factor, fitted on half the examples and tested on the other half."],
    ["Typical / slow case", "the median time per question, and the time 95% of questions finish within."],
    ["Per 1,000", "what 1,000 questions cost. Everything on this machine is free to run."],
  ];
  return (
    <dl className="grid gap-x-6 gap-y-1.5 text-[11px] leading-relaxed sm:grid-cols-2">
      {terms.map(([t, d]) => (
        <div key={t}>
          <dt className="inline font-medium text-gray-300">{t}: </dt>
          <dd className="inline text-gray-500">{d}</dd>
        </div>
      ))}
    </dl>
  );
}

function CascadeLine({ set }: { set: Summary["sets"][number] }) {
  const b = bestCascade(set);
  if (!set.cascades) return null;
  const fb = modelName(set.cascades.fallback).replace(/, cloud$/, "");
  return (
    <p className="mt-2 text-[11px] leading-relaxed text-gray-400">
      <span className="text-gray-500">Could Laya answer the easy ones and pass the rest to {fb}? </span>
      {b ? (
        <>
          At best: Laya answers when it is at least {Math.round(b.threshold * 100)}% sure, {fb} answers the rest. That is{" "}
          <b className="text-gray-200">{pct(b.accuracy)}</b> right and <b className="text-gray-200">{pct(b.saved)}</b> fewer {fb} calls{" "}
          <span className="text-gray-500">
            ({fb} alone: {pct(b.fallbackAccuracy)})
          </span>
          .
        </>
      ) : (
        <>No: handing Laya any share of these costs more than two points of accuracy.</>
      )}
    </p>
  );
}

function fmtMs(ms: number | null) {
  if (ms == null) return "—";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** Confidence (x) against accuracy (y) per bin; the diagonal is perfect calibration. Dot area = items in the bin. */
function ReliabilityPlot({ title, bins }: { title: string; bins: ModelScore["reliability"] }) {
  const S = 120;
  const total = bins.reduce((a, b) => a + b.n, 0) || 1;
  return (
    <figure className="text-[10px] text-gray-500">
      <svg width={S + 24} height={S + 20} role="img" aria-label={`Confidence plot for ${title}`}>
        <g transform="translate(20,4)">
          <rect width={S} height={S} className="fill-gray-950 stroke-gray-800" />
          <line x1={0} y1={S} x2={S} y2={0} className="stroke-gray-700" strokeDasharray="3 3" />
          {bins
            .filter((b) => b.n > 0)
            .map((b, i) => (
              <g key={i}>
                <line
                  x1={b.confidence * S}
                  y1={S - b.confidence * S}
                  x2={b.confidence * S}
                  y2={S - b.accuracy * S}
                  className="stroke-orange-500/40"
                />
                <circle
                  cx={b.confidence * S}
                  cy={S - b.accuracy * S}
                  r={2 + 7 * Math.sqrt(b.n / total)}
                  className="fill-orange-500/80"
                >
                  <title>{`${(b.confidence * 100).toFixed(0)}% sure → right ${(b.accuracy * 100).toFixed(0)}% of the time (${b.n} answers)`}</title>
                </circle>
              </g>
            ))}
          <text x={0} y={S + 12} className="fill-gray-500">sure 0%</text>
          <text x={S - 26} y={S + 12} className="fill-gray-500">100%</text>
          <text x={-18} y={8} className="fill-gray-500">right</text>
        </g>
      </svg>
      <figcaption className="max-w-[9rem] truncate text-gray-400" title={title}>
        {title}
      </figcaption>
    </figure>
  );
}
