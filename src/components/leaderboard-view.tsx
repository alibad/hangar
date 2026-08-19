"use client";

import { useMemo, useState } from "react";
import { ToolSectionHeading } from "./tool-page";
import { Warning } from "@phosphor-icons/react";

/**
 * The llm-stats.com leaderboard, filtered down to one machine.
 *
 * The value here is not the leaderboard — that is a browser tab away. It is the
 * join: llm-stats publishes a parameter count for every open-weights model, and
 * a parameter count plus this card is enough to answer "could I run this, and at
 * what quantisation" for all ~200 of them at once. A leaderboard cannot tell you
 * that, and this console could not tell you what was worth running until it had
 * the leaderboard. Neither half is useful alone.
 *
 * Ranked by capability among what RUNS here, never by capability overall. A 744B
 * model at the top of the chart is not information on a 32 GB card.
 */

type Fit = {
  verdict: "fits" | "tight" | "swap" | "no" | "off-box";
  headline: string;
  vramNeededGb: number;
  ramNeededGb: number;
  diskNeededGb: number;
  displaces: string[];
  reasons: string[];
  basis?: string;
};

type PrecisionFit = {
  precision: string;
  label: string;
  note: string;
  requirement: { vramGb?: number; ramGb?: number; diskGb?: number; basis?: string };
  fit: Fit;
};

type Stats = {
  model_id: string;
  name: string;
  organization: string;
  gpqa_score: number | null;
  swe_bench_verified_score: number | null;
  hle_score: number | null;
  context: number | null;
  param_count: number | null;
  input_price: number | null;
  output_price: number | null;
  throughput: number | null;
  is_open_source: boolean;
  release_date: string | null;
};

export type OpenWeightsCandidate = {
  stats: Stats;
  paramsB: number;
  best: PrecisionFit | null;
  rungs: PrecisionFit[];
  scored: boolean;
};

export type LeaderboardPayload = {
  fetchedAt: string;
  source: string;
  stale?: boolean;
  error?: string;
  total: number;
  openWeights: OpenWeightsCandidate[];
  runnable: number;
};

type Machine = {
  gpuName: string;
  vramTotalGb: number;
  weightsDiskFreeGb: number;
  weightsDiskLabel: string;
  weightsDiskTotalGb?: number;
  weightsUsedGb?: number;
  weightsPath?: string;
  weightsIndexed?: boolean;
};

const VERDICT_STYLE: Record<Fit["verdict"], string> = {
  fits: "bg-green-500/10 text-green-400 border-green-500/25",
  tight: "bg-amber-500/10 text-amber-300 border-amber-500/25",
  swap: "bg-blue-500/10 text-blue-300 border-blue-500/25",
  no: "bg-red-500/10 text-red-400 border-red-500/25",
  "off-box": "bg-gray-700/30 text-gray-400 border-gray-600/40",
};
const VERDICT_LABEL: Record<Fit["verdict"], string> = {
  fits: "fits",
  tight: "fits alone",
  swap: "needs a swap",
  no: "won't fit",
  "off-box": "off-box",
};

function pct(v: number | null): string {
  return typeof v === "number" ? `${Math.round(v * 100)}` : "—";
}
function paramLabel(b: number): string {
  return b >= 1000 ? `${(b / 1000).toFixed(1)}T` : `${Math.round(b)}B`;
}

