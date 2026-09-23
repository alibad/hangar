"use client";

import { useState, useEffect, useCallback, useId, useMemo, useRef } from "react";
import { SERVICE_REGISTRY } from "@/lib/services";
import { getHost } from "@/lib/host";
import { Search, X } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Pulse } from "@phosphor-icons/react";
import { ToolPageHeader } from "./tool-page";
import { useLiveRefresh } from "@/lib/use-live-refresh";

type Ev = {
  ts: number | null;
  service: string;
  method: string;
  path: string;
  status: number | null;
  ms: number | null;
  ip: string | null;
  source: "live" | "log";
  model?: string | null;
  costUsd?: number | null;
  caller?: string | null;
  prompt?: string | null;
  /** The reply text, captured by the producer at log time — see TrafficEvent. */
  response?: string | null;
  /** Lengths before the producer's text cap, so the panel can say what it lost. */
  promptChars?: number | null;
  responseChars?: number | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  error?: string | null;
  /** The service this call was dispatched TO, when `service` is just the logger. */
  target?: string | null;
  hop?: string | null;
  rid?: string | null;
  pending?: boolean;
  artifact?: { kind: "image"; rel: string } | null;
};

type TimeRange = "15m" | "1h" | "24h" | "all";

const RANGE_MS: Record<TimeRange, number | null> = {
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "24h": 24 * 60 * 60_000,
  all: null,
};

function eventKey(event: Ev): string {
  return event.rid ?? [event.ts ?? 0, event.service, event.method, event.path, event.model ?? ""].join(":");
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const ordered = values.toSorted((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * p) - 1))];
}

function topGroups(events: Ev[], getLabel: (event: Ev) => string, limit = 3) {
  const counts = new Map<string, number>();
  for (const event of events) {
    const label = getLabel(event);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].toSorted((a, b) => b[1] - a[1]).slice(0, limit);
}

// Polling is classified and segregated SERVER-side (see lib/traffic.ts) rather
// than filtered here. A client-side regex still let chatter into the shared ring,
// where a 70-second generation's once-a-second /progress ticks could evict real
// requests before anyone looked at them.

const SERVICE_COLORS: Record<string, string> = {
  console: "bg-pink-500/15 text-pink-300 border-pink-500/30",
  qwen: "bg-indigo-500/15 text-indigo-300 border-indigo-500/30",
  whisper: "bg-blue-500/15 text-blue-300 border-blue-500/30",
  tts: "bg-cyan-500/15 text-cyan-300 border-cyan-500/30",
  vllm: "bg-purple-500/15 text-purple-300 border-purple-500/30",
  comfyui: "bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/30",
};
const svcColor = (s: string) => SERVICE_COLORS[s] || "bg-gray-600/20 text-gray-300 border-gray-600/40";

function methodColor(m: string): string {
  if (m === "GET") return "text-gray-400";
  if (m === "POST") return "text-green-400";
  if (m === "DELETE") return "text-red-400";
  if (m === "PUT" || m === "PATCH") return "text-amber-400";
  return "text-gray-400";
}
function statusColor(s: number | null): string {
  if (s == null) return "text-gray-600";
  if (s >= 500) return "text-red-400";
  if (s >= 400) return "text-amber-400";
  if (s >= 300) return "text-gray-400";
  return "text-green-400";
}
function fmtTime(ts: number | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, { hour12: false });
}
function fmtMs(ms: number | null): string {
  if (ms == null) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}
/** Loopback in its several spellings — all of them mean "this box". */
function loopback(ip: string | null | undefined): boolean {
  return ip === "::1" || ip === "127.0.0.1" || ip === "::ffff:127.0.0.1" || ip === "localhost";
}

/**
 * Live seconds since a request started. Ticks on its own rather than riding the
 * feed's 4s poll, so a running generation visibly counts up instead of sitting
 * on a stale number.
 */
function Elapsed({ since }: { since: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!since) return <>—</>;
  return <span className="text-sky-400">{((now - since) / 1000).toFixed(0)}s</span>;
}

function DiagnosticStat({ label, value, hint, tone = "neutral" }: { label: string; value: string; hint: string; tone?: "neutral" | "good" | "warn" | "bad" }) {
  const valueTone = tone === "bad" ? "text-red-300" : tone === "warn" ? "text-amber-300" : tone === "good" ? "text-emerald-300" : "text-gray-100";
  return (
    <div className="tool-panel rounded-xl border border-gray-800 bg-gray-900 p-3">
      <span className="block text-[9px] font-semibold uppercase tracking-wider text-gray-600">{label}</span>
      <span className={`mt-1 block text-xl font-semibold tabular-nums ${valueTone}`}>{value}</span>
      <span className="mt-0.5 block text-[10px] text-gray-500">{hint}</span>
    </div>
  );
}

