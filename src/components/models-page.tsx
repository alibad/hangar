"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ToolPageHeader } from "./tool-page";
import { useLiveRefresh } from "@/lib/use-live-refresh";
import {
  ArrowRight,
  ChatCircleDots,
  Circuitry,
  Cloud,
  CloudArrowDown,
  ImageSquare,
  Microphone,
  Waveform,
} from "@phosphor-icons/react";
import type { Entry, Payload, Sort } from "./models-page.types";
import { buildEntries, sortEntries } from "./models-page.types";
import {
  MachineStrip,
  RouteStrip,
  FilterBar,
  Lane,
  LaneTabs,
  ViewToggle,
  ModelTable,
  DetailPanel,
  HubModelSearch,
} from "./models-page.parts";

const SETUP_CAPABILITIES = [
  { id: "text", label: "Chat & code", icon: ChatCircleDots },
  { id: "image", label: "Create images", icon: ImageSquare },
  { id: "vision", label: "Understand images", icon: Circuitry },
  { id: "stt", label: "Transcribe audio", icon: Microphone },
  { id: "tts", label: "Generate speech", icon: Waveform },
] as const;

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
  const [lane, setLane] = useState<"local" | "cloud">("local");
  // List by default: the question here is comparative, and a grid of cards makes
  // you hold numbers in your head between one card and the next.
  const [view, setView] = useState<"list" | "cards">("list");
  const [sort, setSort] = useState<Sort>({ key: "default", dir: "desc" });
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [hubSearchIntent, setHubSearchIntent] = useState("");

  const startLocalSetup = useCallback((cap?: string) => {
    setLane("local");
    setRunsHere(true);
    setCapability(cap ?? null);
    setQuery("");
    setView("cards");
    setSelectedKey(null);
    window.setTimeout(
      () => document.getElementById("model-results")?.scrollIntoView({ behavior: "smooth", block: "start" }),
      0,
    );
  }, []);

  useEffect(() => {
    const requested = window.sessionStorage.getItem("hangar-model-setup-capability");
    if (!requested) return;
    window.sessionStorage.removeItem("hangar-model-setup-capability");
    setLane("local");
    setRunsHere(true);
    setCapability(requested);
    setView("cards");
    setHubSearchIntent(window.sessionStorage.getItem("hangar-model-search") ?? "");
    window.sessionStorage.removeItem("hangar-model-search");
  }, []);

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
  /** Machines other than the one serving this page, by name. Empty on a single-host setup. */
  const otherHosts = useMemo(
    () => (data?.machines ?? []).filter((m) => !m.live).map((m) => m.hostName),
    [data],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((e) => {
      // "Runs here" means runs on a machine you HAVE, not strictly on the box
      // serving this page. With two hosts configured, the strict reading hid
      // exactly the rows worth seeing: a model refused by the 5090 that B5 runs
      // comfortably would never appear, so the console could never tell you the
      // option existed. The row says which machine; this only decides whether
      // it is worth showing at all.
      if (runsHere && !e.runsHere && !e.runsElsewhere) return false;
      if (capability && !e.capabilities.includes(capability)) return false;
      if (q && !`${e.name} ${e.sub} ${e.org ?? ""} ${e.alias ?? ""}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [entries, runsHere, capability, query]);

  const local = useMemo(() => sortEntries(filtered.filter((e) => e.kind === "local"), sort), [filtered, sort]);
  const cloud = useMemo(() => sortEntries(filtered.filter((e) => e.kind === "cloud"), sort), [filtered, sort]);
  const rows = lane === "local" ? local : cloud;
  const compatibleDownloads = entries.filter(
    (entry) => entry.kind === "local" && entry.status === "available" && (entry.runsHere || entry.runsElsewhere),
  ).length;
  const activeDownloads = (data?.downloads ?? []).filter((download) => download.status === "running").length;

  // Resolved from the live payload rather than held as an object, so an open
  // panel keeps updating — a download's progress and a service coming up both
  // land here without the panel going stale behind the list.
  const selected = selectedKey ? entries.find((e) => e.key === selectedKey) ?? null : null;

  if (loading) return <p className="text-sm text-gray-500 py-16 text-center">Reading the machine…</p>;
  if (!data) return <p className="text-sm text-gray-500 py-16 text-center">Models unavailable.</p>;

  return (
    <div className="tool-page models-page space-y-5">
      <ToolPageHeader
        eyebrow="Model setup"
        title="Discover and set up models"
        description="Choose a capability, compare models that fit your hardware, download the weights, and connect the service."
        icon={<Circuitry size={24} weight="duotone" />}
        meta={
          <span className={`tool-page-chip ${data.routerUp ? "is-ready" : "is-offline"}`}>
            {data.routerUp ? "Router online" : "Router offline"}
          </span>
        }
      />

      <section className="overflow-hidden rounded-2xl border border-orange-500/25 bg-gradient-to-br from-orange-500/[0.08] via-gray-900 to-gray-900">
        <div className="grid gap-5 p-5 lg:grid-cols-[minmax(0,1fr)_280px] lg:p-6">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-orange-300">Set up a capability</p>
            <h2 className="mt-1 text-xl font-semibold text-gray-100">What should this machine learn to do?</h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-gray-400">
              Start with the job, not a model name. Hangar narrows the library to models that fit a machine you own and shows the real download before it starts.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {SETUP_CAPABILITIES.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => startLocalSetup(id)}
                  className="inline-flex items-center gap-2 rounded-lg border border-gray-700 bg-gray-950/45 px-3 py-2 text-xs font-medium text-gray-200 transition hover:border-orange-400/60 hover:bg-orange-500/10 hover:text-white"
                >
                  <Icon size={15} weight="duotone" className="text-orange-300" />
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 self-start text-left text-xs">
            <button
              type="button"
              onClick={() => startLocalSetup()}
              className="col-span-2 rounded-xl border border-sky-500/25 bg-sky-500/[0.07] p-3 transition hover:border-sky-400/50"
            >
              <span className="flex items-center gap-2 font-semibold text-sky-200"><CloudArrowDown size={16} /> Browse compatible downloads</span>
              <span className="mt-1 block text-[11px] text-gray-500">{compatibleDownloads} suggested now{activeDownloads ? ` · ${activeDownloads} downloading` : ""}</span>
            </button>
            <button
              type="button"
              onClick={() => { setLane("local"); setRunsHere(false); setCapability(null); setView("cards"); }}
              className="rounded-xl border border-gray-800 bg-gray-950/40 p-3 text-gray-300 transition hover:border-gray-600"
            >
              <span className="font-medium">Explore all</span>
              <span className="mt-1 block text-[10px] text-gray-600">Include models that need other hardware</span>
            </button>
            <button
              type="button"
              onClick={() => { setLane("cloud"); setRunsHere(false); setCapability(null); setView("cards"); }}
              className="rounded-xl border border-gray-800 bg-gray-950/40 p-3 text-gray-300 transition hover:border-gray-600"
            >
              <span className="flex items-center gap-1 font-medium"><Cloud size={13} /> Connect cloud</span>
              <span className="mt-1 block text-[10px] text-gray-600">Use provider models instead</span>
            </button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-gray-800 bg-gray-950/25 px-5 py-3 text-[11px] text-gray-500 lg:px-6">
          <span><strong className="text-gray-300">1.</strong> Choose a capability</span>
          <ArrowRight size={11} className="hidden text-gray-700 sm:block" />
          <span><strong className="text-gray-300">2.</strong> Review fit and download size</span>
          <ArrowRight size={11} className="hidden text-gray-700 sm:block" />
          <span><strong className="text-gray-300">3.</strong> Download and connect its runtime</span>
          <ArrowRight size={11} className="hidden text-gray-700 sm:block" />
          <span><strong className="text-gray-300">4.</strong> Make it active</span>
        </div>
      </section>

      <MachineStrip
        machine={data.machine}
        occupants={data.occupants}
        leaderboard={data.leaderboard}
        machines={data.machines}
        onRefresh={() => refresh(true)}
      />

      <RouteStrip
        capabilities={data.capabilities}
        routing={data.routing}
        catalogue={data.catalogue}
        selected={capability}
        onSelect={(c) => setCapability((prev) => (prev === c ? null : c))}
      />

      <HubModelSearch
        busy={busy}
        diskFreeGb={data.machine.weightsDiskFreeGb}
        initialQuery={hubSearchIntent}
        onDownload={(repo) =>
          act("/api/scout", { action: "download", repo }, `dl:${repo}`, `Downloading ${repo}.`)
        }
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
        otherHosts={otherHosts}
        onRunsHere={setRunsHere}
        query={query}
        onQuery={setQuery}
        capability={capability}
        onClearCapability={() => setCapability(null)}
        hiddenCount={entries.length - filtered.length}
        unwired={data.discovery.reduce((n, p) => n + p.models.filter((m) => !m.wiredAs).length, 0)}
        busy={busy}
        onWireAll={() =>
          act("/api/scout", { action: "wire-all" }, "wire-all", "Every cloud model your providers offer is now wired.")
        }
      />

      <div id="model-results" className="scroll-mt-36 flex items-center gap-2 flex-wrap">
        <LaneTabs lane={lane} onLane={setLane} localCount={local.length} cloudCount={cloud.length} />
        <span className="text-[11px] text-gray-600 leading-relaxed hidden sm:inline">
          {lane === "local"
            ? "Sizes are what they cost on this card; downloads land on the weights drive."
            : "Runs on the provider's hardware — money per call, no local memory."}
        </span>
        <span className="ml-auto">
          <ViewToggle view={view} onView={setView} />
        </span>
      </div>

      <div>
        <div className="min-w-0">
          {view === "list" ? (
            <ModelTable
              entries={rows}
              tone={lane}
              limit={limit}
              sort={sort}
              onSort={setSort}
              selectedKey={selected?.key}
              onSelect={(e) => setSelectedKey((k) => (k === e.key ? null : e.key))}
              onMore={() => setLimit((n) => n + 24)}
            />
          ) : (
            <Lane
              subtitle=""
              tone={lane}
              entries={rows}
              limit={limit}
              busy={busy}
              capabilities={data.capabilities}
              onMore={() => setLimit((n) => n + 24)}
              onUse={use}
              onService={(id, action) =>
                act(`/api/services/${id}`, { action }, `svc:${id}:${action}`, `${id} ${action}ed.`)
              }
              onDownload={(repo) =>
                act("/api/scout", { action: "download", repo }, `dl:${repo}`, `Downloading ${repo}.`)
              }
              onCancelDownload={(repo) =>
                act("/api/scout", { action: "cancel-download", repo }, `dl:${repo}`, `Cancelled ${repo}.`)
              }
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
          )}
        </div>

        {selected && (
          <DetailPanel
            e={selected}
            busy={busy}
            capabilities={data.capabilities}
            reportDate={data.report.generatedAt}
            reportStale={data.report.stale}
            onClose={() => setSelectedKey(null)}
            onUse={use}
            onService={(id, action) =>
              act(`/api/services/${id}`, { action }, `svc:${id}:${action}`, `${id} ${action}ed.`)
            }
            onDownload={(repo) => act("/api/scout", { action: "download", repo }, `dl:${repo}`, `Downloading ${repo}.`)}
            onCancelDownload={(repo) =>
              act("/api/scout", { action: "cancel-download", repo }, `dl:${repo}`, `Cancelled ${repo}.`)
            }
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
        )}
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