export default function LeaderboardView({
  leaderboard,
  machine,
}: {
  leaderboard: LeaderboardPayload;
  machine: Machine;
}) {
  const [onlyRunnable, setOnlyRunnable] = useState(true);
  const [limit, setLimit] = useState(40);

  const rows = useMemo(
    () => (onlyRunnable ? leaderboard.openWeights.filter((c) => c.best) : leaderboard.openWeights),
    [leaderboard.openWeights, onlyRunnable],
  );
  const shown = rows.slice(0, limit);

  // Disk is the constraint the storage module owns, and the one that decides
  // whether a download can even start. Worth stating once, in bytes, rather than
  // only appearing inside a per-model verdict.
  const diskLine = [
    `${machine.weightsDiskFreeGb} GB free`,
    machine.weightsDiskTotalGb ? `of ${machine.weightsDiskTotalGb} GB` : null,
    machine.weightsIndexed && machine.weightsUsedGb != null
      ? `· ${machine.weightsUsedGb} GB of weights already downloaded`
      : machine.weightsIndexed === false
        ? "· usage unknown, that drive has not been indexed"
        : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="space-y-5">
      <ToolSectionHeading
        eyebrow="Leaderboard"
        title="Every open-weights model, ranked by what this card can run"
        description="Pulled whole from llm-stats.com. Open models publish a parameter count, so each one is sized against this GPU and the weights drive — best model first, not smallest."
        action={
          <label className="flex items-center gap-2 text-[11px] text-gray-400 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={onlyRunnable}
              onChange={(e) => setOnlyRunnable(e.target.checked)}
              className="accent-indigo-500"
            />
            runnable here only
          </label>
        }
      />

      <section className="tool-panel bg-gray-900 rounded-xl border border-gray-800 p-4">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-2xl font-semibold text-gray-100 tabular-nums">{leaderboard.runnable}</span>
          <span className="text-sm text-gray-400">
            of {leaderboard.openWeights.length} open-weights models run on this box
          </span>
          <span className="text-[11px] text-gray-600 ml-auto">
            {leaderboard.total} models on the board · pulled{" "}
            {leaderboard.fetchedAt.startsWith("1970") ? "never" : leaderboard.fetchedAt.slice(0, 16).replace("T", " ")}
          </span>
        </div>
        <p className="text-[11px] text-gray-500 mt-2 tabular-nums">
          {machine.gpuName} · {machine.vramTotalGb} GB VRAM — {machine.weightsDiskLabel} {diskLine}
        </p>
        {machine.weightsPath && (
          <p className="text-[10px] text-gray-600 mt-0.5 font-mono">{machine.weightsPath}</p>
        )}
        {leaderboard.stale && (
          <p className="mt-2 inline-flex items-start gap-1.5 text-[11px] text-amber-300/90 leading-relaxed">
            <Warning size={13} weight="fill" className="mt-0.5 shrink-0" />
            <span>
              Showing the last good pull — the live fetch failed ({leaderboard.error}). Fit verdicts below are still
              computed against this machine as it is right now.
            </span>
          </p>
        )}
      </section>

      <div className="overflow-x-auto rounded-xl border border-gray-800">
        <table className="w-full text-left border-collapse min-w-[820px]">
          <thead>
            <tr className="text-[10px] uppercase tracking-wide text-gray-600 bg-gray-900/80">
              <th className="px-3 py-2 font-medium">Model</th>
              <th className="px-3 py-2 font-medium text-right">Size</th>
              <th className="px-3 py-2 font-medium">Runs at</th>
              <th className="px-3 py-2 font-medium text-right">VRAM</th>
              <th className="px-3 py-2 font-medium text-right">Disk</th>
              <th className="px-3 py-2 font-medium text-right" title="GPQA Diamond, %">GPQA</th>
              <th className="px-3 py-2 font-medium text-right" title="SWE-bench Verified, %">SWE</th>
              <th className="px-3 py-2 font-medium text-right" title="Humanity's Last Exam, %">HLE</th>
              <th className="px-3 py-2 font-medium text-right">Context</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((c) => {
              const b = c.best;
              const disk = b?.requirement.diskGb ?? 0;
              // A download bigger than the free space is the one failure you can
              // see coming, so it is called out on the row rather than left to
              // the verdict tooltip.
              const noRoom = disk > machine.weightsDiskFreeGb;
              return (
                <tr key={c.stats.model_id} className="border-t border-gray-800/70 hover:bg-gray-900/50">
                  <td className="px-3 py-2">
                    <div className="text-[12px] text-gray-200">{c.stats.name}</div>
                    <div className="text-[10px] text-gray-600 font-mono">
                      {c.stats.organization}
                      {c.stats.release_date ? ` · ${c.stats.release_date}` : ""}
                      {!c.scored && " · not yet benchmarked"}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right text-[11px] text-gray-400 tabular-nums">
                    {paramLabel(c.paramsB)}
                  </td>
                  <td className="px-3 py-2">
                    {b ? (
                      <span
                        className={`inline-flex items-center gap-1.5 text-[10px] px-1.5 py-0.5 rounded-full border ${VERDICT_STYLE[b.fit.verdict]}`}
                        title={[b.note, b.fit.headline, ...b.fit.reasons, b.requirement.basis]
                          .filter(Boolean)
                          .join("\n\n")}
                      >
                        <span className="font-medium">{b.label}</span>
                        <span className="opacity-70">{VERDICT_LABEL[b.fit.verdict]}</span>
                      </span>
                    ) : (
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded-full border ${VERDICT_STYLE.no}`}
                        title="Too large for this card at every quantisation on the ladder, down to 2-bit."
                      >
                        won&apos;t fit at any quantisation
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right text-[11px] text-gray-400 tabular-nums">
                    {b?.requirement.vramGb ? `${b.requirement.vramGb} GB` : "—"}
                  </td>
                  <td
                    className={`px-3 py-2 text-right text-[11px] tabular-nums ${noRoom ? "text-red-400" : "text-gray-500"}`}
                    title={noRoom ? `Needs ${disk} GB but only ${machine.weightsDiskFreeGb} GB is free.` : undefined}
                  >
                    {disk ? `${disk} GB` : "—"}
                  </td>
                  <td className="px-3 py-2 text-right text-[11px] text-gray-300 tabular-nums">{pct(c.stats.gpqa_score)}</td>
                  <td className="px-3 py-2 text-right text-[11px] text-gray-500 tabular-nums">
                    {pct(c.stats.swe_bench_verified_score)}
                  </td>
                  <td className="px-3 py-2 text-right text-[11px] text-gray-500 tabular-nums">{pct(c.stats.hle_score)}</td>
                  <td className="px-3 py-2 text-right text-[11px] text-gray-600 tabular-nums">
                    {c.stats.context ? `${Math.round(c.stats.context / 1024)}k` : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-3">
        {shown.length < rows.length && (
          <button
            onClick={() => setLimit((n) => n + 60)}
            className="text-[11px] text-gray-300 hover:text-white border border-gray-700 hover:border-gray-500 rounded-md px-2.5 py-1.5 transition cursor-pointer"
          >
            Show more ({rows.length - shown.length} left)
          </button>
        )}
        <a
          href={leaderboard.source}
          target="_blank"
          rel="noreferrer"
          className="text-[11px] text-indigo-400 hover:text-indigo-300 underline underline-offset-2 ml-auto"
        >
          llm-stats.com ↗
        </a>
      </div>

      <p className="text-[10px] text-gray-600 leading-relaxed">
        Benchmark columns are llm-stats.com&apos;s, shown as published. Row order uses all four (GPQA, SWE-bench, HLE,
        arena) as percentile ranks with missing scores treated as the median, so a model is neither rewarded nor
        punished for how much has been measured about it. VRAM and disk are <em>estimates</em> from parameter count and
        quantisation — hover any &ldquo;runs at&rdquo; badge for the arithmetic. Measured footprints for models actually
        installed here live in <span className="font-mono text-gray-500">config/model-meta.json</span> and always win.
      </p>
    </div>
  );
}
