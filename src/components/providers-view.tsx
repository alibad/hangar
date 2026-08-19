"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import ModelFootprint, { type Footprint } from "./model-footprint";
import ModelScoutView from "./model-scout-view";
import { ServiceControl, ServiceControls, ServiceStartupNote, useServiceLifecycle } from "./service-control";
import { ToolPageHeader } from "./tool-page";
import { Circuitry } from "@phosphor-icons/react";
import { useLiveRefresh } from "@/lib/use-live-refresh";

type ModelStatus = "ready" | "no-key" | "service-stopped" | "router-offline";

type CatalogModel = {
  id: string;
  target: string;
  provider: string;
  mode: string;
  local: boolean;
  serviceId?: string;
  keyEnv?: string;
  status: ModelStatus;
  detail?: string;
  costPerImage?: number;
  costPerMTokIn?: number;
  costPerMTokOut?: number;
  checkpoint?: string;
  params?: string;
  released?: string;
  docs?: string;
  paper?: string;
  note?: string;
  footprint?: Footprint;
};

type BenchmarkLink = { label: string; url: string };

type CapabilityDef = { id: string; label: string; modes: readonly string[]; hint: string };

type Payload = {
  routerUp: boolean;
  models: CatalogModel[];
  routing: Record<string, string>;
  capabilities: CapabilityDef[];
  benchmarks: Record<string, BenchmarkLink>;
};

const PROVIDER_STYLE: Record<string, string> = {
  openai: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  gemini: "bg-blue-500/15 text-blue-300 border-blue-500/30",
  anthropic: "bg-orange-500/15 text-orange-300 border-orange-500/30",
};
function providerStyle(p: string, local: boolean) {
  if (local) return "bg-violet-500/15 text-violet-300 border-violet-500/30";
  return PROVIDER_STYLE[p] ?? "bg-gray-600/20 text-gray-400 border-gray-600/40";
}

const STATUS_LABEL: Record<ModelStatus, string> = {
  "ready": "ready",
  "no-key": "no key configured",
  "service-stopped": "service stopped",
  "router-offline": "router offline",
};
const STATUS_STYLE: Record<ModelStatus, string> = {
  "ready": "bg-green-500/10 text-green-400",
  "no-key": "bg-amber-500/10 text-amber-400",
  "service-stopped": "bg-red-500/10 text-red-400",
  "router-offline": "bg-red-500/10 text-red-400",
};

function fmtCost(m: CatalogModel): string | null {
  if (m.local) return "free · local";
  if (m.mode === "image_generation") {
    return m.costPerImage ? `~$${m.costPerImage.toFixed(3)}/image` : "metered";
  }
  if (m.costPerMTokIn || m.costPerMTokOut) {
    return `$${(m.costPerMTokIn ?? 0).toFixed(2)} in · $${(m.costPerMTokOut ?? 0).toFixed(2)} out /Mtok`;
  }
  return "metered";
}

