"use client";

import { useEffect, useState } from "react";
import { Dialog, KindBadge, btn } from "./parts";
import { fmtMs, lab, type Run, type Stats } from "./api";

/**
 * How well it went: one paragraph and four numbers anyone can read, for one
 * batch of pretend clients (or all of them). The full table — per kind of
 * decision, where cases wait, reading accuracy — is under "More detail".
 */

/** "29 Sep, 14:52 · 3 clients · finished" — a batch, without its id. */
export function batchLabel(r: Run) {
  const when = new Date(r.started_at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const n = r.config?.scenarios?.length ?? 0;
  const state = r.active ? "running" : r.status === "finished" ? "finished" : "stopped";
  return `${when} · ${n} client${n === 1 ? "" : "s"} · ${state}`;
}

export default function Results({ runs, active = true }: { runs: Run[]; active?: boolean }) {
  // Default: the newest batch — usually the one you just sent in; its numbers fill in as it runs.
  const [run, setRun] = useState<string>(() => runs[0]?.id ?? "");
  const [s, setS] = useState<Stats | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [detail, setDetail] = useState(false);
  // Refreshes only while the tab is showing; when hidden it keeps what it has.
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const load = () =>
      lab<Stats>(`api/stats${run ? `?run=${encodeURIComponent(run)}` : ""}`).then(
        (x) => alive && (setS(x), setErr(null)),
        (e) => alive && setErr(String(e)),
      );
    load();
    const iv = setInterval(() => !document.hidden && load(), 8000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [run, active]);

  const tile = (label: string, value: string, sub?: string) => (
    <div className="rounded-xl border border-gray-800 bg-gray-900/60 px-4 py-3">
      <p className="text-xs text-gray-400">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-gray-100">{value}</p>
      {sub && <p className="mt-0.5 text-[11px] text-gray-500">{sub}</p>}
    </div>
  );

  return (
    <div className="space-y-5">
      <label className="flex flex-wrap items-center gap-2 text-sm text-gray-400">
        Showing
        <select value={run} onChange={(e) => setRun(e.target.value)} className="rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-gray-200">
          <option value="">every pretend client so far</option>
          {runs.map((r) => (
            <option key={r.id} value={r.id}>
              {batchLabel(r)}
            </option>
          ))}
        </select>
      </label>
      {err && <p className="text-xs text-red-300">{err}</p>}
      {!s ? (
        <p className="text-xs text-gray-500">Loading…</p>
      ) : s.cases === 0 ? (
        <p className="rounded-xl border border-gray-800 px-4 py-6 text-center text-sm text-gray-500">No clients in this batch yet.</p>
      ) : (
        <>
          <p className="max-w-3xl text-[17px] leading-relaxed text-gray-200">{summary(s)}</p>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {tile("Ended the way they should", s.pathAccuracy ? `${s.pathAccuracy.right} of ${s.pathAccuracy.of}` : "—", s.pathAccuracy ? "checked against what the lab knew should happen" : "no known answer for these clients")}
            {tile("AI wasn't sure, asked a person", `${s.escalation.escalated}×`, `out of ${s.escalation.aiDecisions} AI decisions`)}
            {tile("Typical time per case", s.cycle.medianDays != null ? `${Math.round(s.cycle.medianDays)} days` : "—", "simulated days, from request to the end")}
            {tile("Cloud cost", `$${s.models.costUsd.toFixed(2)}`, `${s.models.cloudFallbacks} of ${s.models.calls} AI answers came from the cloud`)}
          </div>
          <button onClick={() => setDetail(true)} className={btn.secondarySm}>
            More detail
          </button>
          <Dialog open={detail} onClose={() => setDetail(false)} title="Results in detail" subtitle="Every measure for this batch, where cases wait, and each kind of decision." size="xl">
            <Detail s={s} />
          </Dialog>
        </>
      )}
    </div>
  );
}

/** The batch in one paragraph. */
function summary(s: Stats): string {
  const parts: string[] = [];
  parts.push(`${s.cases} pretend client${s.cases === 1 ? "" : "s"}${s.active ? `, ${s.active} still in progress` : ""}.`);
  if (s.pathAccuracy) {
    const { right, of } = s.pathAccuracy;
    if (of === 1) parts.push(`${s.cases === 1 ? "It" : "The one that finished"} ${right ? "ended the way it should" : "didn't end the way it should"}.`);
    else parts.push(`${right === of ? "All" : right} of the ${of} finished cases ended the way they should.`);
  }
  if (s.escalation.aiDecisions) {
    parts.push(
      s.escalation.escalated
        ? `The AI wasn't sure ${s.escalation.escalated} time${s.escalation.escalated === 1 ? "" : "s"} and handed the question to a person.`
        : "The AI was sure enough every time.",
    );
  }
  if (s.overrides.humanReviews) {
    parts.push(
      s.overrides.overrides
        ? `People went against the AI's advice ${s.overrides.overrides} time${s.overrides.overrides === 1 ? "" : "s"} out of ${s.overrides.humanReviews}.`
        : `People agreed with the AI every time they reviewed its work (${s.overrides.humanReviews} review${s.overrides.humanReviews === 1 ? "" : "s"}).`,
    );
  }
  if (s.cycle.medianDays != null) parts.push(`A typical case took ${Math.round(s.cycle.medianDays)} days, simulated.`);
  return parts.join(" ");
}

function Detail({ s }: { s: Stats }) {
  const tile = (label: string, value: string, sub?: string) => (
    <div className="rounded-lg border border-gray-800 bg-gray-950/50 px-3 py-2">
      <p className="text-[11px] text-gray-500">{label}</p>
      <p className="text-lg font-semibold tabular-nums text-gray-100">{value}</p>
      {sub && <p className="text-[11px] text-gray-500">{sub}</p>}
    </div>
  );
  return (
    <div className="space-y-6">
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-5">
          {tile("Finished", `${s.finished} of ${s.cases}`, `${s.active} still open`)}
          {tile("Within the promised time", s.cycle.slaMet ? `${s.cycle.slaMet.pct}%` : "—", s.cycle.slaMet ? `${s.cycle.slaMet.met} of ${s.cycle.slaMet.of} completed` : "")}
          {tile("Small model → larger AI", s.decisionModel.pct != null ? `${s.decisionModel.pct}%` : "—", `${s.decisionModel.handedToLlm} of ${s.decisionModel.answered} answers below the bar`)}
          {tile("Person overrode the AI", s.overrides.pct != null ? `${s.overrides.pct}%` : "—", `${s.overrides.overrides} of ${s.overrides.humanReviews} reviews`)}
          {tile("Document reading", s.reading ? `${s.reading.pct}%` : "—", s.reading ? `${s.reading.right} of ${s.reading.fields} fields right, ${s.reading.documents} documents` : "")}
        </div>
        <div className="grid gap-4 xl:grid-cols-2">
          <section>
            <h4 className="mb-1 text-sm font-semibold text-gray-100">Where cases wait</h4>
            <p className="mb-3 text-[11px] text-gray-500">Time spent in each step, summed over all cases. 1 simulated day = {s.secondsPerDay} s.</p>
            <div className="space-y-1.5 text-xs">
              {s.waits.map((w) => (
                <div key={w.activityId} className="flex items-center gap-2">
                  <span className="w-48 truncate text-gray-300" title={w.activityId}>
                    {w.name}
                  </span>
                  <span className="h-2 flex-1 rounded bg-gray-800">
                    <span className="block h-2 rounded bg-orange-500/80" style={{ width: `${Math.max(1, w.share ?? 0)}%` }} />
                  </span>
                  <span className="w-28 text-right tabular-nums text-gray-400">
                    {w.share}% · {w.meanDays} d avg
                  </span>
                </div>
              ))}
            </div>
          </section>
          <section>
            <h4 className="mb-3 text-sm font-semibold text-gray-100">Each kind of decision</h4>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-[11px] text-gray-500">
                  <tr>
                    <th className="py-1">Kind</th>
                    <th className="py-1 text-right">n</th>
                    <th className="py-1 text-right">Median time</th>
                    <th className="py-1 text-right">Mean conf.</th>
                    <th className="py-1 text-right">vs truth</th>
                    <th className="py-1 text-right">To person</th>
                    <th className="py-1 text-right">Overridden</th>
                    <th className="py-1 text-right">Cloud</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {Object.entries(s.byKind).map(([k, v]) => (
                    <tr key={k}>
                      <td className="py-1.5">
                        <KindBadge kind={k} />
                      </td>
                      <td className="py-1.5 text-right tabular-nums">{v.count}</td>
                      <td className="py-1.5 text-right tabular-nums">{fmtMs(v.medianLatencyMs)}</td>
                      <td className="py-1.5 text-right tabular-nums">{v.meanConfidence ?? "—"}</td>
                      <td className="py-1.5 text-right tabular-nums">{v.accuracy != null ? `${v.accuracy}% (${v.scored})` : "—"}</td>
                      <td className="py-1.5 text-right tabular-nums">{v.escalated || "—"}</td>
                      <td className="py-1.5 text-right tabular-nums">{v.overridden || "—"}</td>
                      <td className="py-1.5 text-right tabular-nums">{v.cloud ? `${v.cloud} · $${v.costUsd.toFixed(3)}` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-[11px] text-gray-500">
              Endings: {Object.entries(s.outcomes).map(([k, v]) => `${k} ${v}`).join(" · ") || "none yet"}
            </p>
          </section>
        </div>
    </div>
  );
}
