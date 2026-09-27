"use client";

import { useEffect, useState } from "react";
import { fmtMs, lab, type Overview, type Stats } from "./api";
import { KindBadge } from "./case-view";

/** Start a simulation (or one real case), and see the runs so far. */
export function SimulateView({ overview, onStarted }: { overview: Overview; onStarted: (runId: string) => void }) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set(overview.scenarios.map((s) => s.id)));
  const [spd, setSpd] = useState(2);
  const [autoHuman, setAutoHuman] = useState(true);
  const [voice, setVoice] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const start = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await lab<{ id: string }>("api/sim", {
        method: "POST",
        body: JSON.stringify({ scenarios: [...picked], secondsPerDay: spd, autoHuman, voiceUpdate: voice }),
      });
      onStarted(r.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
      <section className="rounded-xl border border-gray-800 bg-gray-900 p-4">
        <h3 className="text-sm font-semibold text-gray-100">Synthetic clients</h3>
        <p className="mb-3 text-xs text-gray-500">
          Each is a hand-written case with a known right answer, so every AI decision is scored against the truth. Their documents are rendered
          locally (watermarked SPECIMEN), in English, Arabic, Spanish and German.
        </p>
        <div className="mb-2 flex gap-3 text-[11px]">
          <button className="text-gray-400 underline" onClick={() => setPicked(new Set(overview.scenarios.map((s) => s.id)))}>all</button>
          <button className="text-gray-400 underline" onClick={() => setPicked(new Set())}>none</button>
        </div>
        <div className="grid gap-1 sm:grid-cols-2">
          {overview.scenarios.map((s) => (
            <label key={s.id} className="flex items-start gap-2 rounded px-1 py-0.5 text-xs text-gray-300 hover:bg-gray-800/50">
              <input
                type="checkbox"
                className="mt-0.5 accent-orange-500"
                checked={picked.has(s.id)}
                onChange={(e) => {
                  const n = new Set(picked);
                  if (e.target.checked) n.add(s.id);
                  else n.delete(s.id);
                  setPicked(n);
                }}
              />
              <span>
                {s.label}
                <span className="block font-mono text-[10px] text-gray-600">{s.id}</span>
              </span>
            </label>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-4 text-xs text-gray-400">
          <label className="flex items-center gap-2">
            1 day =
            <input type="number" min={1} max={120} value={spd} onChange={(e) => setSpd(Number(e.target.value))} className="w-16 rounded border border-gray-700 bg-gray-950 px-2 py-1 text-gray-200" />
            s
          </label>
          <label className="flex items-center gap-2" title="A simulated consultant who knows the ground truth works the inbox. Off: the tasks wait for you in Inbox.">
            <input type="checkbox" className="accent-orange-500" checked={autoHuman} onChange={(e) => setAutoHuman(e.target.checked)} />
            simulated consultant
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" className="accent-orange-500" checked={voice} onChange={(e) => setVoice(e.target.checked)} />
            spoken update
          </label>
          <button
            disabled={busy || !picked.size || !overview.engine.up}
            onClick={start}
            className="rounded-md border border-orange-600 bg-orange-600/20 px-3 py-1.5 font-medium text-orange-200 disabled:opacity-50"
          >
            {busy ? "Rendering documents…" : `Run ${picked.size} case${picked.size === 1 ? "" : "s"}`}
          </button>
        </div>
        <p className="mt-2 text-[11px] text-gray-600">
          AI steps go to {overview.ai.models.local} first; when the GPU is taken they {overview.ai.whenLocalUnavailable === "cloud" ? `fall back to ${overview.ai.models.cloud} (recorded, with cost)` : "wait for it"}.
        </p>
        {err && <p className="mt-2 text-xs text-red-300">{err}</p>}
      </section>
      <div className="space-y-4">
      <ManualCase onStarted={onStarted} />
      <section className="rounded-xl border border-gray-800 bg-gray-900 p-4">
        <h3 className="mb-2 text-sm font-semibold text-gray-100">Runs</h3>
        <ul className="space-y-1.5 text-xs">
          {overview.runs.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-2">
              <span className="font-mono text-gray-300">{r.id}</span>
              <span className="text-gray-500">
                {r.config?.scenarios?.length ?? "?"} cases · {r.config?.secondsPerDay}s/day ·{" "}
                <span className={r.active ? "text-orange-300" : r.status === "finished" ? "text-emerald-300" : "text-gray-400"}>{r.active ? "running" : r.status}</span>
              </span>
            </li>
          ))}
          {!overview.runs.length && <li className="text-gray-600">None yet.</li>}
        </ul>
      </section>
      </div>
    </div>
  );
}

