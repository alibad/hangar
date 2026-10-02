"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FlaskConical } from "lucide-react";
import { ToolPageHeader } from "@/components/tool-page";
import { ServiceControl, ServiceControls, useServiceLifecycle } from "@/components/service-control";
import CapacityBlocker from "@/components/capacity-blocker";
import RecentRuns from "./recent-runs";
import { ExperimentDoc } from "./lab-shell";
import type { LabComponentProps } from "@/lib/labs";
import type { LabModel, LabModelsPayload, LabRunResult } from "@/lib/lab-types";
import type { DecisionLabOutput } from "@/app/api/labs/decide/run/route";
import { itemContext, textToChoices, type LabelledSet } from "@/lib/decide-sets";

/**
 * The Decision Lab, as a guided page: what we found, then real examples with
 * what each model answered when we tested it (shown from the benchmark, so the
 * page works with nothing running), an optional live re-ask, and everything
 * else folded under "Behind the scenes".
 *
 * Not on LabShell. The shell is built around choosing a model and running it;
 * here the comparison IS the point, so the page picks the models (Laya beside
 * Claude Haiku) and asks for nothing but a task. Two passes on LabShell — the
 * measured-first page, then numbered steps over the shell's model rows and form
 * — both left the owner saying it was too complex for someone arriving cold.
 * Runs still go through /api/labs/decide/run, so they are measured and land in
 * the same runs record as every other Lab's.
 *
 * Examples are the labelled sets the experiment was measured on
 * (experiments/decide/sets); the numbers come from the latest
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

type Recorded = { choice: string; confidence: number; latencyMs: number | null; costUsd: number | null };
type SetsPayload = {
  sets: LabelledSet[];
  summary: Summary | null;
  /** What laya, Gemma 4 and Claude Haiku answered per item in the benchmark: answers[set][item][model]. */
  recorded?: { models: string[]; answers: Record<string, Record<string, Record<string, Recorded>>> } | null;
};

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
const TASK_ORDER = ["feedback-triage", "moderation", "reddit-relevance", "router-escalation", "console-intent", "arabic-dialect"];

const MODEL_NAMES: Record<string, string> = {
  laya: "Laya",
  "laya-english": "Laya, English version",
  "laya-multilingual": "Laya, multilingual version",
  "laya-typed-decisions": "Laya, typed-decisions version",
  "local-small": "Qwen 7B",
  "local-gemma4": "Gemma 4",
  "claude-haiku": "Claude Haiku",
  "reddit-scout-heuristic": "reddit-scout's keyword score",
};
const modelName = (id: string) => MODEL_NAMES[id] ?? id;
const isLaya = (id: string) => id === "laya" || id.startsWith("laya-");

/** The comparisons offered first, in this order; any other router model is under "Other models". */
const COMPARE_FIRST: Record<string, string> = {
  "claude-haiku": "Claude Haiku — cloud, about $0.0005 a question",
  "local-gemma4": "Gemma 4 — this machine, free, needs 20 GB of the GPU",
  "local-small": "Qwen 7B — this machine, free",
};

const LAYA_VERSIONS: [string, string][] = [
  ["laya", "Automatic: English or multilingual, picked per question (recommended)"],
  ["laya-english", "English version only"],
  ["laya-multilingual", "Multilingual version only"],
  ["laya-typed-decisions", "Typed-decisions version only"],
];

