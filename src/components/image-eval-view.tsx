"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { cellKey, PICK, summarize, type EvalCell, type Verdicts } from "@/lib/image-eval";
import { IMAGE_MODELS } from "@/lib/image-models";
import Markdown from "@/components/markdown";

/**
 * The image evaluation suite, laid out for a person to judge.
 *
 * Per prompt, every model in a row, same seeds. Latency and whole-card peak
 * VRAM sit under each image because they were measured on that exact run.
 * Scoring is deliberately left to the viewer: objective checks ("exactly five
 * apples") are yes/no toggles, and the taste call is a separate pick. Nothing
 * here grades an image automatically.
 *
 * Runs come from scripts/experiment-image-suite.mjs; the page never generates.
 */

type SuitePrompt = { id: string; dimension: string; prompt: string; gloss?: string; objective: string[]; taste: string[] };
type EditInstruction = { id: string; kind: string; prompt: string; objective: string[] };
type Suite = {
  version: number;
  seeds: number[];
  prompts: SuitePrompt[];
  edits: { source: { id: string; prompt: string }; instructions: EditInstruction[] };
};
type Manifest = { run: string; host: string; cells: EvalCell[]; warm?: { note: string; results: { model: string; run: string; ms: number; peakMiB: number; baselineMiB: number }[] } };
type Payload = { suite: Suite; runs: string[]; run: string | null; manifest: Manifest | null; verdicts: Verdicts; error?: string };

type Study = "suite" | "resolution" | "edit";

const DOC = "docs/image-model-experiment-2026-09-26.md";

function modelName(id: string): string {
  return IMAGE_MODELS.find((m) => m.id === id)?.name ?? LOCAL_EDIT_MODELS[id] ?? RETIRED_MODELS[id] ?? id;
}
function imgUrl(rel: string): string {
  return `/api/qwen/images/file?rel=${encodeURIComponent(rel)}`;
}
function secs(ms?: number | null): string {
  return ms == null ? "—" : `${(ms / 1000).toFixed(1)} s`;
}
function gib(mib?: number | null): string {
  return mib == null ? "—" : `${(mib / 1024).toFixed(1)} GiB`;
}
/** The edit study names Qwen's edit checkpoint, which is not a generation model id. */
const LOCAL_EDIT_MODELS: Record<string, string> = { "qwen-image-edit": "Qwen-Image-Edit (2511 since 3 Oct)" };
/** Local models that are no longer offered but still appear in recorded runs. */
const RETIRED_MODELS: Record<string, string> = { "flux-schnell": "FLUX.1 schnell (retired)" };
function isLocal(id: string): boolean {
  return IMAGE_MODELS.some((m) => m.id === id) || id in LOCAL_EDIT_MODELS || id in RETIRED_MODELS;
}
/** The first sentence of a failure, for the cell; the full text stays one click away. */
function shortReason(error: string): string {
  if (/\b429\b|quota/i.test(error)) return "Provider quota exhausted (HTTP 429).";
  const first = error.split(/(?<=[.;])\s|\n/)[0];
  return first.length > 140 ? `${first.slice(0, 137)}…` : first;
}
/** Local runs are not metered — shown as such, never as "$0". */
function usd(c: number | null | undefined, local: boolean): string {
  if (local) return "local · not metered";
  return c == null ? "—" : `$${c.toFixed(3)}`;
}

