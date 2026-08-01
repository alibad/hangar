"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { SERVICE_REGISTRY } from "@/lib/services";

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
  tokensIn?: number | null;
  tokensOut?: number | null;
  error?: string | null;
  hop?: string | null;
  rid?: string | null;
  pending?: boolean;
  artifact?: { kind: "image"; rel: string } | null;
};

// Polling is classified and segregated SERVER-side (see lib/traffic.ts) rather
// than filtered here. A client-side regex still let chatter into the shared ring,
// where a 70-second generation's once-a-second /progress ticks could evict real
// requests before anyone looked at them.

const PAGE_SIZE = 100;

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

export default function RequestsView() {
  const [events, setEvents] = useState<Ev[]>([]);
  const [services, setServices] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [live, setLive] = useState(true);

  // filters
  const [service, setService] = useState("all");
  const [method, setMethod] = useState("all");
  const [statusClass, setStatusClass] = useState("all");
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

  useEffect(() => {
    refresh();
    if (!live) return;
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [refresh, live]);

  const filtered = useMemo(() => {
    // Noise and hops are separate streams server-side; merge them in on demand.
    const extra = [...(showNoise ? noise : []), ...(showHops ? hops : [])];
    const base = extra.length
      ? [...events, ...extra].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))
      : events;
    return base.filter((e) => {
      if (service !== "all" && e.service !== service) return false;
      if (method !== "all" && e.method !== method) return false;
      if (statusClass !== "all") {
        const c = e.status == null ? "?" : String(Math.floor(e.status / 100)) + "xx";
        if (c !== statusClass) return false;
      }
      return true;
    });
  }, [events, noise, showNoise, hops, showHops, service, method, statusClass]);

  // Filters changed → jump back to the first page.
  useEffect(() => { setPage(0); }, [service, method, statusClass, showNoise, showHops]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const curPage = Math.min(page, pageCount - 1);
  const shown = filtered.slice(curPage * PAGE_SIZE, (curPage + 1) * PAGE_SIZE);
  const methods = useMemo(() => [...new Set(events.map((e) => e.method))].sort(), [events]);

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

  const Sel = ({ value, onChange, opts, label }: { value: string; onChange: (v: string) => void; opts: string[]; label: string }) => (
    <label className="flex items-center gap-1.5 text-xs text-gray-500">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-300"
      >
        <option value="all">all</option>
        {opts.map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="space-y-4">
      {/* header */}
      <section className="bg-gray-900 rounded-xl border border-gray-800 p-4">
        <div className="flex items-center gap-3 flex-wrap">
          <span className={`w-2.5 h-2.5 rounded-full ${live ? "bg-green-500 animate-pulse" : "bg-gray-600"}`} />
          <span className="font-semibold text-sm">Requests</span>
          <span className="text-xs text-gray-500">every API call across the BeTenshi stack — the console + every service</span>
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
      <div className="flex items-center gap-3 flex-wrap">
        <Sel label="service" value={service} onChange={setService} opts={services} />
        <Sel label="method" value={method} onChange={setMethod} opts={methods} />
        <Sel label="status" value={statusClass} onChange={setStatusClass} opts={["2xx", "3xx", "4xx", "5xx"]} />
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
        <div className="overflow-x-auto rounded-xl border border-gray-800">
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
              {shown.map((e, i) => (
                <tr key={i} onClick={() => setDetail(e)} className="hover:bg-gray-900/60 cursor-pointer">
                  <td className="px-3 py-1.5 tabular-nums text-gray-500 whitespace-nowrap">
                    {e.source === "log" && e.ts ? "~" : ""}
                    {fmtTime(e.ts)}
                  </td>
                  <td className="px-3 py-1.5">
                    <span className={`px-1.5 py-0.5 rounded-full border text-[10px] ${svcColor(e.service)}`}>{e.service}</span>
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
                    {/* Who triggered it — visible without opening the row. */}
                    {e.caller && (
                      <span className="ml-1.5 text-[10px] text-gray-500 font-sans" title={e.caller}>
                        ← {e.caller}
                      </span>
                    )}
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
                  <td className="px-3 py-1.5 text-gray-600">
                    {e.ip ?? "—"}
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

      {detail && <DetailPanel ev={detail} onClose={() => setDetail(null)} />}
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={onClose}>
      <div className="w-full max-w-lg h-full overflow-y-auto bg-gray-900 border-l border-gray-800 p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-sm">Request detail</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-lg leading-none">✕</button>
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
            {ev.prompt && (
              <div>
                <span className="text-[10px] text-gray-500 uppercase tracking-wider">prompt</span>
                <p className="text-[11px] text-gray-300 leading-relaxed mt-0.5 whitespace-pre-wrap break-words">
                  {ev.prompt}
                </p>
              </div>
            )}
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