function Breakdown({ label, rows }: { label: string; rows: Array<[string, number]> }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <span className="text-[9px] font-semibold uppercase tracking-wider text-gray-600">{label}</span>
      {rows.length ? rows.map(([name, count]) => (
        <span key={name} className={`max-w-48 truncate rounded-full border px-2 py-1 text-[10px] ${name === "unknown" ? "border-amber-500/30 bg-amber-500/10 text-amber-200" : "border-gray-800 bg-gray-900 text-gray-400"}`} title={name}>
          {name} <span className="tabular-nums text-gray-600">×{count}</span>
        </span>
      )) : <span className="text-[10px] text-gray-600">No data</span>}
    </div>
  );
}

/**
 * Shared trigger styling for every dropdown in this view.
 *
 * These were native `<select>` elements. A native select renders with
 * OS-default styling that ignores the console's theme entirely — white popup,
 * black text, system font — so on a dark operator surface three of them lit up
 * like holes in the page, and did it differently on every browser.
 */
const SELECT_TRIGGER = "h-[30px] gap-1.5 rounded-lg border-gray-700 bg-gray-800 px-2 text-xs text-gray-300";
const SELECT_CONTENT = "border-gray-700 bg-gray-800 text-gray-300";

function FilterSelect({ value, onChange, options, label }: { value: string; onChange: (value: string) => void; options: string[]; label: string }) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-gray-500">
      {label}
      <Select value={value} onValueChange={(v) => v && onChange(String(v))}>
        <SelectTrigger className={SELECT_TRIGGER} aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent className={SELECT_CONTENT}>
          <SelectItem value="all" className="text-xs">all</SelectItem>
          {options.map((option) => (
            <SelectItem key={option} value={option} className="text-xs">{option}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}

export default function RequestsView() {
  const [events, setEvents] = useState<Ev[]>([]);
  const [services, setServices] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [live, setLive] = useState(true);

  // filters
  const [service, setService] = useState("all");
  const [method, setMethod] = useState("all");
  const [statusClass, setStatusClass] = useState("all");
  const [timeRange, setTimeRange] = useState<TimeRange>("1h");
  const [query, setQuery] = useState("");
  const [failuresOnly, setFailuresOnly] = useState(false);
  const [pageSize, setPageSize] = useState(50);
  /**
   * Noise is OFF by default and opt-in. The server keeps it in its own ring, so
   * this isn't a cosmetic filter over a polluted feed — leaving it off means
   * chatter genuinely never competes with real requests for buffer space.
   */
  const [showNoise, setShowNoise] = useState(false);
  const [noise, setNoise] = useState<Ev[]>([]);
  const [noiseCount, setNoiseCount] = useState(0);
  /**
   * Same deal for internal hops: one image generation is logged by the router
   * AND by Qwen underneath it, so showing both made eight images look like
   * sixteen requests. The router row survives (it knows the model, caller and
   * cost); the downstream half is opt-in for when you're debugging the plumbing.
   */
  const [showHops, setShowHops] = useState(false);
  const [hops, setHops] = useState<Ev[]>([]);
  const [hopCount, setHopCount] = useState(0);
  const [page, setPage] = useState(0);
  const [detail, setDetail] = useState<Ev | null>(null);
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const [urlReady, setUrlReady] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setService(params.get("rq_service") ?? "all");
    setMethod(params.get("rq_method") ?? "all");
    setStatusClass(params.get("rq_status") ?? "all");
    const range = params.get("rq_range") as TimeRange | null;
    if (range && range in RANGE_MS) setTimeRange(range);
    setFailuresOnly(params.get("rq_failures") === "1");
    setQuery(params.get("rq_query") ?? "");
    setDetailKey(params.get("rq_id"));
    setUrlReady(true);
  }, []);

  useEffect(() => {
    if (!urlReady) return;
    const url = new URL(window.location.href);
    const setOrDelete = (key: string, value: string, fallback: string) => {
      if (value === fallback) url.searchParams.delete(key);
      else url.searchParams.set(key, value);
    };
    setOrDelete("rq_service", service, "all");
    setOrDelete("rq_method", method, "all");
    setOrDelete("rq_status", statusClass, "all");
    setOrDelete("rq_range", timeRange, "1h");
    setOrDelete("rq_failures", failuresOnly ? "1" : "0", "0");
    setOrDelete("rq_query", query.trim(), "");
    setOrDelete("rq_id", detailKey ?? "", "");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, [detailKey, failuresOnly, method, query, service, statusClass, timeRange, urlReady]);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/traffic");
      const data = await res.json();
      setEvents(Array.isArray(data.events) ? data.events : []);
      setNoise(Array.isArray(data.noise) ? data.noise : []);
      setNoiseCount(typeof data.noiseCount === "number" ? data.noiseCount : 0);
      setHops(Array.isArray(data.hops) ? data.hops : []);
      setHopCount(typeof data.hopCount === "number" ? data.hopCount : 0);
      setServices(Array.isArray(data.services) ? data.services : []);
    } catch {
      /* keep prior */
    }
    setLoading(false);
  }, []);

  useLiveRefresh(refresh, { intervalMs: live ? 4000 : null });

  useEffect(() => {
    if (!detailKey || detail) return;
    const found = [...events, ...noise, ...hops].find((event) => eventKey(event) === detailKey);
    if (found) setDetail(found);
  }, [detail, detailKey, events, hops, noise]);

  const filtered = useMemo(() => {
    // Noise and hops are separate streams server-side; merge them in on demand.
    const extra = [...(showNoise ? noise : []), ...(showHops ? hops : [])];
    const base = extra.length
      ? [...events, ...extra].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))
      : events;
    return base.filter((e) => {
      const rangeMs = RANGE_MS[timeRange];
      if (rangeMs != null && e.ts != null && Date.now() - e.ts > rangeMs) return false;
      // Match either end of the call. Filtering to "qwen" and getting only the
      // rows Qwen logged itself would hide every console request aimed AT it —
      // which is most of what you want when you pick a service here.
      if (service !== "all" && e.service !== service && e.target !== service) return false;
      if (method !== "all" && e.method !== method) return false;
      if (statusClass !== "all") {
        const c = e.status == null ? "?" : String(Math.floor(e.status / 100)) + "xx";
        if (c !== statusClass) return false;
      }
      if (failuresOnly && (e.status == null || e.status < 400)) return false;
      if (query.trim()) {
        const needle = query.trim().toLowerCase();
        const haystack = [e.service, e.target, e.method, e.path, e.model, e.caller, e.error]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });
  }, [events, noise, showNoise, hops, showHops, service, method, statusClass, failuresOnly, query, timeRange]);

  // Filters changed → jump back to the first page.
  useEffect(() => { setPage(0); }, [service, method, statusClass, timeRange, showNoise, showHops, failuresOnly, query, pageSize]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const curPage = Math.min(page, pageCount - 1);
  const shown = filtered.slice(curPage * pageSize, (curPage + 1) * pageSize);
  const methods = useMemo(() => [...new Set(events.map((e) => e.method))].sort(), [events]);
  const diagnostics = useMemo(() => {
    const complete = filtered.filter((event) => !event.pending && event.status != null);
    const failures = complete.filter((event) => (event.status ?? 0) >= 400);
    const latencies = complete.flatMap((event) => event.ms == null ? [] : [event.ms]);
    const totalCost = filtered.reduce((sum, event) => sum + Math.max(0, event.costUsd ?? 0), 0);
    const unattributed = filtered.filter((event) => (event.costUsd ?? 0) > 0 && !event.caller);
    return {
      failures: failures.length,
      failureRate: complete.length ? (failures.length / complete.length) * 100 : 0,
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      totalCost,
      unattributed: unattributed.length,
      callers: topGroups(filtered, (event) => event.caller || "unknown"),
      models: topGroups(filtered.filter((event) => Boolean(event.model)), (event) => event.model || "unknown"),
      services: topGroups(filtered, (event) => event.target || event.service),
      slowest: filtered
        .filter((event) => event.ms != null)
        .toSorted((a, b) => (b.ms ?? 0) - (a.ms ?? 0))
        .slice(0, 3),
    };
  }, [filtered]);

  const openDetail = useCallback((event: Ev) => {
    setDetail(event);
    setDetailKey(eventKey(event));
  }, []);

  const closeDetail = useCallback(() => {
    setDetail(null);
    setDetailKey(null);
  }, []);

  /**
   * Rolling spend per model. Computed over the ENTIRE event set, not the current
   * filter or page — a cost total that changed when you flipped a filter would
   * be actively misleading. Local models report 0 and are omitted.
   */
  const spend = useMemo(() => {
    const by = new Map<string, { cost: number; calls: number }>();
    let total = 0;
    for (const e of events) {
      if (!e.model || e.costUsd == null || e.costUsd <= 0) continue;
      const cur = by.get(e.model) ?? { cost: 0, calls: 0 };
      cur.cost += e.costUsd;
      cur.calls += 1;
      by.set(e.model, cur);
      total += e.costUsd;
    }
    const rows = [...by.entries()]
      .map(([model, v]) => ({ model, ...v }))
      .sort((a, b) => b.cost - a.cost);
    return { rows, total };
  }, [events]);

  return (
    <div className="tool-page requests-page space-y-4">
      <ToolPageHeader
        eyebrow="Observability"
        title="Requests"
        description="Trace every meaningful call across the console, router, and local services without health-check noise."
        icon={<Pulse size={24} weight="duotone" />}
        meta={<span className={`tool-page-chip ${live ? "is-ready" : ""}`}>{live ? "Live feed" : "Paused"}</span>}
      />
      <section className="grid grid-cols-2 gap-2 lg:grid-cols-5" aria-label={`Request health for ${timeRange}`}>
        <DiagnosticStat label="Requests" value={String(filtered.length)} hint={timeRange === "all" ? "entire retained feed" : `last ${timeRange}`} />
        <DiagnosticStat label="Failure rate" value={`${diagnostics.failureRate.toFixed(1)}%`} hint={`${diagnostics.failures} failed`} tone={diagnostics.failures ? "bad" : "good"} />
        <DiagnosticStat label="p50 latency" value={fmtMs(diagnostics.p50)} hint="typical completed call" />
        <DiagnosticStat label="p95 latency" value={fmtMs(diagnostics.p95)} hint="slow-call threshold" tone={(diagnostics.p95 ?? 0) > 10_000 ? "warn" : "neutral"} />
        <DiagnosticStat label="Spend" value={`$${diagnostics.totalCost < 0.01 ? diagnostics.totalCost.toFixed(5) : diagnostics.totalCost.toFixed(3)}`} hint={diagnostics.unattributed ? `${diagnostics.unattributed} missing caller` : "all spend attributed"} tone={diagnostics.unattributed ? "warn" : "neutral"} />
      </section>

      <section className="tool-panel flex flex-col gap-2 rounded-xl border border-gray-800 bg-gray-950/45 px-3 py-2.5 lg:flex-row lg:items-center lg:justify-between" aria-label="Request breakdowns">
        <Breakdown label="Callers" rows={diagnostics.callers} />
        <Breakdown label="Models" rows={diagnostics.models} />
        <Breakdown label="Services" rows={diagnostics.services} />
      </section>
      {diagnostics.slowest.length > 0 && (
        <section className="tool-panel rounded-xl border border-gray-800 bg-gray-950/45 px-3 py-2.5" aria-labelledby="slowest-requests-title">
          <div className="flex flex-wrap items-center gap-2">
            <span id="slowest-requests-title" className="text-[9px] font-semibold uppercase tracking-wider text-gray-600">Slowest calls</span>
            {diagnostics.slowest.map((event) => (
              <button key={eventKey(event)} type="button" onClick={() => openDetail(event)} className="max-w-full rounded-lg border border-gray-800 bg-gray-900 px-2.5 py-1.5 text-left text-[10px] text-gray-400 hover:border-gray-600 hover:text-gray-100">
                <span className="font-mono text-gray-300">{event.path}</span>{" "}
                <span className="tabular-nums text-amber-300">{fmtMs(event.ms)}</span>{" "}
                <span className="text-gray-600">{event.model || event.target || event.service}</span>
              </button>
            ))}
          </div>
        </section>
      )}
      {/* header */}
      <section className="tool-panel requests-summary bg-gray-900 rounded-xl border border-gray-800 p-4">
        <div className="flex items-center gap-3 flex-wrap">
          <span className={`w-2.5 h-2.5 rounded-full ${live ? "bg-green-500 animate-pulse" : "bg-gray-600"}`} />
          <span className="font-semibold text-sm">Requests</span>
          <span className="text-xs text-gray-500">every API call across the {getHost().name} stack — the console + every service</span>
          <span className="text-[11px] text-gray-500 tabular-nums">{filtered.length} shown</span>
          <div className="ml-auto flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-[11px] text-gray-400 cursor-pointer select-none">
              <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} className="accent-green-500" />
              Live
            </label>
            <button onClick={refresh} className="text-[11px] text-gray-400 hover:text-white border border-gray-700 hover:border-gray-500 rounded-md px-2 py-1 transition">
              Refresh
            </button>
          </div>
        </div>

        {/* Spend, per model, over whatever the feed currently holds. The router
            is the only source of cost, so this stays hidden until it reports. */}
        {spend.rows.length > 0 && (
          <div className="flex items-center gap-3 flex-wrap mt-3 pt-2 border-t border-gray-800">
            <span className="text-[10px] text-gray-600 uppercase tracking-wide">Spend</span>
            {spend.rows.map((r) => (
              <span key={r.model} className="text-[11px] text-gray-400 tabular-nums">
                <span className="text-violet-300">{r.model}</span>{" "}
                <span className="text-amber-400/80">${r.cost < 0.01 ? r.cost.toFixed(5) : r.cost.toFixed(3)}</span>{" "}
                <span className="text-gray-600">×{r.calls}</span>
              </span>
            ))}
            <span className="text-[11px] text-gray-300 tabular-nums ml-1">
              total <span className="text-amber-400">${spend.total < 0.01 ? spend.total.toFixed(5) : spend.total.toFixed(3)}</span>
            </span>
            <span className="text-[10px] text-gray-600">· in this feed window</span>
          </div>
        )}
      </section>

      {/* filters */}
      <div className="requests-toolbar sticky top-[104px] z-[3] flex items-center gap-2.5 flex-wrap rounded-xl border border-gray-800 bg-gray-950/95 p-2.5 backdrop-blur-sm">
        <label className="relative min-w-[220px] flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-600" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search path, model, caller or error…"
            className="h-8 w-full rounded-lg border border-gray-700 bg-gray-900 pl-8 pr-8 text-xs text-gray-200 outline-none placeholder:text-gray-600"
            aria-label="Search requests"
          />
          {query && (
            <button type="button" onClick={() => setQuery("")} aria-label="Clear request search" className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-gray-600 hover:text-gray-200">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </label>
        <label className="flex items-center gap-1.5 text-xs text-gray-500">
          range
          <Select value={timeRange} onValueChange={(v) => v && setTimeRange(v as TimeRange)}>
            <SelectTrigger className={SELECT_TRIGGER} aria-label="Time range">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className={SELECT_CONTENT}>
              {([["15m", "15m"], ["1h", "1h"], ["24h", "24h"], ["all", "all retained"]] as const).map(([v, label]) => (
                <SelectItem key={v} value={v} className="text-xs">{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <button
          type="button"
          onClick={() => setFailuresOnly((value) => !value)}
          aria-pressed={failuresOnly}
          className={`rounded-lg border px-2.5 py-1.5 text-xs transition ${failuresOnly ? "border-red-500/40 bg-red-500/10 text-red-300" : "border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-200"}`}
        >
          Failures
        </button>
        <FilterSelect label="service" value={service} onChange={setService} options={services} />
        <FilterSelect label="method" value={method} onChange={setMethod} options={methods} />
        <FilterSelect label="status" value={statusClass} onChange={setStatusClass} options={["2xx", "3xx", "4xx", "5xx"]} />
        <label
          className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer select-none"
          title="Health probes, status polls, /progress ticks and gallery thumbnail loads. Held in a separate buffer so they can never displace real requests."
        >
          <input type="checkbox" checked={showNoise} onChange={(e) => setShowNoise(e.target.checked)} className="accent-pink-500" />
          show noise
          {noiseCount > 0 && (
            <span className="text-[10px] tabular-nums text-gray-600">({noiseCount} hidden)</span>
          )}
        </label>
        <label
          className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer select-none"
          title="The downstream half of a router call — e.g. Qwen logging the same image generation the AI Router already logged. Hidden so one generation reads as one row, not two."
        >
          <input type="checkbox" checked={showHops} onChange={(e) => setShowHops(e.target.checked)} className="accent-pink-500" />
          show internal hops
          {hopCount > 0 && (
            <span className="text-[10px] tabular-nums text-gray-600">({hopCount} hidden)</span>
          )}
        </label>
        <label className="ml-auto flex items-center gap-1.5 text-xs text-gray-500">
          rows
          <Select value={String(pageSize)} onValueChange={(v) => v && setPageSize(Number(v))}>
            <SelectTrigger className={SELECT_TRIGGER} aria-label="Rows per page">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className={SELECT_CONTENT}>
              {[25, 50, 100].map((size) => (
                <SelectItem key={size} value={String(size)} className="text-xs">{size}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      </div>

      {/* table */}
      {loading ? (
        <p className="text-sm text-gray-500 py-12 text-center">Loading…</p>
      ) : shown.length === 0 ? (
        <div className="text-center py-16 text-gray-500">
          <p className="text-sm">No requests captured.</p>
          <p className="text-xs text-gray-600 mt-1">
            The console&apos;s own API calls appear as soon as they happen; backend services show up once they&apos;re running and logging.
          </p>
        </div>
      ) : (
        <div className="requests-table tool-panel overflow-x-auto rounded-xl border border-gray-800">
          <table className="w-full text-xs">
            <thead className="bg-gray-900 text-gray-500">
              <tr className="text-left">
                <th className="px-3 py-2 font-medium">time</th>
                <th className="px-3 py-2 font-medium">service</th>
                <th className="px-3 py-2 font-medium">method</th>
                <th className="px-3 py-2 font-medium">path</th>
                <th className="px-3 py-2 font-medium">status</th>
                <th className="px-3 py-2 font-medium">latency</th>
                <th className="px-3 py-2 font-medium">from</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/70">
              {shown.map((e) => (
                <tr key={eventKey(e)} onClick={() => openDetail(e)} className="hover:bg-gray-900/60 cursor-pointer">
                  <td className="px-3 py-1.5 tabular-nums text-gray-500 whitespace-nowrap">
                    <button
                      type="button"
                      onClick={(event) => { event.stopPropagation(); openDetail(e); }}
                      className="rounded text-left underline-offset-2 hover:text-gray-200 hover:underline"
                      aria-label={`Open request detail for ${e.method} ${e.path} at ${fmtTime(e.ts)}`}
                    >
                      {e.source === "log" && e.ts ? "~" : ""}{fmtTime(e.ts)}
                    </button>
                  </td>
                  <td className="px-3 py-1.5 whitespace-nowrap">
                    <span className={`px-1.5 py-0.5 rounded-full border text-[10px] ${svcColor(e.service)}`}>{e.service}</span>
                    {/* Who logged it → who it was aimed at. Without the second
                        half every console route reads "console" and the table
                        can't answer the one question it exists for: which
                        service is actually being called. */}
                    {e.target && e.target !== e.service && (
                      <>
                        <span className="mx-1 text-gray-600">→</span>
                        <span className={`px-1.5 py-0.5 rounded-full border text-[10px] ${svcColor(e.target)}`}>{e.target}</span>
                      </>
                    )}
                  </td>
                  <td className={`px-3 py-1.5 font-mono font-medium ${methodColor(e.method)}`}>{e.method}</td>
                  <td className="px-3 py-1.5 font-mono text-gray-300 max-w-[420px] truncate" title={e.path}>
                    {e.path}
                    {/* Router rows are only meaningful with the model attached —
                        otherwise every provider collapses into one "ai-router" row. */}
                    {e.model && (
                      <span className="ml-2 px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-300 border border-violet-500/30 text-[10px] font-sans">
                        {e.model}
                      </span>
                    )}
                    {e.costUsd != null && e.costUsd > 0 && (
                      <span className="ml-1.5 text-[10px] text-amber-400/80 font-sans tabular-nums">
                        ${e.costUsd < 0.01 ? e.costUsd.toFixed(5) : e.costUsd.toFixed(3)}
                      </span>
                    )}
                    {/* The caller used to be tacked on here, competing with the
                        model and cost badges inside a truncating cell. It lives
                        in the `from` column now — which is the question it
                        answers. */}
                    {/* Only visible with "show internal hops" on — say so, or a
                        duplicate-looking row is indistinguishable from a real one. */}
                    {e.hop && (
                      <span
                        className="ml-1.5 text-[10px] text-gray-600 font-sans"
                        title={`Downstream half of a call ${e.hop} already logged — not a separate request.`}
                      >
                        ↳ via {e.hop}
                      </span>
                    )}
                  </td>
                  <td className={`px-3 py-1.5 tabular-nums font-medium ${statusColor(e.status)}`}>
                    {e.pending ? (
                      <span className="inline-flex items-center gap-1.5 text-sky-400 font-sans font-normal">
                        <span className="w-1.5 h-1.5 rounded-full bg-sky-400 animate-pulse" />
                        running
                      </span>
                    ) : (
                      e.status ?? "—"
                    )}
                  </td>
                  {/* Counting up from the start, so a long generation reads as
                      progress rather than as a stuck row. */}
                  <td className="px-3 py-1.5 tabular-nums text-gray-400">
                    {e.pending ? <Elapsed since={e.ts} /> : fmtMs(e.ms)}
                  </td>
                  {/* WHO, not from which socket. Every service on this box talks
                      to every other over loopback, so the IP was "::1" or
                      "127.0.0.1" on every single row — technically true and
                      completely uninformative. X-Source is the real answer, so
                      it leads; the address stays as the title for the rare case
                      a call came from off-box. */}
                  <td className="px-3 py-1.5 text-gray-600 whitespace-nowrap" title={e.ip ?? undefined}>
                    {e.caller ? (
                      <span className="text-gray-300">{e.caller}</span>
                    ) : (
                      <span>{loopback(e.ip) ? "localhost" : (e.ip ?? "—")}</span>
                    )}
                    <span className="ml-1.5 text-[10px] text-gray-700">{e.source}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pageCount > 1 && (
        <div className="flex items-center justify-center gap-3 text-xs text-gray-500">
          <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={curPage === 0}
            className="px-2.5 py-1 rounded-lg border border-gray-700 hover:border-gray-500 disabled:opacity-40 disabled:cursor-default transition">‹ Prev</button>
          <span className="tabular-nums">Page {curPage + 1} of {pageCount} · {filtered.length} total</span>
          <button onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))} disabled={curPage >= pageCount - 1}
            className="px-2.5 py-1 rounded-lg border border-gray-700 hover:border-gray-500 disabled:opacity-40 disabled:cursor-default transition">Next ›</button>
        </div>
      )}

      {detail && <DetailPanel key={eventKey(detail)} ev={detail} onClose={closeDetail} />}
    </div>
  );
}

// ── detail slide-over + content-type-aware response preview ──────────────────

// Resolve an event to a fetchable URL. Console events are same-origin (path is
// already relative); backend-service events get their service's local base.
function resolveUrl(e: Ev): { url: string; sameOrigin: boolean } {
  if (e.service === "console") return { url: e.path, sameOrigin: true };
  const svc = SERVICE_REGISTRY.find((s) => s.id === e.service);
  if (svc) return { url: svc.localUrl.replace(/\/$/, "") + e.path, sameOrigin: false };
  return { url: e.path, sameOrigin: e.path.startsWith("/") };
}

function DRow({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-gray-600">{k}</dt>
      <dd className={`text-gray-300 text-right break-all ${mono ? "font-mono" : ""}`}>{v}</dd>
    </div>
  );
}

function DetailPanel({ ev, onClose }: { ev: Ev; onClose: () => void }) {
  const { url } = resolveUrl(ev);
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusFrame = window.requestAnimationFrame(() => closeRef.current?.focus());

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const focusable = [...panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter((element) => !element.hasAttribute("hidden"));
      if (!focusable.length) {
        e.preventDefault();
        panelRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      previousFocusRef.current?.focus();
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="h-full w-full max-w-lg space-y-4 overflow-y-auto border-l border-gray-800 bg-gray-900 p-5 shadow-2xl"
      >
        <div className="flex items-center justify-between">
          <h3 id={titleId} className="text-sm font-semibold">Request detail</h3>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close request detail" className="flex h-10 w-10 items-center justify-center rounded-lg text-lg leading-none text-gray-500 hover:bg-gray-800 hover:text-white">✕</button>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`font-mono font-semibold ${methodColor(ev.method)}`}>{ev.method}</span>
          <span className={`tabular-nums font-semibold ${statusColor(ev.status)}`}>{ev.status ?? "—"}</span>
          <span className={`px-1.5 py-0.5 rounded-full border text-[10px] ${svcColor(ev.service)}`}>{ev.service}</span>
          <span className="text-[10px] text-gray-600">{ev.source}</span>
        </div>
        <code className="block text-xs bg-gray-800 rounded-lg p-2.5 break-all font-mono text-gray-300">{ev.path}</code>

        {/* Why this call happened. A billable request with no caller and no
            prompt is just an unexplained charge — this is the whole point of
            the row being here. */}
        {(ev.caller || ev.prompt || ev.model) && (
          <div className="rounded-lg border border-violet-500/25 bg-violet-500/5 p-2.5 space-y-1.5">
            <dl className="text-xs space-y-1">
              {ev.model && <DRow k="model" v={ev.model} />}
              {ev.caller && <DRow k="called by" v={ev.caller} />}
              {(ev.tokensIn != null || ev.tokensOut != null) && (
                <DRow k="tokens" v={`${ev.tokensIn ?? "?"} in · ${ev.tokensOut ?? "?"} out`} />
              )}
              {ev.costUsd != null && ev.costUsd > 0 && (
                <DRow k="cost" v={`$${ev.costUsd < 0.01 ? ev.costUsd.toFixed(6) : ev.costUsd.toFixed(4)}`} />
              )}
            </dl>
            {ev.prompt && <ExpandableText label="prompt" text={ev.prompt} fullChars={ev.promptChars} />}
          </div>
        )}

        {(ev.costUsd ?? 0) > 0 && !ev.caller && (
          <div role="note" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-[11px] leading-relaxed text-amber-100">
            This billable call has no <span className="font-mono">X-Source</span> attribution. Add the caller header so spend and failures can be traced to the originating app.
          </div>
        )}

        {ev.error && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-2.5">
            <span className="text-[10px] text-red-400 uppercase tracking-wider">error</span>
            <p className="text-[11px] text-red-300/90 font-mono break-words mt-0.5">{ev.error}</p>
          </div>
        )}

        <dl className="text-xs space-y-1">
          <DRow k="time" v={ev.ts ? new Date(ev.ts).toLocaleString() : "—"} />
          <DRow k="latency" v={fmtMs(ev.ms)} />
          <DRow k="client" v={ev.ip ?? "—"} />
          <DRow k="resolved url" v={url} mono />
        </dl>
        <div className="border-t border-gray-800 pt-3">
          <h4 className="text-xs text-gray-500 uppercase tracking-wider mb-2">Response</h4>
          {ev.pending ? (
            <div className="flex items-center gap-2 text-xs text-sky-400">
              <span className="w-1.5 h-1.5 rounded-full bg-sky-400 animate-pulse" />
              Still running — <Elapsed since={ev.ts} /> elapsed. The result appears here when it lands.
            </div>
          ) : ev.artifact?.kind === "image" ? (
            // The image this call actually produced, served from the archive the
            // service already wrote. Re-fetching to preview it (what the fallback
            // below does for GETs) would mean generating a whole second image.
            <div className="space-y-1.5">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/qwen/archive/file?rel=${encodeURIComponent(ev.artifact.rel)}`}
                alt="Generated result"
                className="max-w-full rounded-lg border border-gray-800"
              />
              <p className="text-[10px] text-gray-600 font-mono break-all">{ev.artifact.rel}</p>
            </div>
          ) : ev.response ? (
            // The reply as the router recorded it at log time. The previewer
            // below can only show a body by re-fetching the URL, which it
            // refuses to do for a POST — so without this, every chat completion
            // read "not previewed" even though the text was already known.
            <ExpandableText label="reply" text={ev.response} fullChars={ev.responseChars} tone="reply" />
          ) : (
            <ResponsePreview ev={ev} />
          )}
        </div>
      </div>
    </div>
  );
}

// Fetches the request's URL and renders it by its ACTUAL content-type: images
// inline, audio in a player, JSON/text formatted, anything else as a download.
// Only auto-loads safe same-origin GETs; a POST/DELETE is never re-sent.
/**
 * Long text that starts clamped but can always be opened in full.
 *
 * Prompts and replies here run to thousands of characters. Dumping one whole
 * makes the panel unnavigable; clamping it with no way out is precisely what
 * made the old 300-character preview so useless — it looked like the text just
 * ended. So: clamp, expand on demand, and be explicit about the difference
 * between "collapsed for now" and "this is genuinely all we kept".
 *
 * The character count is always shown, because a trailing ellipsis cannot tell
 * you whether you are missing ten characters or ten thousand.
 */
function ExpandableText({ label, text, fullChars, tone = "prompt" }: {
  label: string;
  text: string;
  fullChars?: number | null;
  tone?: "prompt" | "reply";
}) {
  const [open, setOpen] = useState(false);
  // The producer clipped it: what we hold is genuinely shorter than what was said.
  const clipped = typeof fullChars === "number" && fullChars > text.length;
  // Below this a toggle is just noise — the whole thing already fits.
  const worthCollapsing = text.length > 600;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wider text-gray-500">{label}</span>
        <span className="shrink-0 text-[10px] tabular-nums text-gray-600">
          {clipped
            ? `first ${text.length.toLocaleString()} of ${fullChars.toLocaleString()} chars`
            : `${text.length.toLocaleString()} chars`}
        </span>
      </div>
      <p
        className={`mt-0.5 whitespace-pre-wrap break-words text-[11px] leading-relaxed ${
          tone === "reply" ? "text-gray-200" : "text-gray-300"
        } ${open || !worthCollapsing ? "" : "max-h-32 overflow-hidden"}`}
      >
        {text}
      </p>
      {worthCollapsing && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="mt-1 text-[10px] font-medium text-indigo-400 hover:text-indigo-300"
        >
          {open ? "Show less" : `Show all ${text.length.toLocaleString()} characters`}
        </button>
      )}
      {clipped && open && (
        <p className="mt-1 text-[10px] leading-relaxed text-gray-600">
          {(fullChars - text.length).toLocaleString()} characters are not shown because they were
          never sent: the router stores at most {text.length.toLocaleString()} per call, to bound
          the console&apos;s in-memory feed.
        </p>
      )}
    </div>
  );
}

function ResponsePreview({ ev }: { ev: Ev }) {
  const { url, sameOrigin } = resolveUrl(ev);
  const isGet = ev.method === "GET";
  const objRef = useRef<string | null>(null);
  const [st, setSt] = useState<{
    loading: boolean; err?: string; kind?: string; ct?: string; text?: string; obj?: string; size?: number;
  }>({ loading: false });

  const load = useCallback(async () => {
    if (objRef.current) { URL.revokeObjectURL(objRef.current); objRef.current = null; }
    setSt({ loading: true });
    try {
      const res = await fetch(url);
      const ct = res.headers.get("content-type") || "";
      if (ct.startsWith("image/")) {
        const b = await res.blob(); const o = URL.createObjectURL(b); objRef.current = o;
        setSt({ loading: false, kind: "image", ct, obj: o, size: b.size });
      } else if (ct.startsWith("audio/")) {
        const b = await res.blob(); const o = URL.createObjectURL(b); objRef.current = o;
        setSt({ loading: false, kind: "audio", ct, obj: o, size: b.size });
      } else if (ct.includes("json")) {
        const t = await res.text(); let p = t; try { p = JSON.stringify(JSON.parse(t), null, 2); } catch {}
        setSt({ loading: false, kind: "text", ct, text: p.slice(0, 20000), size: t.length });
      } else if (ct.startsWith("text/") || ct.includes("xml") || ct.includes("javascript")) {
        const t = await res.text(); setSt({ loading: false, kind: "text", ct, text: t.slice(0, 20000), size: t.length });
      } else {
        const b = await res.blob(); const o = URL.createObjectURL(b); objRef.current = o;
        setSt({ loading: false, kind: "binary", ct, obj: o, size: b.size });
      }
    } catch (e) {
      setSt({ loading: false, err: e instanceof Error ? e.message : String(e) });
    }
  }, [url]);

  useEffect(() => {
    if (isGet && sameOrigin) load();
    return () => { if (objRef.current) URL.revokeObjectURL(objRef.current); };
  }, [isGet, sameOrigin, load]);

  if (!isGet) {
    return (
      <p className="text-xs text-gray-500 leading-relaxed">
        Not previewed — re-sending a <span className="font-mono text-gray-400">{ev.method}</span> could repeat the action.{" "}
        <a className="text-indigo-400 hover:text-indigo-300 underline" href={url} target="_blank" rel="noreferrer">Open URL ↗</a>
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {!st.loading && !st.kind && !st.err && (
        <button onClick={load} className="text-xs border border-gray-700 hover:border-gray-500 rounded-lg px-3 py-1.5 text-gray-300">
          Load preview{!sameOrigin ? " (cross-origin — may be blocked)" : ""}
        </button>
      )}
      {st.loading && <p className="text-xs text-gray-500">Loading…</p>}
      {st.err && (
        <p className="text-xs text-amber-400">
          Couldn&apos;t load ({st.err}).{" "}
          <a className="text-indigo-400 hover:text-indigo-300 underline" href={url} target="_blank" rel="noreferrer">Open ↗</a>
        </p>
      )}
      {st.kind && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-[11px] text-gray-500">
            <span className="font-mono">{st.ct || "unknown"}</span>
            {st.size != null && <span>· {st.size >= 1024 ? `${(st.size / 1024).toFixed(1)} KB` : `${st.size} B`}</span>}
            <a className="ml-auto text-indigo-400 hover:text-indigo-300 underline" href={url} target="_blank" rel="noreferrer">Open ↗</a>
          </div>
          {st.kind === "image" && st.obj && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={st.obj} alt={ev.path} className="max-w-full rounded-lg border border-gray-800 bg-black" />
          )}
          {st.kind === "audio" && st.obj && <audio controls src={st.obj} className="w-full" />}
          {st.kind === "text" && (
            <pre className="text-[11px] font-mono bg-gray-800 rounded-lg p-2.5 overflow-auto max-h-96 text-gray-300 whitespace-pre-wrap break-all">{st.text}</pre>
          )}
          {st.kind === "binary" && st.obj && (
            <a href={st.obj} download className="text-xs text-indigo-400 hover:text-indigo-300 underline">Download ({st.ct || "binary"})</a>
          )}
        </div>
      )}
    </div>
  );
}