export default function ImageEvalView() {
  const [data, setData] = useState<Payload | null>(null);
  const [run, setRun] = useState<string | null>(null);
  const [study, setStudy] = useState<Study>("suite");
  const [dimension, setDimension] = useState<string>("all");
  const [zoom, setZoom] = useState<{ src: string; label: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (which: string | null) => {
    try {
      const r = await fetch(`/api/image/eval${which ? `?run=${encodeURIComponent(which)}` : ""}`, { cache: "no-store" });
      const j = (await r.json()) as Payload;
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setData(j);
      setRun(j.run);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void load(null); }, [load]);

  const cells = useMemo(() => data?.manifest?.cells ?? [], [data]);
  const verdicts = useMemo(() => data?.verdicts ?? {}, [data]);

  /** Column order: local models in registry order, then cloud aliases. */
  const models = useMemo(() => {
    const present = [...new Set(cells.filter((c) => c.study === study).map((c) => c.model))];
    const local = IMAGE_MODELS.map((m) => m.id).filter((id) => present.includes(id));
    return [...local, ...present.filter((id) => !local.includes(id)).sort()];
  }, [cells, study]);

  const summary = useMemo(() => summarize(cells, verdicts, study), [cells, verdicts, study]);

  const judge = useCallback(async (cell: EvalCell, check: string, value: boolean | null) => {
    if (!run) return;
    const key = cellKey(cell);
    // Optimistic: the toggle should feel instant; the file write is tiny.
    setData((d) => {
      if (!d) return d;
      const entry = { ...(d.verdicts[key] ?? {}) };
      if (value === null) delete entry[check]; else entry[check] = value;
      return { ...d, verdicts: { ...d.verdicts, [key]: entry } };
    });
    const r = await fetch("/api/image/eval", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ run, cell: key, check, value }) });
    if (!r.ok) setError(`Could not save verdict (HTTP ${r.status})`);
  }, [run]);

  if (error && !data) return <div className="rounded-xl border border-red-900 bg-red-950/40 p-4 text-sm text-red-300">{error}</div>;
  if (!data) return <div className="p-4 text-sm text-gray-400">Loading evaluation runs…</div>;
  if (!data.manifest) {
    return (
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-5 text-sm text-gray-300 space-y-2">
        <p>No evaluation run yet. The suite has {data.suite.prompts.length} fixed prompts × {data.suite.seeds.length} seeds.</p>
        <p className="text-gray-400">Run it from the console directory: <code className="text-gray-200">node scripts/experiment-image-suite.mjs generate</code></p>
      </div>
    );
  }

  const prompts: { id: string; dimension: string; prompt: string; gloss?: string; objective: string[]; taste?: string[]; kind?: string }[] =
    study === "edit"
      ? data.suite.edits.instructions.map((i) => ({ ...i, dimension: "editing" }))
      : data.suite.prompts.filter((p) => cells.some((c) => c.study === study && c.promptId === p.id));
  const dims = [...new Set(prompts.map((p) => p.dimension))];
  const shown = prompts.filter((p) => dimension === "all" || p.dimension === dimension);
  const editSource = cells.find((c) => c.study === "edit-source" && c.savedPath);

  return (
    <div className="space-y-4">
      <WhatWeLearned path={DOC} />
      <section className="rounded-xl border border-gray-800 bg-gray-900 p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-2 text-gray-400">
            Run
            <select value={run ?? ""} onChange={(e) => void load(e.target.value)} className="rounded bg-gray-800 border border-gray-700 px-2 py-1 text-gray-100">
              {data.runs.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
          <div className="flex rounded-lg border border-gray-700 overflow-hidden" role="tablist" aria-label="Study">
            {(["suite", "resolution", "edit"] as const).map((s) => (
              <button key={s} role="tab" aria-selected={study === s} onClick={() => { setStudy(s); setDimension("all"); }}
                className={`px-3 py-1 capitalize ${study === s ? "bg-indigo-600 text-white" : "bg-gray-800 text-gray-300 hover:bg-gray-700"}`}>
                {s === "suite" ? "Prompt suite" : s}
              </button>
            ))}
          </div>
          {dims.length > 1 && (
            <select value={dimension} onChange={(e) => setDimension(e.target.value)} className="rounded bg-gray-800 border border-gray-700 px-2 py-1 text-gray-100" aria-label="Dimension">
              <option value="all">All dimensions</option>
              {dims.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          )}
          <button onClick={() => void load(run)} className="rounded bg-gray-800 border border-gray-700 px-2 py-1 text-gray-300 hover:bg-gray-700">Refresh</button>
          <span className="ml-auto text-xs text-gray-500">
            Host {data.manifest.host} · findings in <code>{DOC}</code>
          </span>
        </div>
        <p className="text-xs text-gray-400">
          <span className="text-emerald-300">✓/✗</span> are objective checks — anyone would answer them the same way.
          <span className="text-amber-300"> ★</span> is your taste pick for the prompt. Nothing is scored automatically.
          Latency is console request to saved PNG; VRAM is whole-card peak (includes the desktop).
        </p>
        {error && <p className="text-xs text-red-300">{error}</p>}

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-gray-400">
              <tr className="text-left">
                <th className="py-1 pr-3 font-medium">Model</th>
                <th className="py-1 pr-3 font-medium">Images</th>
                <th className="py-1 pr-3 font-medium">Objective checks passed</th>
                <th className="py-1 pr-3 font-medium">★ picks</th>
                <th className="py-1 pr-3 font-medium">Median latency</th>
                <th className="py-1 pr-3 font-medium">Peak VRAM</th>
                <th className="py-1 pr-3 font-medium">Cost / image</th>
              </tr>
            </thead>
            <tbody className="text-gray-200">
              {models.map((id) => {
                const s = summary.find((x) => x.model === id);
                if (!s) return null;
                return (
                  <tr key={id} className="border-t border-gray-800">
                    <td className="py-1 pr-3">{modelName(id)}</td>
                    <td className="py-1 pr-3">{s.images}{s.failures ? <span className="text-red-400"> · {s.failures} failed</span> : null}</td>
                    <td className="py-1 pr-3">{s.judged ? `${s.passed}/${s.judged} (${Math.round((100 * s.passed) / s.judged)}%)` : <span className="text-gray-500">not judged yet</span>}</td>
                    <td className="py-1 pr-3">{s.picks}</td>
                    <td className="py-1 pr-3">{secs(s.medianLatencyMs)}</td>
                    <td className="py-1 pr-3">{gib(s.maxPeakMiB)}</td>
                    <td className="py-1 pr-3">{usd(s.meanCostUsd, isLocal(id))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {study === "edit" && editSource?.savedPath && (
        <section className="rounded-xl border border-gray-800 bg-gray-900 p-4 flex gap-4 items-start">
          <button onClick={() => setZoom({ src: imgUrl(editSource.savedPath!), label: "Edit source" })} className="shrink-0">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={imgUrl(editSource.savedPath)} alt="Edit source" className="w-48 rounded-lg border border-gray-700" />
          </button>
          <div className="text-sm text-gray-300">
            <p className="font-medium text-gray-100">Source image (every edit starts from these pixels)</p>
            <p className="text-gray-400 mt-1">{data.suite.edits.source.prompt}</p>
          </div>
        </section>
      )}

      {shown.map((p) => {
        // Suite and edit rows are seeds; resolution rows are the variants (native 2K, direct 2K, upscaled).
        const rowOf = (c: EvalCell): string => (study === "resolution" ? c.variant ?? "" : String(c.seed));
        const rows = study === "suite" ? data.suite.seeds.map(String) : [...new Set(cells.filter((c) => c.study === study && c.promptId === p.id).map(rowOf))];
        return (
          <section key={p.id} className="rounded-xl border border-gray-800 bg-gray-900 p-4 space-y-3">
            <header className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="rounded bg-gray-800 px-2 py-0.5 text-[11px] uppercase tracking-wide text-gray-400">{p.dimension}</span>
                <span className="text-sm font-medium text-gray-100">{p.id}</span>
                {p.kind && <span className="text-xs text-gray-400">· {p.kind}</span>}
              </div>
              <p className="text-sm text-gray-300" dir="auto">{p.prompt}</p>
              {p.gloss && <p className="text-xs text-gray-500">({p.gloss})</p>}
              {p.taste?.length ? <p className="text-xs text-gray-500">Taste: {p.taste.join(" · ")}</p> : null}
            </header>
            {rows.map((row) => (
              <div key={row} className="space-y-1">
                <p className="text-[11px] text-gray-500">{study === "resolution" ? row : `seed ${row}`}</p>
                {/* One row per seed, every model in it; scrolls sideways rather than wrapping, so a column is always one model. */}
                <div className="overflow-x-auto pb-1">
                <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.max(models.length, 1)}, minmax(170px, 360px))` }}>
                  {models.map((m) => {
                    const cell = cells.find((c) => c.study === study && c.model === m && c.promptId === p.id && rowOf(c) === row);
                    return <CellCard key={m} model={m} cell={cell} checks={p.objective} verdict={cell ? verdicts[cellKey(cell)] ?? {} : {}} onJudge={judge} onZoom={setZoom} />;
                  })}
                </div>
                </div>
              </div>
            ))}
          </section>
        );
      })}

      {study === "suite" && data.manifest.warm && (
        <section className="rounded-xl border border-gray-800 bg-gray-900 p-4 text-xs text-gray-300 space-y-2">
          <p className="text-sm font-medium text-gray-100">Cold vs warm (direct to ComfyUI)</p>
          <p className="text-gray-400">{data.manifest.warm.note}</p>
          <table className="text-xs">
            <tbody>
              {data.manifest.warm.results.map((r, i) => (
                <tr key={i}><td className="pr-4">{modelName(r.model)}</td><td className="pr-4">{r.run}</td><td className="pr-4">{secs(r.ms)}</td><td>{gib(r.peakMiB)}</td></tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {zoom && (
        <div role="dialog" aria-label={zoom.label} className="fixed inset-0 z-50 bg-black/85 flex flex-col items-center justify-center p-4" onClick={() => setZoom(null)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={zoom.src} alt={zoom.label} className="max-h-[90vh] max-w-full object-contain" />
          <p className="mt-2 text-sm text-gray-300">{zoom.label} — click anywhere to close</p>
        </div>
      )}
    </div>
  );
}

/** The experiment write-up, loaded on open — what was learned, not only what ran. */
function WhatWeLearned({ path }: { path: string }) {
  const [md, setMd] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <details
      className="rounded-xl border border-gray-800 bg-gray-900/40"
      onToggle={(e) => {
        if (!(e.currentTarget as HTMLDetailsElement).open || md || err) return;
        fetch(`/api/labs/doc?path=${encodeURIComponent(path)}`)
          .then((r) => r.json())
          .then((j) => (j.markdown ? setMd(j.markdown) : setErr(j.error ?? "Could not load.")))
          .catch((e) => setErr(String(e)));
      }}
    >
      <summary className="cursor-pointer px-4 py-2.5 text-sm font-medium text-gray-200">
        What we learned <span className="ml-1 text-[11px] font-normal text-gray-500">{path}</span>
      </summary>
      <div className="max-h-[32rem] overflow-y-auto border-t border-gray-800 px-4 py-3">
        {err ? <p className="text-xs text-red-300">{err}</p> : md ? <Markdown>{md}</Markdown> : <p className="text-xs text-gray-500">Loading…</p>}
      </div>
    </details>
  );
}

function CellCard({ model, cell, checks, verdict, onJudge, onZoom }: {
  model: string;
  cell?: EvalCell;
  checks: string[];
  verdict: Record<string, boolean>;
  onJudge: (cell: EvalCell, check: string, value: boolean | null) => void;
  onZoom: (z: { src: string; label: string }) => void;
}) {
  const label = modelName(model);
  if (!cell) return <div className="rounded-lg border border-dashed border-gray-800 p-3 text-xs text-gray-600">{label}<br />not run</div>;
  if (!cell.ok || !cell.savedPath) {
    return (
      <div className="rounded-lg border border-red-900/60 bg-red-950/20 p-3 text-xs text-red-300 space-y-1">
        <p className="font-medium">{label}</p>
        <p className="break-words">{shortReason(cell.error ?? "failed")}</p>
        {cell.error || cell.coordinator ? (
          <details className="text-red-400/80">
            <summary className="cursor-pointer text-red-400/70">details</summary>
            <p className="mt-1 max-h-40 overflow-y-auto break-words">
              {cell.error}
              {cell.coordinator ? ` Coordinator: ${typeof cell.coordinator === "string" ? cell.coordinator : JSON.stringify(cell.coordinator)}` : null}
            </p>
          </details>
        ) : null}
      </div>
    );
  }
  const picked = verdict[PICK] === true;
  return (
    <figure className={`rounded-lg border ${picked ? "border-amber-400" : "border-gray-800"} bg-gray-950 overflow-hidden`}>
      <button className="block w-full" onClick={() => onZoom({ src: imgUrl(cell.savedPath!), label: `${label} · ${cell.promptId}` })}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={imgUrl(cell.savedPath)} alt={`${label}: ${cell.promptId}`} loading="lazy" className="w-full aspect-square object-cover" />
      </button>
      <figcaption className="p-2 space-y-1.5">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-medium text-gray-100 truncate">{label}</span>
          <button onClick={() => onJudge(cell, PICK, picked ? null : true)} title="My pick for this prompt" aria-pressed={picked}
            className={`ml-auto text-base leading-none ${picked ? "text-amber-300" : "text-gray-600 hover:text-amber-200"}`}>★</button>
        </div>
        <p className="text-[11px] text-gray-500">
          {secs(cell.latencyMs)} · {isLocal(model) ? gib(cell.peakMiB) : usd(cell.costUsd, false)}
          {cell.requested && cell.requested !== "1024x1024" ? ` · ${cell.requested}` : ""}
        </p>
        <ul className="space-y-0.5">
          {checks.map((check) => {
            const v = verdict[check];
            return (
              <li key={check} className="flex items-start gap-1 text-[11px] leading-tight">
                <button onClick={() => onJudge(cell, check, v === true ? null : true)} aria-pressed={v === true} title="Passes"
                  className={`rounded px-1 ${v === true ? "bg-emerald-700 text-white" : "bg-gray-800 text-gray-500 hover:text-emerald-300"}`}>✓</button>
                <button onClick={() => onJudge(cell, check, v === false ? null : false)} aria-pressed={v === false} title="Fails"
                  className={`rounded px-1 ${v === false ? "bg-red-700 text-white" : "bg-gray-800 text-gray-500 hover:text-red-300"}`}>✗</button>
                <span className="text-gray-400" dir="auto">{check}</span>
              </li>
            );
          })}
        </ul>
      </figcaption>
    </figure>
  );
}
