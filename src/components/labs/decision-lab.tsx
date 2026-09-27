"use client";

import { useEffect, useMemo, useState } from "react";
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
 * Presets are the labelled sets the experiment was measured on
 * (experiments/decide/sets), so any example can be re-run by hand and its label
 * checked against what each model says. Below the shell: the measured results
 * per use case, from the latest scripts/decide-bench.mjs run.
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
        input={
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
              <span>Preset</span>
              <select
                value={presetSet}
                onChange={(e) => applySet(e.target.value)}
                aria-label="Labelled set"
                className="rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-xs text-gray-200"
              >
                <option value="">— write your own —</option>
                {data?.sets.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title} ({s.items.length})
                  </option>
                ))}
              </select>
              {set && (
                <select
                  value={presetItem}
                  onChange={(e) => applyItem(e.target.value)}
                  aria-label="Labelled example"
                  className="max-w-[26rem] rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-xs text-gray-200"
                >
                  <option value="">pick an example…</option>
                  {set.items.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.id} · {i.label} · {(i.context ?? i.title ?? "").slice(0, 60)}
                    </option>
                  ))}
                </select>
              )}
              {expected && (
                <span className="rounded bg-gray-800 px-1.5 py-0.5 text-[11px] text-gray-300" title="The hand label for this example">
                  labelled: <b className="text-gray-100">{expected}</b>
                </span>
              )}
            </div>
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="The question, e.g. Is this feedback a bug report?"
              aria-label="Question"
              className={inputCls}
            />
            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-xs text-gray-400">
                  <span>Type</span>
                  {(["choice", "yesno", "score"] as const).map((t) => (
                    <label key={t} className="flex items-center gap-1">
                      <input type="radio" name="decide-type" checked={type === t} onChange={() => setType(t)} className="accent-orange-500" />
                      {t === "yesno" ? "yes / no" : t === "score" ? "score (low → high)" : "choice"}
                    </label>
                  ))}
                </div>
                {type === "yesno" ? (
                  <p className="rounded-lg border border-dashed border-gray-800 px-3 py-6 text-xs text-gray-500">Answers are yes and no.</p>
                ) : (
                  <textarea
                    value={choicesText}
                    onChange={(e) => setChoicesText(e.target.value)}
                    rows={5}
                    placeholder={"One option per line, optionally with what it means:\nbug: something is broken\nfeature_request: asks for something new\nnoise"}
                    aria-label="Choices"
                    className={`${inputCls} resize-y font-mono text-xs`}
                  />
                )}
              </div>
              <textarea
                value={context}
                onChange={(e) => setContext(e.target.value)}
                rows={type === "yesno" ? 4 : 7}
                placeholder="The context: what the decision is about. Any language."
                aria-label="Context"
                className={`${inputCls} resize-y`}
              />
            </div>
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
        renderOutput={(r) => (r.output ? <Distribution out={r.output} expected={expected} /> : null)}
      />
      <Results summary={data?.summary ?? null} />
    </div>
  );
}

