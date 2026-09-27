"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * The runs record for one surface, newest first — what makes a comparison
 * survive a reload. Shared by every Lab (through LabShell) and by the Arena,
 * which records under `lab: "arena"` without being a Lab.
 *
 * `refreshKey`: bump it when a run finishes. The table re-reads the record then
 * rather than polling, because rows only appear when this page causes them.
 */

type RecentRun = {
  id: string;
  model: string;
  local: boolean;
  compareGroup: string | null;
  inputSummary: string;
  seed: number | null;
  status: "ok" | "error";
  error: string | null;
  latencyMs: number | null;
  peakVramGb: number | null;
  costUsd: number | null;
  createdAt: string;
};

export default function RecentRuns({
  lab,
  refreshKey = 0,
  limit = 12,
  className = "",
}: {
  /** The `lab` value runs were recorded under. */
  lab: string;
  refreshKey?: number;
  limit?: number;
  className?: string;
}) {
  const [runs, setRuns] = useState<RecentRun[]>([]);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/labs/runs?lab=${encodeURIComponent(lab)}&limit=${limit}`, { cache: "no-store" });
      const j = await r.json();
      setRuns(Array.isArray(j?.runs) ? j.runs : []);
    } catch {
      /* the record is history; the page still works without it */
    }
  }, [lab, limit]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  return (
    <section className={`rounded-xl border border-gray-800 bg-gray-900/40 ${className}`}>
      <h2 className="border-b border-gray-800 px-4 py-2.5 text-sm font-medium text-gray-200">Recent runs</h2>
      {runs.length === 0 ? (
        <p className="px-4 py-4 text-xs text-gray-500">No runs recorded yet. Every run here is kept, with its model, host, seed and numbers.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-[10px] uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2 font-medium">When</th>
                <th className="px-2 py-2 font-medium">Model</th>
                <th className="px-2 py-2 font-medium">Input</th>
                <th className="px-2 py-2 text-right font-medium">Latency</th>
                <th className="px-2 py-2 text-right font-medium">Peak VRAM</th>
                <th className="px-4 py-2 text-right font-medium">Cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/60 text-gray-300">
              {runs.map((r) => (
                <tr key={r.id} title={r.error ?? undefined} className={r.status === "error" ? "text-red-300/80" : undefined}>
                  <td className="whitespace-nowrap px-4 py-1.5 text-gray-500">
                    {new Date(r.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                    {r.compareGroup && <span className="ml-1 text-[9px] text-orange-300/70" title={`Comparison ${r.compareGroup}`}>⇄</span>}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5">
                    {r.model} <span className="text-[10px] text-gray-500">{r.local ? "local" : "cloud"}</span>
                    {r.seed != null && <span className="ml-1 text-[10px] text-gray-500">seed {r.seed}</span>}
                  </td>
                  <td className="max-w-[28rem] truncate px-2 py-1.5 text-gray-400">{r.status === "error" ? `✕ ${r.error}` : r.inputSummary}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">{fmtLatency(r.latencyMs)}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">{r.peakVramGb != null ? `${r.peakVramGb.toFixed(1)} GB` : "—"}</td>
                  <td className="whitespace-nowrap px-4 py-1.5 text-right tabular-nums">{fmtCost(r.costUsd, r.local)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function fmtLatency(ms: number | null): string {
  if (ms == null) return "—";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

/** Local runs are not metered; saying "$0" would read as "free", which is a different claim. */
export function fmtCost(usd: number | null, local: boolean): string {
  if (usd == null) return local ? "not metered" : "cost n/a";
  return usd < 0.01 ? `$${usd.toFixed(5)}` : `$${usd.toFixed(3)}`;
}
