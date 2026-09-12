"use client";

import { useMemo, useState } from "react";
import {
  ArrowRight,
  ArrowSquareOut,
  Browser,
  ChartLineUp,
  CheckCircle,
  CircleNotch,
  Cpu,
  MagnifyingGlass,
  Play,
  PlugsConnected,
  Stop,
  WarningCircle,
} from "@phosphor-icons/react";
import type { ConsoleTab } from "@/components/command-palette";
import type { Footprint } from "@/components/model-footprint";
import { ServiceLogsButton } from "@/components/service-control";
import { SERVICE_REGISTRY } from "@/lib/services";
import { useFootprintEstimates } from "@/lib/use-local-footprints";

type ManagedService = {
  id: string;
  name: string;
  type: string;
  port: number;
  category: string;
  status: string;
  healthy: boolean;
  pid: number | null;
  log_tail: string[];
  error?: string | null;
  owner?: "manager" | "external" | null;
};

type CatalogEntry = { id: string; mode: string; params?: string };

type Props = {
  services: ManagedService[];
  catalogByService: Record<string, CatalogEntry[]>;
  serviceVram: Record<string, { used_mb: number }>;
  serviceRam: Record<string, { rss_mb: number }>;
  actionInProgress: { id: string; action: "start" | "stop" | "restart" } | null;
  actionMessage: { id: string; text: string; type: "success" | "error" } | null;
  onDismissActionMessage: (id: string) => void;
  onServiceAction: (id: string, action: "start" | "stop" | "restart") => void;
  onSelectTab: (tab: ConsoleTab) => void;
};

type Filter = "all" | "running" | "ondemand" | "attention";

const descriptions: Record<string, string> = {
  manager: "Starts, stops, and supervises every managed process on this machine.",
  vllm: "High-capacity local coding and reasoning model server.",
  "vllm-small": "Fast resident local model for responsive chat and utility work.",
  whisper: "Local speech-to-text transcription endpoint.",
  tts: "Local Kokoro speech synthesis endpoint.",
  webui: "Browser workspace for direct conversations with local models.",
  grafana: "Operational dashboards for the complete BeTenshi stack.",
  prometheus: "Metrics collection and time-series query service.",
  qwen: "Local image generation and editing service.",
  comfyui: "Node-based image workflow application.",
  sam3d: "Single-image human mesh and pose recovery.",
  sam3: "Open-vocabulary segmentation and video tracking.",
  "ai-router": "One OpenAI-compatible gateway for local and cloud models.",
};

const filterLabels: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "All services" },
  { id: "running", label: "Running" },
  { id: "ondemand", label: "On demand" },
  { id: "attention", label: "Needs attention" },
];

const serviceDestinations: Partial<Record<string, { tab: ConsoleTab; label: string }>> = {
  vllm: { tab: "llm", label: "Open chat" },
  "vllm-small": { tab: "llm", label: "Open chat" },
  whisper: { tab: "speech", label: "Open speech" },
  tts: { tab: "speech", label: "Open speech" },
  qwen: { tab: "qwen", label: "Open studio" },
  sam3d: { tab: "sam3d", label: "Open 3D Body" },
  sam3: { tab: "sam3", label: "Open Segment" },
  "ai-router": { tab: "models", label: "View routing" },
};