/** One real case, by hand: you are the client (upload documents on the case) and the consultant (Inbox). */
function ManualCase({ onStarted }: { onStarted: (runId: string) => void }) {
  const [f, setF] = useState({ clientName: "", clientLanguage: "en", passportCountry: "LB", destination: "PT", requestText: "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const input = "w-full rounded border border-gray-700 bg-gray-950 px-2 py-1 text-gray-200";
  return (
    <section className="rounded-xl border border-gray-800 bg-gray-900 p-4 text-xs">
      <h3 className="text-sm font-semibold text-gray-100">One case, by hand</h3>
      <p className="mb-2 text-gray-500">You play the client — upload documents on the case when it asks — and the consultant, in Inbox. 1 day = 60 s.</p>
      <div className="grid grid-cols-2 gap-2">
        <input value={f.clientName} onChange={set("clientName")} placeholder="Client name" className={input} />
        <select value={f.clientLanguage} onChange={set("clientLanguage")} className={input}>
          {["en", "ar", "es", "pt", "de", "fr"].map((l) => <option key={l}>{l}</option>)}
        </select>
        <input value={f.passportCountry} onChange={set("passportCountry")} placeholder="Passport (ISO 2)" maxLength={2} className={input} />
        <select value={f.destination} onChange={set("destination")} className={input}>
          {["PT", "ES", "DE", "AE", "GB", "CA"].map((d) => <option key={d}>{d}</option>)}
        </select>
      </div>
      <textarea value={f.requestText} onChange={set("requestText")} rows={3} placeholder="What the client asks for, in their words" className={`${input} mt-2`} />
      <button
        disabled={busy || !f.requestText.trim() || f.passportCountry.length !== 2}
        onClick={async () => {
          setBusy(true);
          setMsg(null);
          try {
            const r = await lab<{ caseKey: string }>("api/cases", { method: "POST", body: JSON.stringify({ ...f, passportCountry: f.passportCountry.toUpperCase(), secondsPerDay: 60 }) });
            setMsg(`Started ${r.caseKey}.`);
            onStarted("");
          } catch (e) {
            setMsg(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        }}
        className="mt-2 rounded-md border border-orange-600 bg-orange-600/20 px-3 py-1.5 font-medium text-orange-200 disabled:opacity-50"
      >
        Start case
      </button>
      {msg && <p className="mt-2 text-gray-400">{msg}</p>}
    </section>
  );
}

/** Aggregate numbers for one run, or for every case. */
export function NumbersView({ runs, run, onRun }: { runs: { id: string }[]; run: string; onRun: (r: string) => void }) {
  const [s, setS] = useState<Stats | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
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
  }, [run]);

  const tile = (label: string, value: string, sub?: string) => (
    <div className="rounded-lg border border-gray-800 bg-gray-950/50 px-3 py-2">
      <p className="text-[11px] text-gray-500">{label}</p>
      <p className="text-lg font-semibold tabular-nums text-gray-100">{value}</p>
      {sub && <p className="text-[11px] text-gray-500">{sub}</p>}
    </div>
  );

  return (
    <div className="space-y-4">
      <label className="flex items-center gap-2 text-xs text-gray-400">
        Run
        <select value={run} onChange={(e) => onRun(e.target.value)} className="rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-gray-200">
          <option value="">all cases</option>
          {runs.map((r) => <option key={r.id}>{r.id}</option>)}
        </select>
      </label>
      {err && <p className="text-xs text-red-300">{err}</p>}
      {!s ? (
        <p className="text-xs text-gray-500">Loading…</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-9">
            {tile("Cases", `${s.finished}/${s.cases}`, `${s.active} still open`)}
            {tile("Right ending", s.pathAccuracy ? `${s.pathAccuracy.pct}%` : "—", s.pathAccuracy ? `${s.pathAccuracy.right} of ${s.pathAccuracy.of} vs truth` : "no ground truth")}
            {tile("Cycle time", s.cycle.medianDays != null ? `${s.cycle.medianDays} d` : "—", `median · mean ${s.cycle.meanDays ?? "—"} · max ${s.cycle.maxDays ?? "—"}`)}
            {tile("Within SLA", s.cycle.slaMet ? `${s.cycle.slaMet.pct}%` : "—", s.cycle.slaMet ? `${s.cycle.slaMet.met} of ${s.cycle.slaMet.of} completed` : "")}
            {tile("Decision model → LLM", s.decisionModel.pct != null ? `${s.decisionModel.pct}%` : "—", `${s.decisionModel.handedToLlm} of ${s.decisionModel.answered} answers below threshold`)}
            {tile("AI → person", s.escalation.pct != null ? `${s.escalation.pct}%` : "—", `${s.escalation.escalated} of ${s.escalation.aiDecisions} AI judgements`)}
            {tile("Person overrode AI", s.overrides.pct != null ? `${s.overrides.pct}%` : "—", `${s.overrides.overrides} of ${s.overrides.humanReviews} reviews`)}
            {tile("Reading accuracy", s.reading ? `${s.reading.pct}%` : "—", s.reading ? `${s.reading.right}/${s.reading.fields} fields, ${s.reading.documents} docs` : "")}
            {tile("Cloud", `$${s.models.costUsd.toFixed(3)}`, `${s.models.cloudFallbacks} fallbacks of ${s.models.calls} AI calls`)}
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <section className="rounded-xl border border-gray-800 bg-gray-900 p-4">
              <h3 className="mb-1 text-sm font-semibold text-gray-100">Where cases wait</h3>
              <p className="mb-3 text-[11px] text-gray-500">Time spent in each step, summed over all cases. 1 simulated day = {s.secondsPerDay} s.</p>
              <div className="space-y-1.5 text-xs">
                {s.waits.map((w) => (
                  <div key={w.activityId} className="flex items-center gap-2">
                    <span className="w-48 truncate text-gray-300" title={w.activityId}>{w.name}</span>
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
            <section className="rounded-xl border border-gray-800 bg-gray-900 p-4">
              <h3 className="mb-3 text-sm font-semibold text-gray-100">Decisions by kind</h3>
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
              <p className="mt-2 text-[11px] text-gray-500">
                Outcomes: {Object.entries(s.outcomes).map(([k, v]) => `${k} ${v}`).join(" · ") || "none yet"}
              </p>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