export default function ProvidersView() {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);   // model id being switched
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [selectedCapability, setSelectedCapability] = useState("text");
  /**
   * Two questions, deliberately separated. "Which model serves this capability"
   * is a decision about what is already here; "what exists that I'm not using"
   * is a different one, with a different rhythm — you make it every few weeks,
   * not every session. Stacking both on one scroll buried the routing controls.
   */
  const [view, setView] = useState<"routing" | "scout">("routing");

  // Resolves to whether the router is up, so the lifecycle control can poll it.
  const refresh = useCallback(async (): Promise<boolean> => {
    let up = false;
    try {
      const res = await fetch("/api/providers");
      const payload: Payload = await res.json();
      setData(payload);
      up = !!payload.routerUp;
    } catch {
      /* keep the last good view */
    }
    setLoading(false);
    return up;
  }, []);

  useLiveRefresh(refresh, { intervalMs: 10000 });

  const routerLifecycle = useServiceLifecycle("ai-router", data?.routerUp, refresh);

  const setActive = useCallback(async (capability: string, model: CatalogModel) => {
    setBusy(model.id);
    setMsg(null);
    try {
      if (model.status === "service-stopped" && model.serviceId) {
        setMsg({ text: `Starting ${model.id} and waiting for a healthy model endpoint…` });
        const start = await fetch(`/api/services/${model.serviceId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "start" }),
        });
        const startPayload = await start.json();
        if (!start.ok || startPayload.error) throw new Error(startPayload.error || `Service manager returned ${start.status}`);

        const deadline = Date.now() + 60_000;
        let ready = false;
        while (!ready && Date.now() < deadline) {
          await new Promise((resolve) => window.setTimeout(resolve, 1000));
          const payload: Payload = await fetch("/api/providers", { cache: "no-store" }).then((response) => response.json());
          setData(payload);
          ready = payload.models.some((item) => item.id === model.id && item.status === "ready");
        }
        if (!ready) throw new Error(`${model.id} did not become healthy within 60 seconds`);
        setMsg({ text: `${model.id} is healthy. Applying the ${capability} route…` });
      }

      const res = await fetch("/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [capability]: model.id }),
      });
      const j = await res.json();
      if (!res.ok || j.error) throw new Error(j.error || `Router returned ${res.status}`);
      setMsg({ text: `${capability} → ${model.id}. The route is ready.` });
      await refresh();
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : String(e), bad: true });
    }
    setBusy(null);
    setTimeout(() => setMsg(null), 5000);
  }, [refresh]);

  /**
   * Re-read the catalogue and report whether this service's models became usable.
   * Feeds the shared lifecycle control on each local model card, which is what
   * turns "service-stopped" into something you can act on from this tab.
   */
  const probeService = useCallback(async (serviceId: string): Promise<boolean> => {
    try {
      const payload: Payload = await fetch("/api/providers").then((r) => r.json());
      setData(payload);
      return payload.models.some((m) => m.serviceId === serviceId && m.status === "ready");
    } catch {
      return false;
    }
  }, []);

  /** One bucket per capability, matched on the modes that capability accepts. */
  const grouped = useMemo(() => {
    const models = data?.models ?? [];
    return (data?.capabilities ?? []).map((cap) => ({
      cap,
      models: models.filter((m) => cap.modes.includes(m.mode)),
    }));
  }, [data]);

  useEffect(() => {
    const capabilities = data?.capabilities ?? [];
    if (capabilities.length && !capabilities.some((cap) => cap.id === selectedCapability)) {
      setSelectedCapability(capabilities[0].id);
    }
  }, [data, selectedCapability]);

  const selectedGroup = grouped.find(({ cap }) => cap.id === selectedCapability) ?? grouped[0];

  if (loading) return <p className="text-sm text-gray-500 py-12 text-center">Loading models…</p>;

  const routerUp = data?.routerUp ?? false;

  return (
    <div className="tool-page models-page space-y-6">
      <ToolPageHeader
        eyebrow="Routing control"
        title="Models"
        description="See every local and cloud alias, understand why it is available, and route each capability independently."
        icon={<Circuitry size={24} weight="duotone" />}
        meta={<span className={`tool-page-chip ${routerUp ? "is-ready" : "is-offline"}`}>{routerUp ? "Router online" : "Router offline"}</span>}
      />

      <div className="inline-flex rounded-lg border border-gray-800 bg-gray-900 p-0.5" role="tablist" aria-label="Models view">
        {([
          ["routing", "Routing", "Which model serves each capability"],
          ["scout", "Scout", "What exists that this box isn't using"],
        ] as const).map(([id, label, hint]) => (
          <button
            key={id}
            role="tab"
            aria-selected={view === id}
            title={hint}
            onClick={() => setView(id)}
            className={`text-[11px] px-3 py-1.5 rounded-md transition cursor-pointer ${
              view === id ? "bg-indigo-500/15 text-indigo-200" : "text-gray-500 hover:text-gray-300"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {view === "scout" && <ModelScoutView />}

      {view === "routing" && (
        <>
      {/* header */}
      <section className="tool-panel models-router-panel bg-gray-900 rounded-xl border border-gray-800 p-4">
        <div className="flex items-center gap-3 flex-wrap">
          <span className={`w-2.5 h-2.5 rounded-full ${routerUp ? "bg-green-500" : "bg-red-500 animate-pulse"}`} />
          <span className="font-semibold text-sm">AI Router</span>
          <span className="text-xs text-gray-500">127.0.0.1:4000</span>
          <span className={`text-[11px] px-2 py-0.5 rounded-full ${routerUp ? "bg-green-500/10 text-green-400" : "bg-red-500/10 text-red-400"}`}>
            {routerUp ? "running" : "offline"}
          </span>
          <span className="text-[11px] text-gray-600 ml-auto">local-only · never exposed off-box</span>
          {/* The router gates this whole tab, so its own lifecycle belongs here. */}
          <ServiceControls
            lifecycle={routerLifecycle}
            onRefresh={refresh}
            confirmStop="Stopping the AI Router disables model routing for every local console caller until it returns."
          />
        </div>
        <p className="text-[11px] text-gray-600 mt-2 leading-relaxed">
          One OpenAI-compatible gateway for every model this box can reach. Aliases are defined in{" "}
          <span className="font-mono text-gray-500">config/ai-router.yaml</span> — the only place vendor model ids are written.
          {" "}Cloud projects call vendors directly and must not route through here.
        </p>
        <ServiceStartupNote
          lifecycle={routerLifecycle}
          downMessage="Router is down, so no model can be resolved."
          className="mt-2"
        />
        {/* Outside benchmarks — this console measures cost and latency, not quality. */}
        {data?.benchmarks && Object.keys(data.benchmarks).length > 0 && (
          <div className="flex items-center gap-3 flex-wrap mt-3 pt-2 border-t border-gray-800">
            <span className="text-[10px] text-gray-600 uppercase tracking-wide">Leaderboards</span>
            {Object.entries(data.benchmarks).map(([k, b]) => (
              <a key={k} href={b.url} target="_blank" rel="noreferrer"
                 className="text-[11px] text-indigo-400 hover:text-indigo-300 underline underline-offset-2"
                 title={b.label}>
                {k} ↗
              </a>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3" aria-label="Active model routing">
        <div>
          <h2 className="text-sm font-semibold text-gray-200">Active routing</h2>
          <p className="text-[11px] text-gray-600">Choose a capability to inspect or change its model. Each context is independent.</p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          {grouped.map(({ cap, models }) => {
            const active = data?.routing?.[cap.id];
            const model = models.find((item) => item.id === active);
            const selected = cap.id === selectedCapability;
            return (
              <button
                type="button"
                key={cap.id}
                onClick={() => setSelectedCapability(cap.id)}
                aria-pressed={selected}
                className={`rounded-xl border p-3 text-left transition ${selected ? "border-indigo-500/60 bg-indigo-500/10" : "border-gray-800 bg-gray-900 hover:border-gray-600"}`}
              >
                <span className="block text-[10px] font-medium uppercase tracking-wide text-gray-500">{cap.label}</span>
                <span className="mt-1 block truncate text-sm font-semibold text-gray-100" title={active}>{active ?? "not selected"}</span>
                <span className={`mt-1 inline-flex rounded-full px-1.5 py-0.5 text-[10px] ${model ? STATUS_STYLE[model.status] : "bg-gray-800 text-gray-500"}`}>
                  {model ? STATUS_LABEL[model.status] : "unresolved"}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {msg && (
        <div role="status" aria-live="polite" className={`text-xs rounded-lg px-3 py-2 ${msg.bad ? "bg-red-500/10 text-red-400" : "bg-green-500/10 text-green-400"}`}>
          {msg.text}
        </div>
      )}

      {selectedGroup && (
        <Group
          key={selectedGroup.cap.id}
          title={selectedGroup.cap.label}
          subtitle={selectedGroup.cap.hint}
          capability={selectedGroup.cap.id}
          models={selectedGroup.models}
          active={data?.routing?.[selectedGroup.cap.id]}
          busy={busy}
          onSelect={setActive}
          onProbeService={probeService}
        />
      )}
        </>
      )}
    </div>
  );
}

function Group({
  title, subtitle, capability, models, active, busy, onSelect, onProbeService,
}: {
  title: string;
  subtitle: string;
  capability: string;
  models: CatalogModel[];
  active?: string;
  busy: string | null;
  onSelect: (c: string, model: CatalogModel) => void;
  onProbeService: (serviceId: string) => Promise<boolean>;
}) {
  return (
    <section className="space-y-2">
      <div>
        <h3 className="text-sm font-semibold text-gray-200">{title}</h3>
        <p className="text-[11px] text-gray-600">{subtitle}</p>
      </div>
      {models.length === 0 ? (
        <p className="text-xs text-gray-600 py-4">No {title.toLowerCase()} models registered.</p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {models.map((m) => {
            const isActive = m.id === active;
            const canActivate = m.status === "ready" || m.status === "service-stopped";
            return (
              <div
                key={m.id}
                className={`rounded-xl border p-3 space-y-2 transition ${
                  isActive ? "border-indigo-500/60 bg-indigo-500/5" : "border-gray-800 bg-gray-900"
                }`}
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-sm text-gray-100">{m.id}</span>
                  {isActive && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300">active</span>
                  )}
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ml-auto ${providerStyle(m.provider, m.local)}`}>
                    {m.local ? "local" : m.provider}
                  </span>
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${STATUS_STYLE[m.status]}`}>
                    {STATUS_LABEL[m.status]}
                  </span>
                  <span className="text-[10px] text-gray-600">{fmtCost(m)}</span>
                </div>

                {/* What this alias actually resolves to, and how big it is. */}
                <p
                  className="text-[10px] text-gray-600 font-mono truncate"
                  title={m.checkpoint ? `${m.checkpoint}  (routed as ${m.target})` : m.target}
                >
                  {m.checkpoint ?? m.target}
                </p>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {m.params && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-800 text-gray-300 font-medium">
                      {m.params}
                    </span>
                  )}
                  {/* What it costs to have running — the deciding factor on one card. */}
                  <ModelFootprint footprint={m.footprint} local={m.local} />
                  {m.released && <span className="text-[10px] text-gray-600">released {m.released}</span>}
                </div>

                {/* The whole point: never fail silently — say exactly what's missing. */}
                {m.detail && (
                  <p className="text-[10px] text-amber-400/80 leading-relaxed">{m.detail}</p>
                )}
                {m.note && <p className="text-[10px] text-gray-500 leading-relaxed">{m.note}</p>}
                {m.status === "service-stopped" && !isActive && (
                  <p className="rounded-md border border-amber-500/20 bg-amber-500/5 px-2 py-1.5 text-[10px] leading-relaxed text-amber-200/80">
                    Cold start required. The console will wait for health before changing the route; configured memory reserves still apply.
                  </p>
                )}

                {(m.docs || m.paper) && (
                  <div className="flex items-center gap-2 text-[10px]">
                    {m.docs && (
                      <a href={m.docs} target="_blank" rel="noreferrer"
                         className="text-indigo-400 hover:text-indigo-300 underline underline-offset-2">
                        docs ↗
                      </a>
                    )}
                    {m.paper && (
                      <a href={m.paper} target="_blank" rel="noreferrer"
                         className="text-indigo-400 hover:text-indigo-300 underline underline-offset-2">
                        paper ↗
                      </a>
                    )}
                  </div>
                )}

                <div className="flex items-center gap-2 pt-1">
                  {/* Local models get their full lifecycle here — a running one can
                      also be stopped or restarted, not only started when down. */}
                  {m.serviceId && (isActive || m.status === "ready") && (
                    <ServiceControl
                      id={m.serviceId}
                      up={m.status === "ready"}
                      probe={() => onProbeService(m.serviceId!)}
                    />
                  )}
                  {!isActive && (
                    <button
                      onClick={() => onSelect(capability, m)}
                      disabled={busy === m.id || !canActivate}
                      title={!canActivate ? STATUS_LABEL[m.status] : m.status === "service-stopped" ? "Start the service, wait for health, then apply this route" : "Apply this route"}
                      className="text-[11px] text-gray-300 hover:text-white border border-gray-700 hover:border-gray-500 rounded-md px-2 py-1 transition disabled:opacity-50 cursor-pointer ml-auto"
                    >
                      {busy === m.id ? "Working…" : m.status === "service-stopped" ? "Start and use" : "Use"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