export default function ServicesControlCenter({ services, catalogByService, serviceVram, serviceRam, actionInProgress, actionMessage, onDismissActionMessage, onServiceAction, onSelectTab }: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  // Estimates only — live VRAM/RAM arrive as props from the parent's /api/gpu poll.
  const footprints = useFootprintEstimates();
  const counts = useMemo(() => ({
    ready: services.filter((service) => service.status === "running" && service.healthy).length,
    ondemand: services.filter((service) => service.status !== "running" && service.status !== "failed" && service.owner !== "external").length,
    attention: services.filter((service) => service.status === "failed" || (service.status === "running" && !service.healthy) || service.owner === "external").length,
    gpu: services.filter((service) => (serviceVram[service.id]?.used_mb ?? 0) > 0).length,
  }), [services, serviceVram]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return services.filter((service) => {
      const matchesFilter = filter === "all"
        || (filter === "running" && service.status === "running")
        || (filter === "ondemand" && service.status !== "running" && service.status !== "failed" && service.owner !== "external")
        || (filter === "attention" && (service.status === "failed" || service.owner === "external"));
      const models = catalogByService[service.id]?.map((item) => item.id).join(" ") ?? "";
      const matchesQuery = !needle || `${service.name} ${service.id} ${service.type} ${service.category} ${models}`.toLowerCase().includes(needle);
      return matchesFilter && matchesQuery;
    });
  }, [catalogByService, filter, query, services]);

  return (
    <div className="services-center space-y-4">
      <section className="services-hero cockpit-surface overflow-hidden rounded-2xl border border-gray-800 bg-gray-900/75">
        <div className="flex flex-col gap-5 px-5 py-5 sm:px-6 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-orange-300">Local infrastructure</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-[-0.025em] text-gray-100 sm:text-3xl">Services control center</h1>
            <p className="mt-1 max-w-2xl text-sm text-gray-500">Understand what each service does, inspect its footprint, and control it without hunting through Home.</p>
          </div>
          <label className="services-search flex h-10 w-full items-center gap-2 rounded-xl border border-gray-800 bg-gray-950/55 px-3 text-gray-500 transition focus-within:border-orange-500/50 lg:w-80">
            <MagnifyingGlass size={16} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search services or models" aria-label="Search services or models" className="min-w-0 flex-1 bg-transparent text-sm text-gray-100 outline-none placeholder:text-gray-600" />
          </label>
        </div>

        <div className="grid grid-cols-2 border-t border-gray-800 sm:grid-cols-4">
          <SummaryStat label="Ready now" value={`${counts.ready}/${services.length}`} hint="healthy processes" tone="good" />
          <SummaryStat label="On demand" value={String(counts.ondemand)} hint="ready to start" />
          <SummaryStat label="Needs attention" value={String(counts.attention)} hint={counts.attention ? "review now" : "no active issues"} tone={counts.attention ? "warn" : "good"} />
          <SummaryStat label="Using GPU" value={String(counts.gpu)} hint="resident footprints" />
        </div>
      </section>

      <section className="cockpit-surface overflow-hidden rounded-2xl border border-gray-800 bg-gray-900/75">
        <div className="services-toolbar flex flex-col gap-3 border-b border-gray-800 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <div className="flex flex-wrap gap-1.5" aria-label="Filter services">
            {filterLabels.map((item) => (
              <button key={item.id} type="button" onClick={() => setFilter(item.id)} aria-pressed={filter === item.id} className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${filter === item.id ? "services-filter-active border-orange-500/45 bg-orange-500/10 text-orange-200" : "border-gray-800 text-gray-500 hover:border-gray-600 hover:text-gray-200"}`}>
                {item.label}
              </button>
            ))}
          </div>
          <span className="text-[11px] tabular-nums text-gray-500">Showing {shown.length} of {services.length}</span>
        </div>

        {shown.length ? (
          /* Cards used to be separated by `gap-px` over a tinted container, so
             the container's own background showed through the gaps as hairline
             dividers. That trick has no answer for a part-filled last row: the
             unused cells are not covered by a card, so the full container
             background showed as a solid slab beside the final service. Real
             borders and a real gap draw the same separation without needing
             anything to bleed through. */
          <div className="grid gap-3 p-3 md:grid-cols-2 sm:p-4 xl:grid-cols-3">
            {shown.map((service) => (
              <ServiceCard
                key={service.id}
                service={service}
                models={catalogByService[service.id] ?? []}
                footprint={footprints.get(service.id)}
                vramMb={serviceVram[service.id]?.used_mb ?? null}
                ramMb={serviceRam[service.id]?.rss_mb ?? null}
                busyAction={actionInProgress?.id === service.id ? actionInProgress.action : null}
                feedback={actionMessage?.id === service.id ? actionMessage : null}
                onDismissFeedback={() => onDismissActionMessage(service.id)}
                onAction={onServiceAction}
                onSelectTab={onSelectTab}
              />
            ))}
          </div>
        ) : (
          <div className="px-6 py-16 text-center">
            <MagnifyingGlass size={24} className="mx-auto text-gray-700" />
            <p className="mt-3 text-sm font-medium text-gray-300">No services match this view</p>
            <button type="button" onClick={() => { setFilter("all"); setQuery(""); }} className="mt-2 text-xs text-orange-300 hover:text-orange-200">Clear filters</button>
          </div>
        )}
      </section>
    </div>
  );
}

function SummaryStat({ label, value, hint, tone = "neutral" }: { label: string; value: string; hint: string; tone?: "neutral" | "good" | "warn" }) {
  return (
    <span className="services-stat border-r border-t border-gray-800 px-5 py-3 first:border-l-0 sm:border-t-0">
      <span className="block text-[9px] font-semibold uppercase tracking-wider text-gray-600">{label}</span>
      <span className={`mt-0.5 block text-xl font-semibold tabular-nums ${tone === "good" ? "text-emerald-300" : tone === "warn" ? "text-amber-300" : "text-gray-100"}`}>{value}</span>
      <span className="block text-[10px] text-gray-500">{hint}</span>
    </span>
  );
}

const criticalStopImpact: Record<string, string> = {
  "ai-router": "Model routing and every local console caller will be unavailable until the router returns.",
  manager: "The console will lose the ability to start, stop, and supervise managed services.",
};

function fmtGb(gb: number) {
  // Sub-GB services (Kokoro at 0.4) would otherwise all read "0 GB".
  return gb < 1 ? `${Math.round(gb * 1000)} MB` : `${gb % 1 === 0 ? gb : gb.toFixed(1)} GB`;
}

function fmtMb(mb: number) {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

/**
 * What it should cost, next to what it is costing.
 *
 * The card used to show the measured number alone, and only when it was
 * non-zero — so a stopped service showed nothing at all, which is exactly when
 * you most need to know what starting it will take. A measured number on its own
 * also can't be judged: Qwen-Image idling at 0.1 GB VRAM against a 20.3 GB peak
 * is healthy and expected, while vLLM sitting near zero against a 22.9 GB
 * startup reservation means it never claimed the card. Same reading, opposite
 * conclusions — the estimate is what tells them apart, so both are shown.
 *
 * The bar is deliberately not a "usage" gauge. It reads actual against estimate,
 * so a full bar means the service has reached the footprint we predicted, not
 * that it is running out of anything.
 */
function FootprintMeter({ label, estGb, actualMb, running, kind, basis }: {
  label: string;
  estGb?: number;
  /** null means NO reading is available — which is not the same as a reading of zero. */
  actualMb: number | null;
  running: boolean;
  kind?: "reserved" | "peak" | "estimate";
  basis?: string;
}) {
  const hasEst = typeof estGb === "number" && estGb > 0;
  const measured = typeof actualMb === "number";
  if (!hasEst && !measured) return null;

  // Only a real reading drives the bar. An unmeasurable service must not render
  // as an empty bar — that is the same picture as "using nothing".
  const pct = hasEst && measured && actualMb! > 0 ? Math.min(100, (actualMb! / 1024 / estGb!) * 100) : 0;
  const overEstimate = hasEst && measured && actualMb! / 1024 > estGb! * 1.05;
  const estNote = kind === "peak"
    ? "a transient peak while working — idling well under it is normal"
    : "reserved at startup and held, so a running service should sit near it";

  const reading = !measured
    ? (running ? "not measurable" : "—")
    : actualMb! > 0 ? fmtMb(actualMb!) : "~0";

  return (
    <div
      className="min-w-0"
      title={[
        hasEst ? `Estimated ~${fmtGb(estGb!)}: ${estNote}.` : "No sourced estimate for this service — showing the measured value only.",
        !measured
          ? (running
              ? "Running, but Windows reports no per-service figure for it: containerised services are pooled into the WSL VM, which WDDM cannot split by container. Unknown, not zero."
              : "Not running, so there is nothing to measure.")
          : `Measured now: ${fmtMb(actualMb!)}.`,
        overEstimate ? `That is above the estimate — worth re-checking the figure in model-meta.json.` : null,
        basis,
      ].filter(Boolean).join("\n\n")}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[9px] font-semibold uppercase tracking-wider text-gray-600">{label}</span>
        <span className="truncate text-[10px] tabular-nums">
          {measured && actualMb! > 0
            ? <span className={`font-semibold ${overEstimate ? "text-amber-300" : "text-gray-200"}`}>{fmtMb(actualMb!)}</span>
            : <span className={measured ? "text-gray-500" : "text-gray-600 italic"}>{reading}</span>}
          {hasEst && <span className="text-gray-600"> / ~{fmtGb(estGb!)}</span>}
        </span>
      </div>
      {hasEst && (
        <div className="mt-1 h-1 overflow-hidden rounded-full bg-gray-800">
          {measured ? (
            <div
              className={`h-full rounded-full ${overEstimate ? "bg-amber-400" : pct >= 92 ? "bg-amber-400" : "bg-orange-400"}`}
              // A hair of width so a small-but-real reading is still visible.
              style={{ width: `${pct > 0 ? Math.max(2, pct) : 0}%` }}
            />
          ) : (
            // Hatched rather than empty: unknown has to look different from none.
            <div className="h-full w-full opacity-40 [background:repeating-linear-gradient(135deg,currentColor_0_3px,transparent_3px_6px)] text-gray-600" />
          )}
        </div>
      )}
    </div>
  );
}

function ServiceCard({ service, models, footprint, vramMb, ramMb, busyAction, feedback, onDismissFeedback, onAction, onSelectTab }: {
  service: ManagedService;
  models: CatalogEntry[];
  footprint?: Footprint;
  vramMb: number | null;
  ramMb: number | null;
  busyAction: "start" | "stop" | "restart" | null;
  feedback: { text: string; type: "success" | "error" } | null;
  onDismissFeedback: () => void;
  onAction: (id: string, action: "start" | "stop" | "restart") => void;
  onSelectTab: (tab: ConsoleTab) => void;
}) {
  const [confirmStop, setConfirmStop] = useState(false);
  const registry = SERVICE_REGISTRY.find((item) => item.id === service.id);
  const running = service.status === "running";
  const attention = service.status === "failed" || service.owner === "external";
  const Icon = service.category === "app" ? Browser : service.category === "monitoring" ? ChartLineUp : Cpu;
  const endpointLabel = service.category === "app" ? "Open app" : service.category === "monitoring" ? "Open dashboard" : "Open endpoint";
  const destination = serviceDestinations[service.id];
  const latestLog = service.log_tail?.at(-1)?.replace(/^\[[\d\-T:.Z]+\]\s*/, "").slice(0, 90);

  return (
    <article className="services-card flex min-h-52 flex-col rounded-xl border border-gray-800 bg-gray-900 px-4 py-4 sm:px-5">
      <div className="flex items-start gap-3">
        <span className={`services-card-icon flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border ${attention ? "border-red-500/30 bg-red-500/10 text-red-300" : running ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-300" : "border-gray-700 bg-gray-800 text-gray-500"}`}>
          <Icon size={18} weight="duotone" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-start justify-between gap-2">
            <span className="truncate text-sm font-semibold text-gray-100">{service.name}</span>
            <StatusPill running={running} healthy={service.healthy} attention={attention} status={service.status} />
          </span>
          <span className="mt-0.5 block text-[10px] capitalize text-gray-600">{service.category} · localhost:{service.port}{service.owner === "external" ? " · external process" : ""}</span>
        </span>
      </div>

      <p className="mt-3 min-h-8 text-[11px] leading-4 text-gray-500">{descriptions[service.id] ?? service.type}</p>

      {(footprint?.vramGb || footprint?.ramGb || (vramMb ?? 0) > 0 || (ramMb ?? 0) > 0) && (
        <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2">
          <FootprintMeter label="VRAM" estGb={footprint?.vramGb} actualMb={vramMb} running={running} kind={footprint?.kind} basis={footprint?.basis} />
          <FootprintMeter label="RAM" estGb={footprint?.ramGb} actualMb={ramMb} running={running} kind={footprint?.kind} basis={footprint?.basis} />
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-1.5 text-[9px] text-gray-500">
        {models.slice(0, 2).map((model) => <span key={model.id} className="max-w-36 truncate rounded-md border border-gray-700 bg-gray-800/70 px-2 py-1">{model.id}</span>)}
        {models.length > 2 && <span className="rounded-md border border-gray-700 bg-gray-800/70 px-2 py-1">+{models.length - 2} models</span>}
      </div>

      <div className="mt-auto pt-4">
        <p className={`mb-2 truncate font-mono text-[9px] ${service.error ? "text-red-300" : "text-gray-700"}`} title={service.error ?? latestLog ?? ""}>{service.error ?? latestLog ?? (running ? "Process is healthy" : "Starts on demand")}</p>
        {feedback && (
          <div
            role="status"
            aria-live="polite"
            className={`mb-2 flex items-start gap-2 rounded-md border px-2.5 py-2 text-[10px] ${feedback.type === "error" ? "border-red-500/30 bg-red-500/10 text-red-200" : "border-emerald-500/25 bg-emerald-500/10 text-emerald-200"}`}
          >
            <span className="min-w-0 flex-1">{feedback.text}</span>
            <button type="button" onClick={onDismissFeedback} aria-label={`Dismiss ${service.name} action message`} className="shrink-0 rounded px-1 text-current opacity-60 hover:opacity-100">×</button>
          </div>
        )}
        {confirmStop && criticalStopImpact[service.id] && (
          <div className="mb-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-[10px] text-amber-100">
            <p className="leading-4">{criticalStopImpact[service.id]}</p>
            <div className="mt-2 flex gap-2">
              <button type="button" onClick={() => { setConfirmStop(false); onAction(service.id, "stop"); }} className="rounded-md bg-red-500 px-2.5 py-1 font-medium text-white">Confirm stop</button>
              <button type="button" onClick={() => setConfirmStop(false)} className="rounded-md border border-gray-600 px-2.5 py-1 text-gray-200">Cancel</button>
            </div>
          </div>
        )}
        <div className="flex items-center gap-1.5 border-t border-gray-800 pt-3">
          {running ? (
            <>
              <button type="button" disabled={Boolean(busyAction)} onClick={() => onAction(service.id, "restart")} className="rounded-md border border-gray-700 px-2 py-1 text-[10px] text-gray-400 hover:border-gray-500 hover:text-gray-100 disabled:opacity-40">{busyAction === "restart" ? "Restarting…" : "Restart"}</button>
              <button type="button" disabled={Boolean(busyAction)} onClick={() => criticalStopImpact[service.id] ? setConfirmStop(true) : onAction(service.id, "stop")} className="flex items-center gap-1 rounded-md border border-red-500/25 px-2 py-1 text-[10px] text-red-300 hover:bg-red-500/10 disabled:opacity-40"><Stop size={10} weight="fill" />{busyAction === "stop" ? "Stopping…" : "Stop"}</button>
            </>
          ) : (
            <button type="button" disabled={Boolean(busyAction)} onClick={() => onAction(service.id, "start")} className="services-start flex items-center gap-1 rounded-md border border-orange-500/30 bg-orange-500/10 px-2.5 py-1 text-[10px] font-medium text-orange-300 hover:bg-orange-500/15 disabled:opacity-40">
              {busyAction === "start" ? <CircleNotch size={11} className="animate-spin" /> : <Play size={10} weight="fill" />}{busyAction === "start" ? "Starting…" : "Start"}
            </button>
          )}
          <ServiceLogsButton id={service.id} name={service.name} className="rounded-md border border-gray-700 px-2 py-1 text-[10px] text-gray-400 hover:border-gray-500 hover:text-gray-100" />
          {destination ? (
            <button type="button" onClick={() => onSelectTab(destination.tab)} className="ml-auto flex items-center gap-1 text-[10px] font-medium text-orange-300 hover:text-orange-200">
              {destination.label}<ArrowRight size={11} />
            </button>
          ) : registry && service.id !== "manager" ? (
            <a href={registry.localUrl} target="_blank" rel="noreferrer" className="ml-auto flex items-center gap-1 text-[10px] font-medium text-orange-300 hover:text-orange-200">
              {endpointLabel}<ArrowSquareOut size={11} />
            </a>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function StatusPill({ running, healthy, attention, status }: { running: boolean; healthy: boolean; attention: boolean; status: string }) {
  const label = attention ? "Attention" : running && healthy ? "Ready" : running ? "Starting" : "On demand";
  const Icon = attention ? WarningCircle : running && healthy ? CheckCircle : running ? CircleNotch : PlugsConnected;
  return (
    <span className={`flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[9px] font-medium ${attention ? "bg-red-500/10 text-red-300" : running && healthy ? "bg-emerald-500/10 text-emerald-300" : running ? "bg-amber-500/10 text-amber-300" : "bg-gray-800 text-gray-500"}`} title={status}>
      <Icon size={10} weight={running && healthy ? "fill" : "regular"} className={running && !healthy ? "animate-spin" : ""} />{label}
    </span>
  );
}
