"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";

type Bucket = {
  period: string;
  label: string;
  calls: number;
  localCalls: number;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  localCost: number;
  avgMs: number | null;
  errors: number;
};

type Snapshot = {
  generatedAt: string;
  granularities: Record<string, Bucket[]>;
  models: Array<{
    model: string;
    isLocal: boolean;
    calls: number;
    tokensIn: number;
    tokensOut: number;
    cost: number;
    avgMs: number | null;
    errors: number;
  }>;
  callers: Array<{ caller: string; calls: number; cost: number; tokensOut: number }>;
  totals: {
    calls: number;
    localCalls: number;
    tokensIn: number;
    tokensOut: number;
    cost: number;
    localTokensOut: number;
    errors: number;
  };
  span: { earliest: number | null; latest: number | null };
};

const GRANS = [
  { id: "hour", label: "Hourly" },
  { id: "day", label: "Daily" },
  { id: "week", label: "Weekly" },
  { id: "month", label: "Monthly" },
  { id: "quarter", label: "Quarterly" },
  { id: "year", label: "Yearly" },
] as const;
type GranId = (typeof GRANS)[number]["id"];
type Metric = "calls" | "tokens" | "cost";

const usd = (v: number) =>
  "$" + (Number(v) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const tok = (v: number) => {
  const n = Number(v) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(Math.round(n));
};
const num = (v: number) => (Number(v) || 0).toLocaleString("en-US");
const ms = (v: number | null) => (v == null ? "—" : v >= 1000 ? (v / 1000).toFixed(1) + "s" : v + "ms");

export default function RouterUsageView() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [gran, setGran] = useState<GranId>("day");
  const [metric, setMetric] = useState<Metric>("calls");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/router-usage");
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      setData(json);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 20_000);
    return () => clearInterval(timer);
  }, [load]);

  const buckets = useMemo(() => data?.granularities?.[gran] ?? [], [data, gran]);
  const valueOf = useCallback(
    (b: Bucket) => (metric === "calls" ? b.calls : metric === "tokens" ? b.tokensIn + b.tokensOut : b.cost),
    [metric],
  );
  const peak = useMemo(() => buckets.reduce((m, b) => Math.max(m, valueOf(b)), 0), [buckets, valueOf]);

  if (error && !data) {
    return (
      <div className="rounded-xl border border-red-900/60 bg-red-950/30 p-4 text-sm text-red-300">
        Could not read router usage: {error}
      </div>
    );
  }
  if (!data) {
    return <div className="rounded-xl border border-gray-800 bg-gray-950 p-6 text-sm text-gray-500">Loading…</div>;
  }

  const localShare = data.totals.calls ? (data.totals.localCalls / data.totals.calls) * 100 : 0;

  // Nothing recorded yet is the expected first state — say so plainly rather
  // than rendering an empty chart that reads as broken.
  if (data.totals.calls === 0) {
    return (
      <div className="space-y-3">
        <div className="rounded-xl border border-gray-800 bg-gray-950 p-6">
          <p className="text-sm font-medium text-gray-200">No router calls recorded yet</p>
          <p className="mt-2 max-w-2xl text-xs leading-relaxed text-gray-500">
            Recording starts now — every call the AI Router serves from here on is written to{" "}
            <code className="text-gray-400">router_calls</code> and will appear in this view. Calls made before this
            was wired up were only ever held in a 2,000-event in-memory ring, so they are not recoverable.
          </p>
          <p className="mt-2 max-w-2xl text-xs leading-relaxed text-gray-500">
            If you expect traffic and see none: the router logs through{" "}
            <code className="text-gray-400">config/router_callback.py</code>, and local text models need{" "}
            <span className="text-gray-400">vllm</span> running to serve anything.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="flex h-9 items-center gap-2 rounded-lg border border-gray-800 px-3 text-xs text-gray-400 transition hover:border-gray-600 hover:text-gray-100 disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          Check again
        </button>
      </div>
    );
  }

  const rows = [...buckets].reverse();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[11px] text-gray-600">
          {num(data.totals.calls)} calls recorded · {data.models.length} models ·{" "}
          {data.span.earliest ? new Date(data.span.earliest).toLocaleDateString() : "—"} → now
        </p>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="flex h-9 items-center gap-2 rounded-lg border border-gray-800 px-3 text-xs text-gray-400 transition hover:border-gray-600 hover:text-gray-100 disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Kpi label="Calls" value={num(data.totals.calls)} note={`${num(data.totals.errors)} errors`} />
        <Kpi label="On local models" value={`${localShare.toFixed(0)}%`} note={`${num(data.totals.localCalls)} calls`} />
        <Kpi label="Local tokens out" value={tok(data.totals.localTokensOut)} note="generated on this box" />
        <Kpi label="Tokens total" value={tok(data.totals.tokensIn + data.totals.tokensOut)} note="in + out" />
        <Kpi label="Cloud spend" value={usd(data.totals.cost)} note="local calls are $0" />
      </div>

      <div className="rounded-xl border border-gray-800 bg-gray-950 p-3">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="inline-flex overflow-hidden rounded-lg border border-gray-800">
            {GRANS.map((g) => (
              <button
                key={g.id}
                type="button"
                onClick={() => setGran(g.id)}
                className={`px-3 py-1.5 text-xs transition ${
                  gran === g.id ? "bg-orange-500/15 text-orange-200" : "text-gray-500 hover:text-gray-200"
                }`}
              >
                {g.label}
              </button>
            ))}
          </div>
          <div className="inline-flex overflow-hidden rounded-lg border border-gray-800">
            {(["calls", "tokens", "cost"] as Metric[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMetric(m)}
                className={`px-3 py-1.5 text-xs capitalize transition ${
                  metric === m ? "bg-orange-500/15 text-orange-200" : "text-gray-500 hover:text-gray-200"
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        {/* Columns must be full height, or the bars' % heights resolve to zero. */}
        <div className="flex h-40 items-stretch gap-[3px] overflow-x-auto">
          {buckets.map((b) => {
            const v = valueOf(b);
            const pct = peak > 0 ? (v / peak) * 100 : 0;
            const localPct = metric === "calls" && b.calls > 0 ? (b.localCalls / b.calls) * 100 : 0;
            return (
              <div
                key={b.period}
                title={`${b.label} · ${num(b.calls)} calls (${num(b.localCalls)} local) · ${tok(
                  b.tokensIn + b.tokensOut,
                )} tokens · ${usd(b.cost)} · avg ${ms(b.avgMs)}`}
                className="group flex h-full min-w-[6px] flex-1 flex-col justify-end"
              >
                <div
                  style={{ height: `${Math.max(pct, v > 0 ? 1.5 : 0)}%` }}
                  className="flex flex-col justify-end overflow-hidden rounded-sm bg-orange-500/50 transition group-hover:bg-orange-400/70"
                >
                  {/* Local share fills from the bottom, so the split is readable at a glance. */}
                  {localPct > 0 && <div style={{ height: `${localPct}%` }} className="w-full bg-emerald-500/70" />}
                </div>
              </div>
            );
          })}
        </div>
        <p className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-gray-600">
          <span>
            {buckets.length} {gran === "hour" ? "hours" : `${gran}s`}
          </span>
          {metric === "calls" && (
            <>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-sm bg-emerald-500/70" /> local
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-sm bg-orange-500/50" /> cloud
              </span>
            </>
          )}
        </p>
      </div>

      <div className="rounded-xl border border-gray-800 bg-gray-950">
        <div className="max-h-[320px] overflow-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-gray-950">
              <tr className="text-[10px] uppercase tracking-wide text-gray-600">
                <th className="px-3 py-2 text-left font-medium">Period</th>
                <th className="px-3 py-2 text-right font-medium">Calls</th>
                <th className="px-3 py-2 text-right font-medium">Local</th>
                <th className="px-3 py-2 text-right font-medium">Tokens in</th>
                <th className="px-3 py-2 text-right font-medium">Tokens out</th>
                <th className="px-3 py-2 text-right font-medium">Avg latency</th>
                <th className="px-3 py-2 text-right font-medium">Errors</th>
                <th className="px-3 py-2 text-right font-medium">Cost</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.period} className="border-t border-gray-900 tabular-nums hover:bg-gray-900/50">
                  <td className="px-3 py-1.5 text-gray-300">{b.label}</td>
                  <td className="px-3 py-1.5 text-right text-gray-500">{num(b.calls)}</td>
                  <td className="px-3 py-1.5 text-right text-emerald-300/80">{num(b.localCalls)}</td>
                  <td className="px-3 py-1.5 text-right text-gray-500">{tok(b.tokensIn)}</td>
                  <td className="px-3 py-1.5 text-right text-gray-500">{tok(b.tokensOut)}</td>
                  <td className="px-3 py-1.5 text-right text-gray-500">{ms(b.avgMs)}</td>
                  <td className={`px-3 py-1.5 text-right ${b.errors ? "text-red-400" : "text-gray-600"}`}>
                    {num(b.errors)}
                  </td>
                  <td className="px-3 py-1.5 text-right text-orange-200">{usd(b.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-gray-800 bg-gray-950 p-3">
          <p className="mb-2 text-xs font-semibold text-gray-300">By model</p>
          <div className="space-y-1.5">
            {data.models.map((m) => (
              <div key={m.model} className="flex items-center gap-2 text-xs">
                <span
                  className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] uppercase ${
                    m.isLocal ? "bg-emerald-500/15 text-emerald-300" : "bg-gray-800 text-gray-500"
                  }`}
                >
                  {m.isLocal ? "local" : "cloud"}
                </span>
                <span className="w-36 shrink-0 truncate text-gray-300">{m.model}</span>
                <span className="flex-1 text-right text-[11px] text-gray-600">
                  {num(m.calls)} calls · {tok(m.tokensOut)} out · avg {ms(m.avgMs)}
                </span>
                <span className="w-16 shrink-0 text-right tabular-nums text-orange-200">{usd(m.cost)}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-xl border border-gray-800 bg-gray-950 p-3">
          <p className="mb-2 text-xs font-semibold text-gray-300">By caller</p>
          <div className="space-y-1.5">
            {data.callers.map((c) => (
              <div key={c.caller} className="flex items-center gap-2 text-xs">
                <span className="w-44 shrink-0 truncate text-gray-300">{c.caller}</span>
                <span className="flex-1 text-right text-[11px] text-gray-600">
                  {num(c.calls)} calls · {tok(c.tokensOut)} out
                </span>
                <span className="w-16 shrink-0 text-right tabular-nums text-orange-200">{usd(c.cost)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <p className="text-[11px] leading-relaxed text-gray-600">
        Recorded by <code className="text-gray-500">config/router_callback.py</code> on every AI Router call and stored
        in duckdb. <span className="text-emerald-400">Local</span> models (the{" "}
        <code className="text-gray-500">local-*</code> aliases served off this box) cost $0 — the spend column is cloud
        only.
      </p>
    </div>
  );
}

function Kpi({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-950 p-3">
      <div className="text-[10px] uppercase tracking-wide text-gray-600">{label}</div>
      <div className="mt-1 text-xl font-semibold text-gray-100">{value}</div>
      {note ? <div className="text-[10px] text-gray-600">{note}</div> : null}
    </div>
  );
}
