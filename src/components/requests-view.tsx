"use client";

import { useState, useEffect, useCallback, useMemo } from "react";

type Ev = {
  ts: number | null;
  service: string;
  method: string;
  path: string;
  status: number | null;
  ms: number | null;
  ip: string | null;
  source: "live" | "log";
};

// The console polls service health constantly; hide that chatter by default so
// the feed shows real work. GET-only, matched against the well-known endpoints.
const NOISE = /^(\/health|\/metrics|\/gpu|\/models|\/system_stats|\/-\/healthy|\/api\/(health|gpu|metrics|services|routing))$/;
const isNoise = (e: Ev) => e.method === "GET" && NOISE.test(e.path);

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

export default function RequestsView() {
  const [events, setEvents] = useState<Ev[]>([]);
  const [services, setServices] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [live, setLive] = useState(true);

  // filters
  const [service, setService] = useState("all");
  const [method, setMethod] = useState("all");
  const [statusClass, setStatusClass] = useState("all");
  const [hideNoise, setHideNoise] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/traffic");
      const data = await res.json();
      setEvents(Array.isArray(data.events) ? data.events : []);
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
    return events.filter((e) => {
      if (hideNoise && isNoise(e)) return false;
      if (service !== "all" && e.service !== service) return false;
      if (method !== "all" && e.method !== method) return false;
      if (statusClass !== "all") {
        const c = e.status == null ? "?" : String(Math.floor(e.status / 100)) + "xx";
        if (c !== statusClass) return false;
      }
      return true;
    });
  }, [events, hideNoise, service, method, statusClass]);

  const shown = filtered.slice(0, 400);
  const methods = useMemo(() => [...new Set(events.map((e) => e.method))].sort(), [events]);

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
      </section>

      {/* filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <Sel label="service" value={service} onChange={setService} opts={services} />
        <Sel label="method" value={method} onChange={setMethod} opts={methods} />
        <Sel label="status" value={statusClass} onChange={setStatusClass} opts={["2xx", "3xx", "4xx", "5xx"]} />
        <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer select-none">
          <input type="checkbox" checked={hideNoise} onChange={(e) => setHideNoise(e.target.checked)} className="accent-pink-500" />
          hide health checks
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
                <tr key={i} className="hover:bg-gray-900/60">
                  <td className="px-3 py-1.5 tabular-nums text-gray-500 whitespace-nowrap">
                    {e.source === "log" && e.ts ? "~" : ""}
                    {fmtTime(e.ts)}
                  </td>
                  <td className="px-3 py-1.5">
                    <span className={`px-1.5 py-0.5 rounded-full border text-[10px] ${svcColor(e.service)}`}>{e.service}</span>
                  </td>
                  <td className={`px-3 py-1.5 font-mono font-medium ${methodColor(e.method)}`}>{e.method}</td>
                  <td className="px-3 py-1.5 font-mono text-gray-300 max-w-[420px] truncate" title={e.path}>{e.path}</td>
                  <td className={`px-3 py-1.5 tabular-nums font-medium ${statusColor(e.status)}`}>{e.status ?? "—"}</td>
                  <td className="px-3 py-1.5 tabular-nums text-gray-400">{fmtMs(e.ms)}</td>
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
      {filtered.length > shown.length && (
        <p className="text-[11px] text-gray-600 text-center">showing latest {shown.length} of {filtered.length} matching</p>
      )}
    </div>
  );
}
