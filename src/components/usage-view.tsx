"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";

import RouterUsageView from "@/components/router-usage-view";

type Bucket = {
  period: string;
  label: string;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  totalTokens: number;
  cost: number;
  messages: number;
};

type Snapshot = {
  generatedAt: string;
  granularities: Record<string, Bucket[]>;
  models: Array<{ model: string; totalTokens: number; cost: number; messages: number }>;
  projects: Array<{ project: string; totalTokens: number; cost: number; messages: number; sessions: number }>;
  sessions: Array<{ session: string; project: string; last: number; totalTokens: number; cost: number; messages: number }>;
  totals: { cost: number; totalTokens: number; messages: number };
  span: { earliest: string | null; latest: string | null; activeDays: number; files: number };
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
type Metric = "cost" | "tokens";

const usd = (n: number) =>
  "$" + (Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usd0 = (n: number) => "$" + Math.round(Number(n) || 0).toLocaleString("en-US");
const tok = (n: number) => {
  const v = Number(n) || 0;
  if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return String(Math.round(v));
};
const num = (n: number) => (Number(n) || 0).toLocaleString("en-US");
const shortModel = (m: string) => m.replace(/^claude-/, "").replace(/-\d{8}$/, "");
const shortDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString([], { month: "short", day: "numeric", year: "2-digit" }) : "—";

// Two different things get measured here: what Claude Code cost you (parsed from
// transcripts) and what your own AI Router served (recorded per call). They share
// almost no columns — cache tokens vs latency and local/cloud split — so they get
// a source switch rather than one merged table that fits neither.
type Source = "overview" | "router" | "claude" | "openai";

export default function UsageView() {
  // The router is the operational source of truth for BeTenshi, so land here
  // by default. Overview and provider-specific views remain one click away.
  const [source, setSource] = useState<Source>("router");

  return (
    <div className="space-y-4">
      <div className="inline-flex overflow-hidden rounded-lg border border-gray-800">
        {(
          [
            { id: "overview" as const, label: "Overall AI" },
            { id: "router" as const, label: "AI Router" },
            { id: "claude" as const, label: "Claude Code" },
            { id: "openai" as const, label: "ChatGPT / Codex" },
          ]
        ).map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setSource(s.id)}
            className={`px-3.5 py-1.5 text-xs transition ${
              source === s.id ? "bg-orange-500/15 text-orange-200" : "text-gray-500 hover:text-gray-200"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>
      {source === "overview" ? <OverallAI onFocus={setSource} /> : source === "claude" ? <ClaudeUsage /> : source === "openai" ? <OpenAICodexUsage /> : <RouterUsageView />}
    </div>
  );
}

function OverallAI({ onFocus }: { onFocus: (source: Source) => void }) {
  const [router, setRouter] = useState<{ totals?: { cost?: number; calls?: number; tokensIn?: number; tokensOut?: number } } | null>(null);
  const [claude, setClaude] = useState<Snapshot | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const [routerRes, claudeRes] = await Promise.all([fetch("/api/router-usage"), fetch("/api/claude-usage")]);
      const [routerJson, claudeJson] = await Promise.all([routerRes.json(), claudeRes.json()]);
      if (!cancelled) { setRouter(routerJson); setClaude(claudeJson); }
    };
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  const routerCost = Number(router?.totals?.cost) || 0;
  const claudeCost = Number(claude?.totals.cost) || 0;
  const routerTokens = (Number(router?.totals?.tokensIn) || 0) + (Number(router?.totals?.tokensOut) || 0);
  return (
    <div className="space-y-4">
      <div><h2 className="text-sm font-semibold text-gray-100">Overall AI usage</h2><p className="text-[11px] text-gray-600">A provider-aware view of measured local activity and API-rate-equivalent cost.</p></div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Measured cost" value={usd0(routerCost + claudeCost)} note="Router + Claude Code" />
        <Kpi label="Measured tokens" value={tok(routerTokens + (claude?.totals.totalTokens || 0))} note="Router + Claude Code" />
        <Kpi label="Router calls" value={num(Number(router?.totals?.calls) || 0)} note="local + cloud" />
        <Kpi label="Providers" value="3" note="Router · Claude · OpenAI" />
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <FocusCard title="AI Router" value={usd(routerCost)} detail={`${num(Number(router?.totals?.calls) || 0)} calls · ${tok(routerTokens)} tokens`} onClick={() => onFocus("router")} />
        <FocusCard title="Claude Code" value={usd(claudeCost)} detail={`${num(claude?.totals.messages || 0)} messages · ${tok(claude?.totals.totalTokens || 0)} tokens`} onClick={() => onFocus("claude")} />
        <FocusCard title="ChatGPT / Codex" value="Unavailable" detail="Local session logs do not expose billable usage" onClick={() => onFocus("openai")} />
      </div>
    </div>
  );
}

function FocusCard({ title, value, detail, onClick }: { title: string; value: string; detail: string; onClick: () => void }) {
  return <button type="button" onClick={onClick} className="rounded-xl border border-gray-800 bg-gray-950 p-4 text-left transition hover:border-orange-500/50"><div className="text-xs text-gray-500">{title}</div><div className="mt-2 text-xl font-semibold text-gray-100">{value}</div><div className="mt-1 text-[11px] text-gray-600">{detail}</div><div className="mt-3 text-[11px] text-orange-300">Focus view →</div></button>;
}

function OpenAICodexUsage() {
  return <div className="rounded-xl border border-gray-800 bg-gray-950 p-5"><h2 className="text-sm font-semibold text-gray-100">ChatGPT / Codex usage</h2><p className="mt-2 max-w-2xl text-sm leading-6 text-gray-400">BeTenshi cannot currently read billable ChatGPT or Codex cost from this machine. Local Codex session databases and rollout logs contain activity history, but not authoritative input/output tokens or billing amounts. This view intentionally shows unavailable instead of estimating.</p><p className="mt-4 text-xs text-gray-600">To add real tracking, connect an OpenAI usage export or record API responses with usage metadata at the point of use.</p></div>;
}

function ClaudeUsage() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [gran, setGran] = useState<GranId>("day");
  const [metric, setMetric] = useState<Metric>("cost");

  const load = useCallback(async (force = false) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/claude-usage${force ? "?refresh=1" : ""}`);
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
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const buckets = useMemo(() => data?.granularities?.[gran] ?? [], [data, gran]);
  const peak = useMemo(
    () => buckets.reduce((max, b) => Math.max(max, metric === "cost" ? b.cost : b.totalTokens), 0),
    [buckets, metric],
  );

  if (error && !data) {
    return (
      <div className="rounded-xl border border-red-900/60 bg-red-950/30 p-4 text-sm text-red-300">
        Could not read Claude Code usage: {error}
      </div>
    );
  }
  if (!data) {
    return <div className="rounded-xl border border-gray-800 bg-gray-950 p-6 text-sm text-gray-500">Reading transcripts…</div>;
  }

  const rows = [...buckets].reverse();
  const totalCost = buckets.reduce((s, b) => s + b.cost, 0);
  const totalTokens = buckets.reduce((s, b) => s + b.totalTokens, 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-gray-100">Claude Code usage</h2>
          <p className="text-[11px] text-gray-600">
            {shortDate(data.span.earliest)} → {shortDate(data.span.latest)} · {data.span.activeDays} active days ·{" "}
            {num(data.totals.messages)} messages · {num(data.span.files)} transcripts
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load(true)}
          disabled={loading}
          className="flex h-9 items-center gap-2 rounded-lg border border-gray-800 px-3 text-xs text-gray-400 transition hover:border-gray-600 hover:text-gray-100 disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="All-time cost" value={usd0(data.totals.cost)} note="API-rate equivalent" />
        <Kpi label="All-time tokens" value={tok(data.totals.totalTokens)} note="including cache" />
        <Kpi label="Models" value={String(data.models.length)} note={data.models[0] ? shortModel(data.models[0].model) : ""} />
        <Kpi label="Projects" value={String(data.projects.length)} note={data.projects[0]?.project ?? ""} />
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
            {(["cost", "tokens"] as Metric[]).map((m) => (
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

        {/* Hand-rolled bars — the console has no charting dependency.
            Columns must be full height (not `items-end`), or the bars' % heights
            have no definite parent to resolve against and collapse to zero. */}
        <div className="flex h-40 items-stretch gap-[3px] overflow-x-auto">
          {buckets.map((b) => {
            const v = metric === "cost" ? b.cost : b.totalTokens;
            const pct = peak > 0 ? (v / peak) * 100 : 0;
            return (
              <div
                key={b.period}
                title={`${b.label} · ${usd(b.cost)} · ${tok(b.totalTokens)} tokens · ${num(b.messages)} msgs`}
                className="group flex h-full min-w-[6px] flex-1 flex-col justify-end"
              >
                <div
                  style={{ height: `${Math.max(pct, v > 0 ? 1.5 : 0)}%` }}
                  className="rounded-sm bg-orange-500/60 transition group-hover:bg-orange-400"
                />
              </div>
            );
          })}
          {buckets.length === 0 && <p className="text-xs text-gray-600">No usage in this range.</p>}
        </div>
        <p className="mt-2 text-[11px] text-gray-600">
          {buckets.length} {gran === "hour" ? "hours" : `${gran}s`} · total {usd(totalCost)} / {tok(totalTokens)} tokens
        </p>
      </div>

      <div className="rounded-xl border border-gray-800 bg-gray-950">
        <div className="max-h-[360px] overflow-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-gray-950">
              <tr className="text-[10px] uppercase tracking-wide text-gray-600">
                <th className="px-3 py-2 text-left font-medium">Period</th>
                <th className="px-3 py-2 text-right font-medium">Msgs</th>
                <th className="px-3 py-2 text-right font-medium">Input</th>
                <th className="px-3 py-2 text-right font-medium">Output</th>
                <th className="px-3 py-2 text-right font-medium">Cache write</th>
                <th className="px-3 py-2 text-right font-medium">Cache read</th>
                <th className="px-3 py-2 text-right font-medium">Total</th>
                <th className="px-3 py-2 text-right font-medium">Cost</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.period} className="border-t border-gray-900 tabular-nums hover:bg-gray-900/50">
                  <td className="px-3 py-1.5 text-gray-300">{b.label}</td>
                  <td className="px-3 py-1.5 text-right text-gray-500">{num(b.messages)}</td>
                  <td className="px-3 py-1.5 text-right text-gray-500">{tok(b.input)}</td>
                  <td className="px-3 py-1.5 text-right text-gray-500">{tok(b.output)}</td>
                  <td className="px-3 py-1.5 text-right text-gray-500">{tok(b.cacheWrite)}</td>
                  <td className="px-3 py-1.5 text-right text-gray-500">{tok(b.cacheRead)}</td>
                  <td className="px-3 py-1.5 text-right text-gray-300">{tok(b.totalTokens)}</td>
                  <td className="px-3 py-1.5 text-right text-orange-200">{usd(b.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="By model">
          {data.models.map((m) => (
            <Row
              key={m.model}
              left={shortModel(m.model)}
              mid={`${tok(m.totalTokens)} · ${num(m.messages)} msgs`}
              right={usd(m.cost)}
              share={data.totals.cost ? m.cost / data.totals.cost : 0}
            />
          ))}
        </Panel>
        <Panel title="By project">
          {data.projects.slice(0, 12).map((p) => (
            <Row
              key={p.project}
              left={p.project}
              mid={`${tok(p.totalTokens)} · ${p.sessions} sessions`}
              right={usd(p.cost)}
              share={data.totals.cost ? p.cost / data.totals.cost : 0}
            />
          ))}
        </Panel>
      </div>

      <p className="text-[11px] leading-relaxed text-gray-600">
        <span className="text-amber-500">Costs are API-rate equivalents</span> — what this usage would cost on
        pay-as-you-go. On a subscription you pay a flat fee, so read token volumes and trends as the real signal. Parsed
        read-only from <code className="text-gray-500">~/.claude</code>, including subagent transcripts. Codex usage
        (<code className="text-gray-500">~/.codex</code>) is not included.
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

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-950 p-3">
      <p className="mb-2 text-xs font-semibold text-gray-300">{title}</p>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function Row({ left, mid, right, share }: { left: string; mid: string; right: string; share: number }) {
  return (
    <div className="flex items-center gap-3 text-xs">
      <div className="w-40 shrink-0 truncate text-gray-300">{left}</div>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-900">
        <div className="h-full rounded-full bg-orange-500/70" style={{ width: `${Math.max(share * 100, 1)}%` }} />
      </div>
      <div className="w-40 shrink-0 text-right text-[11px] text-gray-600">{mid}</div>
      <div className="w-20 shrink-0 text-right tabular-nums text-orange-200">{right}</div>
    </div>
  );
}