function Distribution({ out, expected }: { out: DecisionLabOutput; expected?: string }) {
  const rows = Object.entries(out.probabilities).sort((a, b) => b[1] - a[1]);
  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-200">
        <span className="text-gray-500">Decision: </span>
        <b className="text-gray-50">{out.choice}</b>
        <span className="ml-2 tabular-nums text-gray-400">{(out.confidence * 100).toFixed(1)}%</span>
        {expected && (
          <span className={`ml-3 text-xs ${expected === out.choice ? "text-emerald-300" : "text-red-300"}`}>
            {expected === out.choice ? "✓ matches the label" : `✕ labelled ${expected}`}
          </span>
        )}
      </p>
      <ul className="space-y-1.5" aria-label="Probability distribution">
        {rows.map(([label, p]) => (
          <li key={label} className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_3.5rem] items-center gap-2 text-xs">
            <span className={`truncate ${label === out.choice ? "text-gray-100" : "text-gray-400"}`} title={label}>
              {label}
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
      <p className="text-[11px] text-gray-500">
        {out.checkpoint && <>checkpoint <b className="text-gray-400">{out.checkpoint}</b> · </>}
        {out.modelLatencyMs != null && <>forward pass {out.modelLatencyMs.toFixed(1)} ms · </>}
        {out.parsed === false && <span className="text-amber-300">reply was not the requested JSON — distribution is a fallback · </span>}
        {out.routingReason && <span title="laya's router">{out.routingReason}</span>}
      </p>
    </div>
  );
}

function pct(n: number | null | undefined, digits = 0) {
  return n == null ? "—" : `${(n * 100).toFixed(digits)}%`;
}

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
    <section className="rounded-xl border border-gray-800 bg-gray-900/40">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-gray-800 px-4 py-2.5">
        <h2 className="text-sm font-medium text-gray-200">Measured on the labelled sets</h2>
        <span className="text-[11px] text-gray-500">
          {summary.date} · {summary.host} · {summary.file}
        </span>
      </header>
      <div className="divide-y divide-gray-800/70">
        {summary.sets.map((s) => {
          const models = summary.models.filter((m) => s.scores[m]);
          const best = Math.max(...models.map((m) => s.scores[m].accuracy));
          return (
            <div key={s.id} className="px-4 py-3">
              <button
                type="button"
                onClick={() => setOpen(open === s.id ? null : s.id)}
                className="mb-2 flex w-full items-baseline justify-between text-left"
              >
                <span className="text-sm text-gray-200">
                  {s.title} <span className="text-[11px] text-gray-500">n={s.n} · {s.labels.length} labels</span>
                </span>
                <span className="text-[11px] text-gray-500">{open === s.id ? "hide reliability" : "reliability plots"}</span>
              </button>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[40rem] text-left text-xs">
                  <thead className="text-[10px] uppercase tracking-wide text-gray-500">
                    <tr>
                      <th className="py-1 pr-2 font-medium">Model</th>
                      <th className="px-2 py-1 text-right font-medium">Accuracy</th>
                      <th className="px-2 py-1 text-right font-medium">Macro F1</th>
                      <th className="px-2 py-1 text-right font-medium" title="Expected calibration error, 10 bins. Lower is better.">ECE</th>
                      <th className="px-2 py-1 text-right font-medium" title="After one fitted temperature, cross-fitted over halves">ECE, tempered</th>
                      <th className="px-2 py-1 text-right font-medium">p50</th>
                      <th className="px-2 py-1 text-right font-medium">p95</th>
                      <th className="py-1 pl-2 text-right font-medium">$/1k</th>
                    </tr>
                  </thead>
                  <tbody className="text-gray-300">
                    {models.map((m) => {
                      const sc = s.scores[m];
                      return (
                        <tr key={m} className="border-t border-gray-800/50">
                          <td className="py-1 pr-2">
                            {m}
                            {(sc.errors > 0 || sc.unparsed > 0) && (
                              <span className="ml-1 text-[10px] text-amber-300">
                                {sc.errors ? `${sc.errors} err ` : ""}
                                {sc.unparsed ? `${sc.unparsed} unparsed` : ""}
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
                            {sc.costPer1000Usd == null ? "local" : `$${sc.costPer1000Usd.toFixed(3)}`}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <CascadeLine set={s} />
              {open === s.id && (
                <div className="mt-3 flex flex-wrap gap-4">
                  {models.map((m) => (
                    <ReliabilityPlot key={m} title={m} bins={s.scores[m].reliability} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function CascadeLine({ set }: { set: Summary["sets"][number] }) {
  const b = bestCascade(set);
  if (!set.cascades) return null;
  return (
    <p className="mt-2 text-[11px] text-gray-400">
      {b ? (
        <>
          Laya first ({b.model}), {b.fallback} below {Math.round(b.threshold * 100)}% confidence:{" "}
          <b className="text-gray-200">{pct(b.accuracy)}</b> accuracy with <b className="text-gray-200">{pct(b.saved)}</b> of LLM calls saved
          <span className="text-gray-500"> ({b.fallback} alone {pct(b.fallbackAccuracy)})</span>
        </>
      ) : (
        <>No confidence threshold lets Laya answer any share of these without losing more than two points against {set.cascades.fallback} alone.</>
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
      <svg width={S + 24} height={S + 20} role="img" aria-label={`Reliability plot for ${title}`}>
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
                  <title>{`confidence ${(b.confidence * 100).toFixed(0)}% → accuracy ${(b.accuracy * 100).toFixed(0)}% (n=${b.n})`}</title>
                </circle>
              </g>
            ))}
          <text x={0} y={S + 12} className="fill-gray-500">0</text>
          <text x={S - 18} y={S + 12} className="fill-gray-500">conf 1</text>
          <text x={-16} y={8} className="fill-gray-500">1</text>
        </g>
      </svg>
      <figcaption className="max-w-[9rem] truncate text-gray-400">{title}</figcaption>
    </figure>
  );
}