/** Answer labels as words: `feature_request` → "Feature request". */
const LABEL_WORDS: Record<string, string> = { ui_ux: "UI / UX", msa: "MSA (formal Arabic)" };
function nice(label: string) {
  if (LABEL_WORDS[label]) return LABEL_WORDS[label];
  const s = label.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

type Answer = { model: string; state: "running" | "done"; result?: LabRunResult<DecisionLabOutput> };

const inputCls =
  "w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-100 outline-none placeholder:text-gray-600 focus:border-gray-500";

export default function DecisionLab({ lab }: LabComponentProps) {
  const [data, setData] = useState<SetsPayload | null>(null);
  const [models, setModels] = useState<LabModelsPayload | null>(null);
  const [mode, setMode] = useState<"example" | "own">("example");
  const [taskId, setTaskId] = useState("feedback-triage");
  const [index, setIndex] = useState(0);
  const [own, setOwn] = useState({ question: "", answers: "", text: "" });
  const [layaId, setLayaId] = useState("laya");
  const [compareId, setCompareId] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [runsVersion, setRunsVersion] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    fetch("/api/labs/decide/sets", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: SetsPayload) => setData(j))
      .catch(() => setData({ sets: [], summary: null }));
  }, []);

  const loadModels = useCallback(async () => {
    try {
      const q = new URLSearchParams({ capability: lab.capability });
      if (lab.compareCapability) q.set("compare", lab.compareCapability);
      const r = await fetch(`/api/labs/models?${q}`, { cache: "no-store" });
      const j = (await r.json()) as LabModelsPayload;
      if (r.ok) setModels(j);
      return r.ok ? j : null;
    } catch {
      return null;
    }
  }, [lab.capability, lab.compareCapability]);

  useEffect(() => {
    void loadModels();
    const iv = setInterval(() => {
      if (!document.hidden) void loadModels();
    }, 15_000);
    return () => clearInterval(iv);
  }, [loadModels]);

  const laya = models?.models.find((m) => m.id === layaId);
  const others = useMemo(() => models?.models.filter((m) => !m.local || m.compare) ?? [], [models]);
  useEffect(() => {
    if (compareId === null && others.length) setCompareId(others.find((m) => m.id === "claude-haiku")?.id ?? others.find((m) => m.status === "ready")?.id ?? "");
  }, [others, compareId]);
  const compare = compareId ? others.find((m) => m.id === compareId) : undefined;

  // What gets asked: the chosen example, or the reader's own question.
  const set = data?.sets.find((s) => s.id === taskId);
  const item = set?.items[index % (set?.items.length || 1)];
  const ownChoices = useMemo(() => textToChoices(own.answers), [own.answers]);
  const ask =
    mode === "example"
      ? set && item
        ? { question: set.question, type: set.type, choices: set.choices, context: itemContext(set, item), expected: item.label as string | undefined }
        : null
      : own.question.trim() && Object.keys(ownChoices).length >= 2
        ? { question: own.question.trim(), type: "choice" as const, choices: ownChoices, context: own.text, expected: undefined }
        : null;

  const clear = () => {
    abortRef.current?.abort();
    setAnswers([]);
  };
  const pickTask = (id: string) => {
    setTaskId(id);
    setIndex(0);
    clear();
  };

  const targets = [laya, compare].filter((m): m is LabModel => !!m);
  const notReady = targets.find((m) => m.status !== "ready");
  const running = answers.some((a) => a.state === "running");

  const go = async () => {
    if (!ask) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    const compareGroup = targets.length > 1 ? crypto.randomUUID() : null;
    setAnswers(targets.map((m) => ({ model: m.id, state: "running" })));
    // One request per model, so each answer lands as soon as it is ready.
    await Promise.all(
      targets.map(async (m, i) => {
        let result: LabRunResult<DecisionLabOutput>;
        try {
          const r = await fetch("/api/labs/decide/run", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: m.id, question: ask.question, type: ask.type, choices: ask.choices, context: ask.context, compareGroup }),
            signal: ac.signal,
          });
          const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
          result = r.ok ? (j as LabRunResult<DecisionLabOutput>) : { ok: false, model: m.id, local: m.local, error: j.error ?? `HTTP ${r.status}` };
        } catch (e) {
          if (ac.signal.aborted) return;
          result = { ok: false, model: m.id, local: m.local, error: e instanceof Error ? e.message : String(e) };
        }
        setAnswers((prev) => prev.map((a, j) => (j === i ? { ...a, state: "done", result } : a)));
      }),
    );
    setRunsVersion((v) => v + 1);
    void loadModels();
  };

  const who = compare ? `${modelName(laya?.id ?? "laya")} and ${modelName(compare.id)}` : modelName(laya?.id ?? "laya");
  const buttonLabel = running ? "Asking…" : mode === "example" ? `Ask ${who} again, live` : `Ask ${who}`;

  return (
    <div className="space-y-6">
      <ToolPageHeader
        eyebrow="Lab"
        title={lab.label}
        description="Could a small, free model make our apps' quick decisions instead of an LLM? See what we found, then try it."
        icon={<FlaskConical className="h-5 w-5" />}
        meta={
          laya && (
            <span className="rounded-full border border-gray-700 px-2 py-0.5 text-[11px] text-gray-400">
              Laya {laya.status === "ready" ? "is running" : "is stopped"} on {models?.host.name ?? "this machine"}
            </span>
          )
        }
      />

      <Findings summary={data?.summary ?? null} loading={!data} />

      {/* ── Try it ── */}
      <section className="space-y-4 rounded-xl border border-gray-800 bg-gray-900/40 p-4 sm:p-5" aria-labelledby="decide-try">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h2 id="decide-try" className="text-lg font-semibold text-gray-50">
              See it for yourself
            </h2>
            <p className="text-xs text-gray-400">Real examples with known answers, and what each model said. Or ask your own question.</p>
          </div>
          <div className="flex rounded-lg border border-gray-700 p-0.5 text-xs" role="tablist" aria-label="What to ask">
            {(
              [
                ["example", "A real example"],
                ["own", "Your own question"],
              ] as const
            ).map(([m, label]) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={mode === m}
                onClick={() => {
                  setMode(m);
                  clear();
                }}
                className={`rounded-md px-3 py-1.5 ${mode === m ? "bg-gray-800 text-gray-50" : "text-gray-400 hover:text-gray-200"}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {mode === "example" ? (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Task">
              {TASK_ORDER.filter((id) => data?.sets.some((s) => s.id === id)).map((id) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={taskId === id}
                  onClick={() => pickTask(id)}
                  className={`rounded-full border px-3 py-1.5 text-xs transition ${
                    taskId === id
                      ? "border-orange-500/70 bg-orange-500/15 text-orange-200"
                      : "border-gray-700 text-gray-300 hover:border-gray-500"
                  }`}
                >
                  {TASKS[id].name}
                </button>
              ))}
            </div>
            {set && item ? (
              <>
                <ExampleCard
                  set={set}
                  item={item}
                  index={index % set.items.length}
                  score={data?.summary?.sets.find((s) => s.id === set.id)}
                  onNext={() => {
                    setIndex((i) => (i + 1) % set.items.length);
                    clear();
                  }}
                />
                <RecordedAnswers
                  answers={data?.recorded?.answers[set.id]?.[item.id]}
                  models={data?.recorded?.models ?? []}
                  expected={item.label}
                  date={data?.summary?.date}
                />
              </>
            ) : (
              <p className="text-xs text-gray-500">Loading the examples…</p>
            )}
          </div>
        ) : (
          <OwnQuestion value={own} onChange={(v) => setOwn(v)} />
        )}

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-gray-800 pt-4">
          <button
            type="button"
            onClick={go}
            disabled={!ask || running || !laya || !!notReady}
            className="rounded-lg bg-orange-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-orange-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {buttonLabel}
          </button>
          {running && (
            <button type="button" onClick={clear} className="text-xs text-gray-400 hover:text-gray-200">
              Cancel
            </button>
          )}
          <label className="flex items-center gap-2 text-xs text-gray-400">
            Compare with
            <select
              value={compareId ?? ""}
              onChange={(e) => {
                setCompareId(e.target.value);
                clear();
              }}
              aria-label="Compare Laya with"
              className="rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-xs text-gray-200"
            >
              {Object.keys(COMPARE_FIRST)
                .map((id) => others.find((m) => m.id === id))
                .filter((m): m is LabModel => !!m)
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {COMPARE_FIRST[m.id]}
                    {m.status !== "ready" ? " (not available)" : ""}
                  </option>
                ))}
              <option value="">Nobody: Laya alone</option>
              {others.some((m) => !COMPARE_FIRST[m.id]) && (
                <optgroup label="Other models">
                  {others
                    .filter((m) => !COMPARE_FIRST[m.id])
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.id}
                        {m.local ? " (this machine)" : ""}
                        {m.status !== "ready" ? " (not available)" : ""}
                      </option>
                    ))}
                </optgroup>
              )}
            </select>
          </label>
        </div>

        {laya && laya.status !== "ready" ? (
          laya.serviceId ? (
            <LayaStart serviceId={laya.serviceId} probe={async () => (await loadModels())?.models.find((x) => x.id === laya.id)?.status === "ready"} onReleased={loadModels} />
          ) : (
            <p className="text-xs text-amber-300">Laya isn&apos;t available here{laya.detail ? `: ${laya.detail}` : ""}.</p>
          )
        ) : notReady ? (
          <p className="text-xs text-amber-300">
            {modelName(notReady.id)} isn&apos;t available right now{notReady.detail ? `: ${notReady.detail}` : ""}. Pick someone else to compare with.
          </p>
        ) : null}

        {answers.length > 0 && <Answers answers={answers} expected={ask?.expected} live={mode === "example"} onReleased={loadModels} />}
      </section>

      {/* ── Behind the scenes ── */}
      <section className="space-y-3" aria-labelledby="decide-behind">
        <div>
          <h2 id="decide-behind" className="text-sm font-semibold text-gray-200">
            Behind the scenes
          </h2>
          <p className="text-xs text-gray-500">For the curious: how Laya runs here, your recent tries, every number, and the full write-up.</p>
        </div>
        <Fold title="Laya on this machine" note={laya ? (laya.status === "ready" ? "running" : "stopped") : undefined}>
          <LayaPanel laya={laya} layaId={layaId} setLayaId={(id) => { setLayaId(id); clear(); }} probe={loadModels} />
        </Fold>
        <Fold title="Your recent tries" note="each one is recorded, with time taken and cost">
          <RecentRuns lab={lab.id} refreshKey={runsVersion} />
        </Fold>
        <Results summary={data?.summary ?? null} />
        <ExperimentDoc path={lab.doc} />
        <Fold title="For developers: asking from code" note="POST /api/decide">
          <DevNote />
        </Fold>
      </section>
    </div>
  );
}

function Fold({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <details className="rounded-xl border border-gray-800 bg-gray-900/40">
      <summary className="cursor-pointer px-4 py-2.5 text-sm font-medium text-gray-200">
        {title}
        {note && <span className="ml-2 text-[11px] font-normal text-gray-500">{note}</span>}
      </summary>
      <div className="border-t border-gray-800 p-4">{children}</div>
    </details>
  );
}

/** The top of the page: what the Lab is for, the answer, and how each model did on each task. */
function Findings({ summary, loading }: { summary: Summary | null; loading: boolean }) {
  const rows = TASK_ORDER.map((id) => summary?.sets.find((s) => s.id === id))
    .filter((s): s is Summary["sets"][number] => !!s)
    .map((s) => {
      // Laya is its automatic version: the one this page and /api/decide ask by default.
      return {
        id: s.id,
        n: s.n,
        task: TASKS[s.id],
        laya: s.scores.laya?.accuracy ?? null,
        gemma: s.scores["local-gemma4"]?.accuracy ?? null,
        haiku: s.scores["claude-haiku"]?.accuracy ?? null,
      };
    });
  const range = (xs: (number | null | undefined)[]) => {
    const v = xs.filter((x): x is number => x != null);
    return v.length ? `${pct(Math.min(...v))} to ${pct(Math.max(...v))}` : null;
  };
  const layaRange = range(rows.map((r) => r.laya));
  // Its three fixed versions, for the note under the chart: none rescues it.
  const fixedBest = Math.max(0, ...(summary?.sets ?? []).flatMap((s) => Object.entries(s.scores).filter(([m]) => m.startsWith("laya-")).map(([, v]) => v.accuracy)));
  const llmRange = range(rows.flatMap((r) => [r.haiku, r.gemma]));
  const examples = rows.reduce((a, r) => a + r.n, 0);

  return (
    <section className="space-y-4 rounded-xl border border-gray-800 bg-gray-900/40 p-4 sm:p-5" aria-labelledby="decide-found">
      <div className="space-y-2">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-orange-300">What we found</p>
        <h2 id="decide-found" className="text-xl font-semibold text-gray-50">
          Not yet. Laya was right {layaRange ?? "far less often"} of the time{llmRange ? <>; the LLMs, {llmRange}</> : null}.
        </h2>
        <p className="max-w-4xl text-sm leading-relaxed text-gray-300">
          Several of our apps ask an AI quick multiple-choice questions all day: is this feedback a bug? Should this post be removed? Today
          an LLM answers. <b className="text-gray-100">Laya</b> is a small open model that runs free on this machine, in a fraction of a
          second. We gave Laya and two LLMs the same {examples || ""} examples, each with a correct answer set by hand, and counted how often
          each got it right. Laya is fast, but it tends to give the same answer to almost everything.
        </p>
      </div>

      {loading ? (
        <p className="text-xs text-gray-500">Loading the results…</p>
      ) : rows.length ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-medium text-gray-200">How often each was right, task by task</h3>
            <Legend />
          </div>
          <ul className="divide-y divide-gray-800/70 rounded-lg border border-gray-800">
            {rows.map((r) => (
              <li key={r.id} className="grid gap-x-6 gap-y-2 px-3 py-2.5 md:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
                <div className="min-w-0">
                  <p className="text-sm text-gray-100">{r.task.name}</p>
                  <p className="text-[11px] text-gray-400">
                    Use: <b className="font-medium text-emerald-300">{r.task.use}</b>
                  </p>
                </div>
                <div className="space-y-1 self-center">
                  <Bar label="Laya" value={r.laya} color="bg-orange-500" />
                  <Bar label="Gemma 4" value={r.gemma} color="bg-emerald-500" />
                  <Bar label="Claude Haiku" value={r.haiku} color="bg-sky-500" />
                </div>
              </li>
            ))}
          </ul>
          <p className="text-[11px] leading-relaxed text-gray-500">
            Globe Quest stays on Claude Haiku even where Gemma 4 scored higher: it runs in the cloud and must not call this machine. Gemma 4
            needs about 20 GB of the GPU, so it only loads when nothing big is running. Laya&apos;s three fixed versions did no better
            {fixedBest ? <>: at most {pct(fixedBest)} on any task</> : null}. Nothing in the apps has changed.
          </p>
        </div>
      ) : (
        <p className="text-xs text-gray-500">No results yet: run node scripts/decide-bench.mjs.</p>
      )}
    </section>
  );
}

function Legend() {
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-gray-400">
      <span className="flex items-center gap-1.5">
        <span className="size-2 rounded-full bg-orange-500" /> Laya, small, this machine
      </span>
      <span className="flex items-center gap-1.5">
        <span className="size-2 rounded-full bg-emerald-500" /> Gemma 4, large, this machine
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
      <span className="h-2 overflow-hidden rounded-full bg-gray-800">
        {value != null && <span className={`block h-full rounded-full ${color}`} style={{ width: `${Math.max(1, value * 100)}%` }} />}
      </span>
      <span className="text-right tabular-nums text-gray-200">{value == null ? "—" : pct(value)}</span>
    </div>
  );
}

function ExampleCard({
  set,
  item,
  index,
  score,
  onNext,
}: {
  set: LabelledSet;
  item: LabelledSet["items"][number];
  index: number;
  score?: Summary["sets"][number];
  onNext: () => void;
}) {
  const task = TASKS[set.id];
  const layaScore = score?.scores.laya?.accuracy ?? null;
  const haiku = score?.scores["claude-haiku"]?.accuracy;
  // Reddit items are structured (product, subreddit, title, body); show them as a post, not as the prompt text.
  const reddit = !item.context && (item.title || item.body);
  return (
    <div className="space-y-3 rounded-lg border border-gray-800 bg-gray-950/50 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs text-gray-400">
          {task?.asks ?? set.question}
          {layaScore != null && haiku != null && (
            <span className="text-gray-500">
              {" "}
              Over all {set.items.length} examples, Laya got {pct(layaScore)} right and Claude Haiku {pct(haiku)}.
            </span>
          )}
        </p>
        <button type="button" onClick={onNext} className="shrink-0 text-xs text-orange-300 hover:text-orange-200">
          Another example →
        </button>
      </div>
      <blockquote dir="auto" className="rounded-md border-l-2 border-gray-600 bg-gray-900/60 px-4 py-3 text-sm leading-relaxed text-gray-100">
        {reddit ? (
          <>
            {item.subreddit && <span className="mb-1 block text-[11px] text-gray-500">r/{item.subreddit}{item.product ? ` · for ${set.products?.[item.product] ?? item.product}` : ""}</span>}
            {item.title && <b className="block">{item.title}</b>}
            {item.body && <span className="mt-1 block whitespace-pre-wrap text-gray-300">{item.body}</span>}
          </>
        ) : (
          <span className="whitespace-pre-wrap">{itemContext(set, item)}</span>
        )}
      </blockquote>
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className="mr-1 text-gray-500">Possible answers:</span>
        {Object.keys(set.choices).map((c) => (
          <span
            key={c}
            title={set.choices[c]}
            className={`rounded-full border px-2 py-0.5 ${c === item.label ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" : "border-gray-700 text-gray-300"}`}
          >
            {nice(c)}
            {c === item.label && " ✓ correct"}
          </span>
        ))}
      </div>
      <p className="text-[11px] text-gray-600">
        Example {index + 1} of {set.items.length}. The correct answer was set by hand before any model saw it.
      </p>
    </div>
  );
}

