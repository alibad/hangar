"use client";

import { useCallback, useMemo, useState } from "react";
import { ToolPageHeader } from "./tool-page";
import { useLiveRefresh } from "@/lib/use-live-refresh";
import { Circuitry } from "@phosphor-icons/react";
import type { Entry, Payload } from "./models-page.types";
import { buildEntries } from "./models-page.types";
import { MachineStrip, RouteStrip, FilterBar, Lane } from "./models-page.parts";

/**
 * Models — one page.
 *
 * This started as three: a routing tab, a scouting tab, and a leaderboard tab.
 * That was three answers to one question. Every one of those surfaces was about
 * the same objects — models — differing only in how far away they were: running
 * here, wired but idle, buyable from a vendor, downloadable from the Hub. Making
 * the reader pick a tab before they could see them meant they could never
 * compare across that distance, which is the only comparison that matters when
 * you are deciding what to run.
 *
 * So: one list of models, two lanes (this machine / cloud), filtered by default
 * to what actually runs on this card, with every action inline. The machine at
 * the top is the frame everything else is judged against.
 */
export default function ModelsPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);

  // Filters. `runsHere` defaults ON — the whole point of this page is that it
  // knows what this box can do, and a list that opens on 200 models it cannot
  // run is a leaderboard, not a console.
  const [runsHere, setRunsHere] = useState(true);
  const [capability, setCapability] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(24);

  const refresh = useCallback(async (force = false) => {
    try {
      const res = await fetch(`/api/scout${force ? "?force=1" : ""}`, { cache: "no-store" });
      const payload = await res.json();
      if (!payload?.error) setData(payload);
    } catch {
      /* keep the last good view */
    }
    setLoading(false);
  }, []);

  // A download in flight is the one thing here that changes second to second.
  const downloading = (data?.downloads ?? []).some((d) => d.status === "running");
  useLiveRefresh(refresh, { intervalMs: downloading ? 4000 : 20_000 });

  const act = useCallback(
    async (url: string, body: Record<string, unknown>, label: string, okText?: string) => {
      setBusy(label);
      setMsg(null);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const j = await res.json();
        if (!res.ok || j.error) throw new Error(j.error || `Server returned ${res.status}`);
        setMsg(j.warning ? { text: j.warning, bad: true } : { text: okText ?? `${label} — done.` });
        await refresh(true);
      } catch (e) {
        setMsg({ text: e instanceof Error ? e.message : String(e), bad: true });
      }
      setBusy(null);
      setTimeout(() => setMsg(null), 7000);
    },
    [refresh],
  );

  /** Route a capability at a model, starting its service first when it is cold. */
  const use = useCallback(
    async (entry: Entry, cap: string) => {
      const label = `use:${entry.key}:${cap}`;
      if (entry.serviceId && entry.status === "stopped") {
        setBusy(label);
        setMsg({ text: `Starting ${entry.name} and waiting for a healthy endpoint…` });
        try {
          const start = await fetch(`/api/services/${entry.serviceId}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "start" }),
          });
          const sp = await start.json();
          if (!start.ok || sp.error) throw new Error(sp.error || `Service manager returned ${start.status}`);
          const deadline = Date.now() + 90_000;
          let ready = false;
          while (!ready && Date.now() < deadline) {
            await new Promise((r) => window.setTimeout(r, 1500));
            const p: Payload = await fetch("/api/scout", { cache: "no-store" }).then((r) => r.json());
            setData(p);
            ready = p.catalogue.some((m) => m.id === entry.alias && m.status === "ready");
          }
          if (!ready) throw new Error(`${entry.name} did not become healthy within 90 seconds`);
        } catch (e) {
          setMsg({ text: e instanceof Error ? e.message : String(e), bad: true });
          setBusy(null);
          return;
        }
      }
      await act("/api/providers", { [cap]: entry.alias }, label, `${cap} now routes to ${entry.alias}.`);
    },
    [act],
  );

  const entries = useMemo(() => (data ? buildEntries(data) : []), [data]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((e) => {
      if (runsHere && !e.runsHere) return false;
      if (capability && !e.capabilities.includes(capability)) return false;
      if (q && !`${e.name} ${e.sub} ${e.org ?? ""} ${e.alias ?? ""}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [entries, runsHere, capability, query]);

  const local = filtered.filter((e) => e.kind === "local");
  const cloud = filtered.filter((e) => e.kind === "cloud");

  if (loading) return <p className="text-sm text-gray-500 py-16 text-center">Reading the machine…</p>;
  if (!data) return <p className="text-sm text-gray-500 py-16 text-center">Models unavailable.</p>;

  return (
    <div className="tool-page models-page space-y-5">
      <ToolPageHeader
        eyebrow="Models"
        title="Everything this box can run"
        description="Local weights and cloud APIs in one list, sized against this card and this drive. Filtered to what actually runs here."
        icon={<Circuitry size={24} weight="duotone" />}
        meta={
          <span className={`tool-page-chip ${data.routerUp ? "is-ready" : "is-offline"}`}>
            {data.routerUp ? "Router online" : "Router offline"}
          </span>
        }
      />

      <MachineStrip
        machine={data.machine}
        occupants={data.occupants}
        leaderboard={data.leaderboard}
        onRefresh={() => refresh(true)}
      />

      <RouteStrip
        capabilities={data.capabilities}
        routing={data.routing}
        catalogue={data.catalogue}
        selected={capability}
        onSelect={(c) => setCapability((prev) => (prev === c ? null : c))}
      />

      {msg && (
        <div
          role="status"
          aria-live="polite"
          className={`text-xs rounded-lg px-3 py-2 ${msg.bad ? "bg-red-500/10 text-red-400" : "bg-green-500/10 text-green-400"}`}
        >
          {msg.text}
        </div>
      )}

      <FilterBar
        runsHere={runsHere}
        onRunsHere={setRunsHere}
        query={query}
        onQuery={setQuery}
        capability={capability}
        onClearCapability={() => setCapability(null)}
        localCount={local.length}
        cloudCount={cloud.length}
        hiddenCount={entries.length - filtered.length}
        unwired={data.discovery.reduce((n, p) => n + p.models.filter((m) => !m.wiredAs).length, 0)}
        busy={busy}
        onWireAll={() =>
          act("/api/scout", { action: "wire-all" }, "wire-all", "Every cloud model your providers offer is now wired.")
        }
      />

      <div className="grid gap-4 xl:grid-cols-2 items-start">
        <Lane
          title="On this machine"
          subtitle="Open weights. Sizes are what they cost on this card; downloads land on the weights drive."
          tone="local"
          entries={local}
          limit={limit}
          busy={busy}
          capabilities={data.capabilities}
          onMore={() => setLimit((n) => n + 24)}
          onUse={use}
          onService={(id, action) =>
            act(`/api/services/${id}`, { action }, `svc:${id}:${action}`, `${id} ${action}ed.`)
          }
          onDownload={(repo) => act("/api/scout", { action: "download", repo }, `dl:${repo}`, `Downloading ${repo}.`)}
          onCancelDownload={(repo) =>
            act("/api/scout", { action: "cancel-download", repo }, `dl:${repo}`, `Cancelled ${repo}.`)
          }
        />
        <Lane
          title="Cloud"
          subtitle="Runs on the provider's hardware. Costs money per call, no local memory."
          tone="cloud"
          entries={cloud}
          limit={limit}
          busy={busy}
          capabilities={data.capabilities}
          onMore={() => setLimit((n) => n + 24)}
          onUse={use}
          onWire={(e) =>
            act(
              "/api/scout",
              { action: "wire", alias: e.suggestedAlias, target: e.target, provider: e.org, mode: e.mode },
              `wire:${e.key}`,
              `${e.suggestedAlias} is wired and the router restarted.`,
            )
          }
          onUnwire={(e) =>
            act("/api/scout", { action: "unwire", alias: e.alias }, `unwire:${e.key}`, `${e.alias} removed.`)
          }
        />
      </div>

      <footer className="border-t border-gray-800 pt-3 space-y-1.5">
        <p className="text-[10px] text-gray-600 leading-relaxed">
          Aliases live in <span className="font-mono text-gray-500">config/ai-router.yaml</span>; models wired from this
          page are kept in <span className="font-mono text-gray-500">config/wired-models.json</span> and spliced into a
          managed block there. Benchmarks and prices come from{" "}
          <a href={data.leaderboard.source} target="_blank" rel="noreferrer" className="text-indigo-400 hover:text-indigo-300 underline underline-offset-2">
            llm-stats.com
          </a>
          . VRAM and disk figures for models that are not installed are estimated from parameter count and quantisation;
          measured footprints for what IS installed live in{" "}
          <span className="font-mono text-gray-500">config/model-meta.json</span> and always win.
        </p>
        {data.report.notes.length > 0 && (
          <details className="text-[10px] text-gray-600">
            <summary className="cursor-pointer hover:text-gray-400">
              Scout notes ({data.report.generatedAt ?? "undated"}
              {data.report.stale ? " · stale" : ""})
            </summary>
            <ul className="mt-1.5 space-y-1 pl-1">
              {data.report.notes.map((n, i) => (
                <li key={i} className="leading-relaxed">— {n}</li>
              ))}
            </ul>
          </details>
        )}
      </footer>
    </div>
  );
}