function OwnQuestion({
  value,
  onChange,
}: {
  value: { question: string; answers: string; text: string };
  onChange: (v: { question: string; answers: string; text: string }) => void;
}) {
  return (
    <div className="space-y-3">
      <Field label="Your question">
        <input
          value={value.question}
          onChange={(e) => onChange({ ...value, question: e.target.value })}
          placeholder="e.g. Is this customer message a complaint?"
          aria-label="Question"
          className={inputCls}
        />
      </Field>
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <Field label="Possible answers" hint="one per line; add “: what it means” to help">
          <textarea
            value={value.answers}
            onChange={(e) => onChange({ ...value, answers: e.target.value })}
            rows={5}
            placeholder={"yes\nno"}
            aria-label="Possible answers"
            className={`${inputCls} resize-y`}
          />
        </Field>
        <Field label="The text to judge" hint="any language">
          <textarea
            value={value.text}
            onChange={(e) => onChange({ ...value, text: e.target.value })}
            rows={5}
            placeholder="The message, post or request the question is about."
            aria-label="Text to judge"
            className={`${inputCls} resize-y`}
          />
        </Field>
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

/** What each model answered for this item in the benchmark run, from the results file: instant, free, nothing running. */
function RecordedAnswers({
  answers,
  models,
  expected,
  date,
}: {
  answers?: Record<string, Recorded>;
  models: string[];
  expected: string;
  date?: string;
}) {
  const shown = models.filter((m) => answers?.[m]);
  if (!shown.length) return null;
  const wrong = shown.filter((m) => answers![m].choice !== expected).map(modelName);
  return (
    <div className="space-y-2">
      <p className="text-sm text-gray-200">
        <span className="text-gray-400">When we tested it{date ? ` on ${fmtDate(date)}` : ""}: </span>
        <b className="text-gray-50">
          {wrong.length === 0 ? "everyone got it right." : wrong.length === shown.length ? "everyone got it wrong." : `${wrong.join(" and ")} got it wrong.`}
        </b>
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        {shown.map((m) => {
          const r = answers![m];
          return (
            <AnswerTile
              key={m}
              model={m}
              choice={r.choice}
              confidence={r.confidence}
              latencyMs={r.latencyMs}
              costUsd={r.costUsd}
              right={r.choice === expected}
            />
          );
        })}
      </div>
    </div>
  );
}

/** One model's answer: the label, right or wrong, how sure, how fast, what it cost. */
function AnswerTile({
  model,
  choice,
  confidence,
  latencyMs,
  costUsd,
  right,
  local,
  children,
}: {
  model: string;
  choice?: string;
  confidence?: number;
  latencyMs?: number | null;
  costUsd?: number | null;
  right: boolean | null;
  local?: boolean;
  children?: ReactNode;
}) {
  const here = local ?? (isLaya(model) || model.startsWith("local-"));
  return (
    <article
      className={`rounded-lg border p-3.5 ${
        right === true ? "border-emerald-500/40 bg-emerald-500/[0.05]" : right === false ? "border-red-500/40 bg-red-500/[0.05]" : "border-gray-800 bg-gray-950/40"
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-gray-200">{modelName(model)}</h3>
        <span className="text-[11px] text-gray-500">{here ? "this machine" : "cloud"}</span>
      </div>
      {choice != null ? (
        <>
          <p className="mt-1.5 flex flex-wrap items-baseline gap-x-2">
            <span className="text-xl font-semibold text-gray-50">{nice(choice)}</span>
            {right === true && <span className="text-sm font-medium text-emerald-300">✓ Right</span>}
            {right === false && <span className="text-sm font-medium text-red-300">✕ Wrong</span>}
          </p>
          <p className="mt-0.5 text-xs text-gray-400">
            {confidence != null && <>{(confidence * 100).toFixed(0)}% sure · </>}
            {fmtMs(latencyMs ?? null)} · {costUsd != null ? `$${costUsd.toFixed(4)}` : here ? "free" : "cost not reported"}
          </p>
        </>
      ) : (
        children
      )}
    </article>
  );
}

function Answers({ answers, expected, live, onReleased }: { answers: Answer[]; expected?: string; live: boolean; onReleased: () => void }) {
  const done = answers.every((a) => a.state === "done");
  const verdicts = answers.map((a) => (a.result?.ok && a.result.output && expected ? a.result.output.choice === expected : null));
  let summary: string | null = null;
  if (done && expected && verdicts.every((v) => v != null)) {
    const names = answers.map((a) => modelName(a.model));
    if (answers.length === 1) summary = verdicts[0] ? `${names[0]} got it right.` : `${names[0]} got it wrong.`;
    else if (verdicts.every(Boolean)) summary = "Both got it right.";
    else if (verdicts.every((v) => !v)) summary = "Both got it wrong.";
    else summary = answers.map((_, i) => `${names[i]} got it ${verdicts[i] ? "right" : "wrong"}`).join("; ") + ".";
  }
  const withOutput = answers.filter((a) => a.result?.ok && a.result.output);
  return (
    <div className="space-y-2" aria-live="polite">
      <p className="text-sm text-gray-200">
        <span className="text-gray-400">{live ? "Asked again just now: " : "Their answers: "}</span>
        {summary ? <b className="text-gray-50">{summary}</b> : !done ? <span className="text-gray-400">waiting…</span> : null}
      </p>
      <div className={`grid gap-3 ${answers.length > 1 ? "sm:grid-cols-2" : ""}`}>
        {answers.map((a, i) => {
          const r = a.result;
          const out = r?.ok ? r.output : undefined;
          return (
            <AnswerTile
              key={`${a.model}-${i}`}
              model={a.model}
              choice={out?.choice}
              confidence={out?.confidence}
              latencyMs={r?.latencyMs ?? out?.latencyMs ?? null}
              costUsd={r?.costUsd ?? null}
              right={verdicts[i]}
              local={r?.local}
            >
              {a.state === "running" ? (
                <p className="mt-2 text-sm text-gray-400">
                  Thinking…
                  {a.model === "local-gemma4" && <span className="block text-[11px] text-gray-500">Loading Gemma 4 onto the GPU can take a minute.</span>}
                </p>
              ) : r?.resourceBlocked ? (
                <div className="mt-2">
                  <CapacityBlocker message={r.error ?? "Not enough memory."} onReleased={onReleased} />
                </div>
              ) : (
                <p className="mt-2 whitespace-pre-wrap text-xs text-red-300">{r?.error ?? "No answer."}</p>
              )}
            </AnswerTile>
          );
        })}
      </div>
      {withOutput.length > 0 && done && (
        <details className="rounded-lg border border-gray-800">
          <summary className="cursor-pointer px-3 py-2 text-xs text-gray-300">How sure was each about every possible answer?</summary>
          <div className={`grid gap-4 border-t border-gray-800 p-3 ${withOutput.length > 1 ? "md:grid-cols-2" : ""}`}>
            {withOutput.map((a) => (
              <Distribution key={a.model} model={a.model} out={a.result!.output!} expected={expected} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

/**
 * Laya is stopped: start it, and say plainly what happens — loading, or why it
 * cannot start. The resource coordinator refuses a start when the machine's
 * memory is promised elsewhere (an overnight video render, say); that refusal
 * used to vanish inside the Start button, so a press looked like nothing.
 */
function LayaStart({ serviceId, probe, onReleased }: { serviceId: string; probe: () => Promise<boolean>; onReleased: () => void }) {
  const lc = useServiceLifecycle(serviceId, false, probe);
  if (lc.busyVerb === "start") {
    return (
      <p className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-200">
        <span className="inline-block size-1.5 animate-pulse rounded-full bg-amber-400" />
        Starting Laya: loading the model takes about a minute.
      </p>
    );
  }
  if (lc.blocked) {
    return (
      <div className="space-y-2">
        <p className="text-xs text-amber-200" title={lc.error ?? undefined}>
          There isn&apos;t room to start Laya right now. It needs about 6 GB of memory, and the machine&apos;s memory is promised to the
          jobs below. You can still read every example&apos;s answers above, or try again when they finish.
        </p>
        <CapacityBlocker message="Freeing one of these makes room. Anything you free stops what it was doing." onReleased={onReleased} />
        <button type="button" onClick={() => lc.run("start")} className="text-xs text-orange-300 hover:text-orange-200">
          Try starting Laya again
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-200">
      <span>
        {lc.error ? <>Laya didn&apos;t start: {lc.error}. </> : null}
        Laya is stopped. Start it to ask live: it takes about a minute and holds about 6 GB of memory.
      </span>
      <ServiceControls lifecycle={lc} name="Laya" showLogs={false} />
    </div>
  );
}

function Distribution({ model, out, expected }: { model: string; out: DecisionLabOutput; expected?: string }) {
  const rows = Object.entries(out.probabilities).sort((a, b) => b[1] - a[1]);
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-gray-300">{modelName(model)}</p>
      <ul className="space-y-1.5" aria-label={`How sure ${modelName(model)} was of each answer`}>
        {rows.map(([label, p]) => (
          <li key={label} className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)_3rem] items-center gap-2 text-xs">
            <span className={`truncate ${label === out.choice ? "text-gray-100" : "text-gray-400"}`} title={label}>
              {nice(label)}
              {label === expected && <span className="ml-1 text-emerald-300" title="The correct answer">✓</span>}
            </span>
            <span className="h-2 overflow-hidden rounded-full bg-gray-800">
              <span
                className={`block h-full rounded-full ${label === out.choice ? "bg-orange-500" : "bg-gray-500"}`}
                style={{ width: `${Math.max(0.5, p * 100)}%` }}
              />
            </span>
            <span className="text-right tabular-nums text-gray-300">{(p * 100).toFixed(0)}%</span>
          </li>
        ))}
      </ul>
      <p className="text-[11px] leading-relaxed text-gray-500">
        {isLaya(model) && out.checkpoint && (
          <>
            Laya used its {out.checkpoint} version{out.routingReason ? <>, because: {out.routingReason}</> : null}.{" "}
          </>
        )}
        {!isLaya(model) && out.parsed !== false && <>The LLM was asked to give a chance for each answer.</>}
        {out.parsed === false && (
          <span className="text-amber-300">The LLM didn&apos;t reply in the requested format, so these chances are a best guess from its text.</span>
        )}
      </p>
    </div>
  );
}

function LayaPanel({
  laya,
  layaId,
  setLayaId,
  probe,
}: {
  laya?: LabModel;
  layaId: string;
  setLayaId: (id: string) => void;
  probe: () => Promise<LabModelsPayload | null>;
}) {
  const ready = laya?.status === "ready";
  return (
    <div className="space-y-3 text-xs leading-relaxed text-gray-400">
      <div className="flex flex-wrap items-center gap-3">
        <span className={`size-2 rounded-full ${ready ? "bg-emerald-400" : "bg-gray-600"}`} aria-hidden="true" />
        <span className="text-sm text-gray-200">
          {laya ? (ready ? "Running" : "Stopped") : "Not set up on this machine"}
          {laya && !ready && <span className="ml-2 text-xs text-gray-500">Start it under the examples above, where it says why if it can&apos;t.</span>}
        </span>
        {laya?.serviceId && ready && (
          <ServiceControl
            id={laya.serviceId}
            up={ready}
            probe={async () => (await probe())?.models.find((x) => x.id === laya.id)?.status === "ready"}
            actions={["stop"]}
            name="Laya"
            showLogs={false}
          />
        )}
      </div>
      <p>
        Laya is a small open model from Convai Innovations, licensed {laya?.license ?? "Apache-2.0"}. Here it runs on the CPU, not the
        graphics card, and holds about {laya?.footprint?.ramGb ?? 6} GB of memory while it is running. Stop it when you are not using it.
      </p>
      <label className="flex flex-wrap items-center gap-2">
        <span className="text-gray-300">Which Laya answers</span>
        <select
          value={layaId}
          onChange={(e) => setLayaId(e.target.value)}
          aria-label="Laya version"
          className="rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-xs text-gray-200"
        >
          {LAYA_VERSIONS.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {laya?.params && <p className="text-[11px] text-gray-500">Model sizes: {laya.params}.</p>}
    </div>
  );
}

function DevNote() {
  return (
    <div className="space-y-2 text-xs leading-relaxed text-gray-400">
      <p>
        Other code on this machine asks the same way: send a question, the possible answers and the text; get back the answer, how sure the
        model is of each option, and how long it took. The process lab and Claude&apos;s <code>decide</code> tool use it. Full contract:{" "}
        <code>docs/decide-api.md</code>.
      </p>
      <pre className="overflow-x-auto rounded-md bg-gray-950 p-3 font-mono text-[11px] text-gray-300">{`POST /api/decide
{ "question": "What kind of feedback is this?",
  "choices": ["bug", "feature_request", "noise"],
  "context": "Clicking Start quest does nothing.",
  "model": "laya" }

→ { "choice": "bug", "confidence": 0.66,
    "probabilities": { "bug": 0.66, "noise": 0.2, ... }, ... }`}</pre>
    </div>
  );
}

function pct(n: number | null | undefined, digits = 0) {
  return n == null ? "—" : `${(n * 100).toFixed(digits)}%`;
}

function fmtDate(iso: string) {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
}

function fmtMs(ms: number | null) {
  if (ms == null) return "—";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
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

/** Every model on every set, folded: the findings card carries the verdict. */
function Results({ summary }: { summary: Summary | null }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!summary) return null;
  return (
    <details className="rounded-xl border border-gray-800 bg-gray-900/40">
      <summary className="cursor-pointer px-4 py-2.5 text-sm font-medium text-gray-200">
        Every number
        <span className="ml-2 text-[11px] font-normal text-gray-500">
          every model on every task: accuracy, confidence, speed, cost · measured {summary.date}
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
      <p className="border-t border-gray-800 px-4 py-2 text-[11px] text-gray-600">
        {summary.host} · {summary.file}
      </p>
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
  const fb = modelName(set.cascades.fallback);
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

/** Confidence (x) against accuracy (y) per bin; the diagonal is perfect calibration. Dot area = items in the bin. */
function ReliabilityPlot({ title, bins }: { title: string; bins: ModelScore["reliability"] }) {
  const S = 120;
  const total = bins.reduce((a, b) => a + b.n, 0) || 1;
  return (
    <figure className="text-[10px] text-gray-500">
      <svg width={S + 34} height={S + 20} role="img" aria-label={`Confidence plot for ${title}`}>
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
