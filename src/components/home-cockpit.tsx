"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  CaretDown,
  CaretLeft,
  CaretRight,
  ChatCircleDots,
  CheckCircle,
  CircleNotch,
  Clock,
  Code,
  Cpu,
  Cube,
  FileText,
  Gear,
  HardDrives,
  ImageSquare,
  Microphone,
  Paperclip,
  Play,
  Pulse,
  Stack,
  WarningCircle,
  Waveform,
} from "@phosphor-icons/react";
import type { ConsoleTab } from "@/components/command-palette";
import { useLiveRefresh } from "@/lib/use-live-refresh";
import { isAdopted, isOnDemand, isReady } from "@/lib/service-state";
import { getHost, getWorkstreamOverrides, declaredMemoryGb, type WorkstreamKind } from "@/lib/host";

type ManagedService = {
  id: string;
  name: string;
  type: string;
  port: number;
  category: string;
  status: string;
  healthy: boolean;
  owner?: "manager" | "external" | null;
};

type CatalogEntry = {
  id: string;
  serviceId?: string;
  mode: string;
  status?: string;
  params?: string;
};

type GpuProcessConsumer = {
  name: string;
  used_mb: number;
  bar_mb: number;
  pct_of_total: number;
  pids: number[];
  kind: "service" | "container" | "system" | "app";
  service_id?: string;
  note?: string;
};

type GpuStatus = {
  name: string;
  /** Null where the GPU exposes no such counter (Apple silicon). */
  temperature: number | null;
  gpu_util: number | null;
  mem_total: number;
  mem_used: number;
  mem_free: number;
  power_draw: number | null;
  power_limit: number | null;
  /** "unified": the VRAM figures below ARE system memory. */
  memory_model?: "discrete" | "unified";
  service_vram: Record<string, { name: string; used_mb: number; pct_of_total: number; model?: string | null }>;
  gpu_processes?: GpuProcessConsumer[];
  vram_summary: { accounted_mb: number; unaccounted_mb: number; unaccounted_note: string };
  host_ram?: { total_gb: number; free_gb: number; used_gb: number; pct_used: number };
  service_ram?: Record<string, { name: string; rss_mb: number; pid: number; pct_of_total: number }>;
  ram_summary?: { accounted_mb: number; unaccounted_mb: number; unaccounted_note: string };
  impact: "ok" | "good" | "warning" | "critical" | "busy";
  impact_msg: string;
  error?: string;
};

type ResourceControlSnapshot = {
  budgets: { ramSafetyGb: number; vramSafetyGb: number };
  capacity: {
    ram: { totalGb: number; freeGb: number };
    vram: { totalGb: number; freeGb: number };
  };
  usage: { ramGb: number; vramGb: number };
  starts: Array<{ id: string; serviceId: string }>;
  leases: Array<{ id: string; workload: string; resources: { ramGb: number; vramGb: number }; lane: string }>;
  queue: Array<{ id: string; workload: string; lane: string }>;
};

type TrafficEvent = {
  ts: number | null;
  service: string;
  target?: string | null;
  method: string;
  path: string;
  status: number | null;
  ms: number | null;
  caller?: string | null;
  model?: string | null;
  costUsd?: number | null;
  pending?: boolean;
};

type WorkflowKind = WorkstreamKind;

type Props = {
  managedServices: ManagedService[];
  catalogByService: Record<string, CatalogEntry[]>;
  gpu: GpuStatus | null;
  resourceControl: ResourceControlSnapshot | null;
  queueDepth: number;
  attentionCount: number;
  onSelectTab: (tab: ConsoleTab) => void;
  onPrefillChat: (value: string) => void;
  onPrefillSpeech: (value: string) => void;
  onTranscribeFile: (file: File) => void;
  /**
   * Bumped by the header's resource pulse when you ask to see the details.
   * A counter rather than a boolean: asking twice in a row has to re-open the
   * panel, and a boolean that is already `true` produces no change to react to.
   */
  openResourceMapSignal?: number;
};

/**
 * The four workstreams, on every machine — with per-host overrides.
 *
 * These were BeTenshi's services spelled out here, so another host advertised
 * work it could not do. The fix is NOT to drop cards: a console that shows a
 * different set per machine reads as a different product and hides what this box
 * cannot do. Every card is always here. A profile overrides only where this
 * machine genuinely differs (B5 backs Chat & Code with Ollama, not vLLM), and a
 * card whose service is not registered here renders as unavailable and says why.
 */
const canonicalWorkflows = {
  text: {
    label: "Chat & Code",
    description: "Think, code, debug, and refactor",
    model: "Qwen2.5-7B",
    serviceId: "vllm-small",
    tab: "llm" as ConsoleTab,
    vramGb: 7.6,
    ramGb: 8.2,
    icon: Code,
    color: "orange" as const,
    action: "Open chat",
  },
  image: {
    label: "Image Studio",
    description: "Generate and edit local images",
    model: "Qwen-Image",
    serviceId: "qwen",
    tab: "qwen" as ConsoleTab,
    vramGb: 20,
    ramGb: 28,
    icon: ImageSquare,
    color: "violet" as const,
    action: "Generate",
  },
  audio: {
    label: "Speech",
    description: "Transcribe and synthesize voice",
    model: "Whisper STT + Kokoro TTS",
    serviceId: "whisper",
    tab: "speech" as ConsoleTab,
    vramGb: 1.5,
    ramGb: 2.1,
    icon: Waveform,
    color: "blue" as const,
    action: "Open speech",
  },
  files: {
    label: "Vision & 3D",
    description: "Segment, inspect, and recover pose",
    model: "SAM 3 + SAM 3D Body",
    serviceId: "sam3",
    tab: "sam3" as ConsoleTab,
    vramGb: 8.1,
    ramGb: 10,
    icon: Cube,
    color: "emerald" as const,
    action: "Analyze",
  },
};

const overrides = getWorkstreamOverrides();
const hostServiceIds = new Set(getHost().services.map((s) => s.id));

const workflowConfig = Object.fromEntries(
  (Object.entries(canonicalWorkflows) as [WorkflowKind, typeof canonicalWorkflows.text][])
    .map(([kind, base]) => {
      const merged = { ...base, ...(overrides[kind] ?? {}) };
      return [kind, { ...merged, available: hostServiceIds.has(merged.serviceId) }];
    }),
) as Record<WorkflowKind, typeof canonicalWorkflows.text & { available: boolean }>;

/** All four, always — availability is rendered, not used to filter. */
const WORKFLOW_KINDS = ["text", "image", "audio", "files"] as WorkflowKind[];

const modeCopy: Record<WorkflowKind, { label: string; placeholder: string }> = {
  text: { label: "Text", placeholder: "Ask, plan, debug, or build something with your local models…" },
  image: { label: "Image", placeholder: "Describe the image you want to generate…" },
  audio: { label: "Audio", placeholder: "Enter text to synthesize, or attach audio to transcribe…" },
  files: { label: "Files", placeholder: "Describe what you want to inspect, segment, or reconstruct…" },
};

const accentByColor = {
  orange: "cockpit-tone-orange border-orange-500/40 bg-orange-500/10 text-orange-300",
  violet: "cockpit-tone-violet border-violet-500/35 bg-violet-500/10 text-violet-300",
  blue: "cockpit-tone-blue border-sky-500/35 bg-sky-500/10 text-sky-300",
  emerald: "cockpit-tone-emerald border-emerald-500/35 bg-emerald-500/10 text-emerald-300",
};

const actionByColor = {
  orange: "cockpit-action-orange text-orange-300",
  violet: "cockpit-action-violet text-violet-300",
  blue: "cockpit-action-blue text-sky-300",
  emerald: "cockpit-action-emerald text-emerald-300",
};

const fillByService: Record<string, string> = {
  qwen: "bg-orange-500/75",
  vllm: "bg-violet-500/80",
  "vllm-small": "bg-fuchsia-500/75",
  whisper: "bg-sky-500/75",
  tts: "bg-cyan-500/75",
  comfyui: "bg-pink-500/75",
  sam3: "bg-emerald-500/75",
  sam3d: "bg-teal-500/75",
};

const fillByProcessKind: Record<GpuProcessConsumer["kind"], string> = {
  service: "bg-orange-500/80",
  container: "bg-violet-500/80",
  system: "bg-sky-600/70",
  app: "bg-slate-500/80",
};

/**
 * The running services as a rail that scrolls, rather than a row that collides.
 *
 * The chips were previously capped at seven and laid out in a plain flex row
 * that shared its horizontal space with the "N/M online" label — so the moment
 * the names were long enough, the two overlapped and the last chip was
 * unreadable. Scrolling also means every running service is reachable instead
 * of an arbitrary first seven.
 *
 * The arrows appear only when there is somewhere to scroll, and the rail stays
 * wheel- and keyboard-scrollable without them, so they are an affordance rather
 * than the only way through.
 */
function ServiceChipRail({ services }: { services: ManagedService[] }) {
  const railRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  const sync = useCallback(() => {
    const el = railRef.current;
    if (!el) return;
    // A pixel of slack — fractional layout widths make an exact comparison
    // flip back and forth at the end of a scroll.
    setEdges({
      left: el.scrollLeft > 1,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
    });
  }, []);

  useEffect(() => {
    const el = railRef.current;
    if (!el) return;
    sync();
    // Overflow depends on the container's width, which changes with the window
    // and with how many services are running — neither is a scroll event.
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    return () => observer.disconnect();
  }, [sync, services.length]);

  if (!services.length) return null;

  const nudge = (direction: -1 | 1) => {
    const el = railRef.current;
    if (el) el.scrollBy({ left: direction * Math.max(160, el.clientWidth * 0.8), behavior: "smooth" });
  };

  return (
    <div className="relative hidden min-w-0 flex-1 lg:block">
      <div
        ref={railRef}
        onScroll={sync}
        className="flex items-center gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {services.map((service) => (
          <span key={service.id} className="flex shrink-0 items-center gap-1.5 rounded-md border border-gray-800 bg-gray-950/45 px-2 py-1 text-[10px] text-gray-400">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            <span className="max-w-28 truncate">{service.name}</span>
            <span className="font-mono text-gray-700">:{service.port}</span>
          </span>
        ))}
      </div>
      {edges.left && <RailArrow direction="left" onClick={() => nudge(-1)} />}
      {edges.right && <RailArrow direction="right" onClick={() => nudge(1)} />}
    </div>
  );
}

function RailArrow({ direction, onClick }: { direction: "left" | "right"; onClick: () => void }) {
  const Icon = direction === "left" ? CaretLeft : CaretRight;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Scroll services ${direction}`}
      className={`cockpit-rail-arrow absolute top-0 flex h-full w-8 items-center ${direction === "left" ? "left-0 justify-start" : "right-0 justify-end"}`}
    >
      <span className="flex h-5 w-5 items-center justify-center rounded-full border border-gray-700 bg-gray-900 text-gray-300 shadow-md">
        <Icon size={11} weight="bold" />
      </span>
    </button>
  );
}

function formatMemory(mb: number) {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

function formatTime(ts: number | null) {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatLatency(ms: number | null) {
  if (ms == null) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

function serviceLabel(event: TrafficEvent) {
  const id = event.target && event.target !== "console" ? event.target : event.service;
  if (id === "vllm" || id === "vllm-small" || event.path.includes("chat")) return "Chat & Code";
  if (id === "qwen" || event.path.includes("image")) return "Image Studio";
  if (id === "whisper" || id === "tts" || event.path.includes("audio")) return "Speech";
  if (id === "sam3" || id === "sam3d") return "Vision & 3D";
  return id || "Console";
}

function requestIcon(event: TrafficEvent) {
  const label = serviceLabel(event);
  if (label === "Image Studio") return ImageSquare;
  if (label === "Speech") return Waveform;
  if (label === "Vision & 3D") return Cube;
  if (label === "Chat & Code") return Code;
  return Pulse;
}

export default function HomeCockpit({
  managedServices,
  catalogByService,
  gpu,
  resourceControl,
  queueDepth,
  attentionCount,
  onSelectTab,
  onPrefillChat,
  onPrefillSpeech,
  onTranscribeFile,
  openResourceMapSignal = 0,
}: Props) {
  // First slot this host has, so the composer never opens on a workstream that is not here.
  const [mode, setMode] = useState<WorkflowKind>("text");
  const [prompt, setPrompt] = useState("");
  const [resourceOpen, setResourceOpen] = useState(false);
  const [backstageOpen, setBackstageOpen] = useState(false);
  const [events, setEvents] = useState<TrafficEvent[]>([]);
  const [recentPrompt, setRecentPrompt] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const draftLoaded = useRef(false);

  // "See details" on the header's resource pulse scrolls this panel into view.
  // Scrolling to a COLLAPSED panel just parks you in front of a closed lid, so
  // the same gesture opens it. Skips the initial render, where the counter is
  // still 0 and nobody has asked for anything.
  useEffect(() => {
    if (openResourceMapSignal > 0) setResourceOpen(true);
  }, [openResourceMapSignal]);

  useEffect(() => {
    const saved = window.localStorage.getItem("bt-home-draft");
    if (saved) setPrompt(saved);
    setRecentPrompt(window.localStorage.getItem("bt-home-recent") ?? "");
    draftLoaded.current = true;
  }, []);

  useEffect(() => {
    if (!draftLoaded.current) return;
    window.localStorage.setItem("bt-home-draft", prompt);
  }, [prompt]);

  const refreshEvents = useCallback(async () => {
    try {
      const response = await fetch("/api/traffic");
      if (!response.ok) return;
      const data = await response.json();
      setEvents(Array.isArray(data.events) ? data.events.slice(0, 8) : []);
    } catch {
      // The cockpit remains useful without the activity rail.
    }
  }, []);

  useLiveRefresh(refreshEvents, { intervalMs: 5000 });

  const selected = workflowConfig[mode];
  const selectedService = managedServices.find((service) => service.id === selected.serviceId);
  const alreadyResident = selectedService?.status === "running";
  const vramTotal = gpu?.mem_total ? gpu.mem_total / 1024 : resourceControl?.capacity.vram.totalGb ?? declaredMemoryGb().vramGb;
  const vramUsed = gpu?.mem_used ? gpu.mem_used / 1024 : Math.max(0, vramTotal - (resourceControl?.capacity.vram.freeGb ?? vramTotal));
  const ramTotal = gpu?.host_ram?.total_gb ?? resourceControl?.capacity.ram.totalGb ?? declaredMemoryGb().ramGb;
  const ramUsed = gpu?.host_ram?.used_gb ?? Math.max(0, ramTotal - (resourceControl?.capacity.ram.freeGb ?? ramTotal));
  const addedVram = alreadyResident ? 0 : selected.vramGb;
  const addedRam = alreadyResident ? 0 : selected.ramGb;
  const predictedVram = Math.min(vramTotal, vramUsed + addedVram);
  const predictedRam = Math.min(ramTotal, ramUsed + addedRam);
  const vramSafety = resourceControl?.budgets.vramSafetyGb ?? 1.5;
  const ramSafety = resourceControl?.budgets.ramSafetyGb ?? 4;
  const canRun = predictedVram <= vramTotal - vramSafety && predictedRam <= ramTotal - ramSafety;
  const online = managedServices.filter((service) => service.status === "running").length;
  const readyNow = managedServices.filter(isReady).length;
  const onDemand = managedServices.filter(isOnDemand).length;
  const recentFailures = events.filter((event) => event.status != null && event.status >= 400 && (event.ts == null || Date.now() - event.ts < 15 * 60_000));
  const stalledRequests = events.filter((event) => event.pending && event.ts != null && Date.now() - event.ts > 120_000);
  const unattributedSpend = events.filter((event) => !event.caller && (event.costUsd ?? 0) > 0);
  const adopted = managedServices.filter(isAdopted).length;
  const issueCount = attentionCount + adopted + recentFailures.length + stalledRequests.length + unattributedSpend.length;
  const residentModel = selected.model;
  const gpuConsumerRows = useMemo(() => {
    const rows = gpu?.gpu_processes ?? [];
    if (rows.length <= 6) return rows;
    const visible = rows.slice(0, 5);
    const rest = rows.slice(5);
    visible.push({
      name: "Other GPU apps",
      used_mb: rest.reduce((sum, row) => sum + row.used_mb, 0),
      bar_mb: rest.reduce((sum, row) => sum + row.bar_mb, 0),
      pct_of_total: rest.reduce((sum, row) => sum + row.pct_of_total, 0),
      pids: rest.flatMap((row) => row.pids),
      kind: "app",
      note: `${rest.length} smaller processes`,
    });
    return visible;
  }, [gpu?.gpu_processes]);

  const openWorkflow = (kind: WorkflowKind, usePrompt = false) => {
    const workflow = workflowConfig[kind];
    if (kind === "text" && usePrompt && prompt.trim()) onPrefillChat(prompt.trim());
    if (kind === "image" && usePrompt && prompt.trim()) {
      window.localStorage.setItem("bt-qwen-draft", prompt.trim());
    }
    if (kind === "audio" && usePrompt && prompt.trim()) onPrefillSpeech(prompt.trim());
    onSelectTab(workflow.tab);
  };

  const run = () => {
    if (mode === "files") {
      fileRef.current?.click();
      return;
    }
    if (prompt.trim()) {
      setRecentPrompt(prompt.trim());
      window.localStorage.setItem("bt-home-recent", prompt.trim());
    }
    openWorkflow(mode, true);
  };

  const handleFile = (file: File | undefined) => {
    if (!file) return;
    if (file.type.startsWith("audio/")) {
      onTranscribeFile(file);
      onSelectTab("speech");
      return;
    }
    onSelectTab(file.type.startsWith("image/") ? "sam3" : "qwen");
  };

  return (
    <div className="cockpit space-y-3">
      <section className={`cockpit-surface overflow-hidden rounded-2xl border ${issueCount ? "border-amber-500/35 bg-amber-500/[0.04]" : "border-emerald-500/20 bg-gray-900/75"}`} aria-labelledby="system-brief-title">
        <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-orange-300">System brief</p>
            <h2 id="system-brief-title" className="mt-0.5 text-base font-semibold text-gray-100">{issueCount ? `${issueCount} items need attention` : "Everything is ready for work"}</h2>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center sm:min-w-[420px]">
            <button type="button" onClick={() => onSelectTab("services")} className="rounded-xl border border-emerald-500/20 bg-emerald-500/8 px-3 py-2 text-left">
              <span className="block text-[9px] uppercase tracking-wide text-gray-500">Ready now</span>
              <span className="mt-0.5 block text-lg font-semibold tabular-nums text-emerald-300">{readyNow}</span>
            </button>
            <button type="button" onClick={() => onSelectTab("services")} className="rounded-xl border border-gray-800 bg-gray-950/40 px-3 py-2 text-left">
              <span className="block text-[9px] uppercase tracking-wide text-gray-500">On demand</span>
              <span className="mt-0.5 block text-lg font-semibold tabular-nums text-gray-200">{onDemand}</span>
            </button>
            <button type="button" onClick={() => onSelectTab(issueCount > attentionCount ? "requests" : "services")} className={`rounded-xl border px-3 py-2 text-left ${issueCount ? "border-amber-500/30 bg-amber-500/10" : "border-gray-800 bg-gray-950/40"}`}>
              <span className="block text-[9px] uppercase tracking-wide text-gray-500">Needs attention</span>
              <span className={`mt-0.5 block text-lg font-semibold tabular-nums ${issueCount ? "text-amber-300" : "text-gray-200"}`}>{issueCount}</span>
            </button>
          </div>
        </div>
        {(issueCount > 0 || unattributedSpend.length > 0) && (
          <div className="flex flex-wrap gap-x-5 gap-y-1 border-t border-gray-800 px-4 py-2 text-[11px] sm:px-5">
            {attentionCount > 0 && <button type="button" onClick={() => onSelectTab("services")} className="text-amber-200 hover:text-amber-100">{attentionCount} service issue{attentionCount === 1 ? "" : "s"}</button>}
            {adopted > 0 && <button type="button" onClick={() => onSelectTab("services")} title="Started outside the console, so its configured environment was not applied and its output is not captured. Hand it over to fix both." className="text-amber-200 hover:text-amber-100">{adopted} service{adopted === 1 ? "" : "s"} started outside the console</button>}
            {recentFailures.length > 0 && <button type="button" onClick={() => onSelectTab("requests")} className="text-red-300 hover:text-red-200">{recentFailures.length} recent failed request{recentFailures.length === 1 ? "" : "s"}</button>}
            {stalledRequests.length > 0 && <button type="button" onClick={() => onSelectTab("requests")} className="text-sky-300 hover:text-sky-200">{stalledRequests.length} request{stalledRequests.length === 1 ? "" : "s"} running over 2m</button>}
            {unattributedSpend.length > 0 && <button type="button" onClick={() => onSelectTab("requests")} className="text-violet-300 hover:text-violet-200">{unattributedSpend.length} billable call{unattributedSpend.length === 1 ? "" : "s"} missing a caller</button>}
          </div>
        )}
      </section>
      <section className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px] xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="cockpit-hero cockpit-surface overflow-hidden rounded-2xl border border-gray-800 bg-gray-900/75">
          {/* Bottom padding is not optional: the recent-prompt row below is
              conditional, and without it the primary button sat flush on the
              card edge whenever there was no recent prompt to render. */}
          <div className="px-5 pb-4 pt-4 sm:px-6 sm:pb-5 sm:pt-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-[22px] font-semibold tracking-[-0.025em] text-gray-100 sm:text-[26px]">What do you want to make?</h2>
                <p className="mt-1 text-sm text-gray-500">Use local models for code, images, speech, and vision.</p>
              </div>
              <button
                type="button"
                onClick={() => onSelectTab("models")}
                className="flex items-center gap-2 rounded-lg border border-gray-800 bg-gray-950/50 px-3 py-2 text-xs text-gray-400 transition hover:border-gray-600 hover:text-gray-100"
              >
                <Gear size={15} weight="duotone" className="text-violet-300" />
                Routing settings
              </button>
            </div>

            <div className="cockpit-composer mt-4 rounded-xl border border-orange-500/35 bg-gray-950/45 p-3 shadow-[inset_0_1px_rgba(255,255,255,0.025)] focus-within:border-orange-400/65 sm:p-4">
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") run();
                }}
                rows={2}
                placeholder={modeCopy[mode].placeholder}
                aria-label="Workflow prompt"
                className="min-h-14 w-full resize-none bg-transparent text-[15px] leading-6 text-gray-100 outline-none placeholder:text-gray-600"
              />
              <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-gray-800/80 pt-3">
                {WORKFLOW_KINDS.map((kind) => {
                  const Icon = kind === "text" ? FileText : kind === "image" ? ImageSquare : kind === "audio" ? Microphone : Paperclip;
                  return (
                    <button
                      key={kind}
                      type="button"
                      onClick={() => setMode(kind)}
                      aria-pressed={mode === kind}
                      className={`flex h-9 items-center gap-2 rounded-lg border px-3 text-xs transition ${
                        mode === kind
                          ? "cockpit-mode-active border-orange-500/55 bg-orange-500/10 text-orange-200"
                          : "border-gray-800 text-gray-500 hover:border-gray-600 hover:text-gray-200"
                      }`}
                    >
                      <Icon size={15} weight={mode === kind ? "duotone" : "regular"} />
                      {modeCopy[kind].label}
                    </button>
                  );
                })}
                <div className="ml-auto flex min-w-0 items-center gap-2">
                  <span className="hidden max-w-44 truncate text-[11px] text-gray-500 md:block">{residentModel}</span>
                  <button
                    type="button"
                    onClick={run}
                    className="cockpit-primary on-accent flex h-10 items-center gap-2 rounded-lg bg-orange-500 px-5 text-sm font-semibold shadow-[0_8px_24px_rgba(249,115,22,0.2)] transition hover:bg-orange-400 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={!canRun && !alreadyResident}
                    title={!canRun ? "This workflow needs more free memory" : undefined}
                  >
                    <Play size={16} weight="fill" />
                    {mode === "text" ? "Continue in Chat" : mode === "image" ? "Open Image Studio" : mode === "audio" ? "Open Speech" : "Choose file"}
                    <kbd className="hidden rounded border border-black/15 bg-black/10 px-1 py-0.5 text-[9px] sm:inline">⌘↵</kbd>
                  </button>
                  <input
                    ref={fileRef}
                    type="file"
                    className="hidden"
                    accept="image/*,audio/*,video/*"
                    onChange={(event) => handleFile(event.target.files?.[0])}
                  />
                </div>
              </div>
            </div>

            {recentPrompt && <div className="flex min-w-0 items-center gap-2 pt-3 text-[11px] text-gray-500">
              <Clock size={13} className="shrink-0 text-orange-400" />
              <span className="shrink-0 font-medium text-orange-300">Recent prompt</span>
              <span className="truncate">{recentPrompt}</span>
              <button
                type="button"
                onClick={() => setPrompt(recentPrompt)}
                className="ml-auto shrink-0 rounded-md border border-gray-800 px-2 py-1 text-gray-500 hover:border-gray-600 hover:text-gray-200"
              >
                Reuse
              </button>
            </div>}
          </div>
        </div>

        <aside className={`cockpit-verdict cockpit-surface rounded-2xl border p-4 ${canRun ? "border-orange-500/25 bg-gray-900/75" : "border-amber-500/35 bg-amber-500/[0.04]"}`}>
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-gray-100">Can it run?</h2>
            <span className={`cockpit-ready inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-medium ${canRun ? "bg-emerald-500/10 text-emerald-300" : "bg-amber-500/10 text-amber-300"}`}>
              {canRun ? <CheckCircle size={14} weight="fill" /> : <WarningCircle size={14} weight="fill" />}
              {canRun ? "Ready" : "Needs capacity"}
            </span>
          </div>
          <dl className="mt-3 divide-y divide-gray-800 text-xs">
            <div className="flex items-center justify-between gap-4 py-1.5">
              <dt className="text-gray-500">Workflow</dt>
              <dd className="truncate text-right font-medium text-gray-200">{selected.label}</dd>
            </div>
            <div className="flex items-center justify-between gap-4 py-1.5">
              <dt className="text-gray-500">Predicted VRAM</dt>
              <dd className="tabular-nums text-gray-300"><span className="font-semibold text-orange-300">{predictedVram.toFixed(1)} GB</span> / {vramTotal.toFixed(1)}</dd>
            </div>
            <div className="flex items-center justify-between gap-4 py-1.5">
              <dt className="text-gray-500">Predicted RAM</dt>
              <dd className="tabular-nums text-gray-300"><span className="font-semibold text-orange-300">{predictedRam.toFixed(1)} GB</span> / {ramTotal.toFixed(1)}</dd>
            </div>
            <div className="flex items-center justify-between gap-4 py-1.5">
              <dt className="text-gray-500">Model to load</dt>
              <dd className="truncate text-right text-gray-300">{alreadyResident ? "Already resident" : residentModel}</dd>
            </div>
            <div className="flex items-center justify-between gap-4 py-1.5">
              <dt className="text-gray-500">Startup</dt>
              <dd className="text-right text-gray-300">{alreadyResident ? "Ready now" : "Cold start required"}</dd>
            </div>
            <div className="flex items-center justify-between gap-4 py-1.5">
              <dt className="text-gray-500">Queue impact</dt>
              <dd className="tabular-nums text-gray-300">{queueDepth} → {queueDepth + (alreadyResident ? 0 : 1)}</dd>
            </div>
          </dl>
          <p className={`mt-2.5 flex gap-2 border-t border-gray-800 pt-2.5 text-[11px] leading-5 ${canRun ? "text-gray-400" : "text-amber-300/80"}`}>
            {canRun ? <CheckCircle size={15} weight="fill" className="mt-0.5 shrink-0 text-emerald-400" /> : <WarningCircle size={15} weight="fill" className="mt-0.5 shrink-0" />}
            {canRun
              ? alreadyResident
                ? "The model is already resident. This workflow can start immediately."
                : "There is enough protected VRAM and RAM headroom to load this workflow."
              : "Starting now would cross the configured safety reserve. Stop a resident model or wait for the scheduler."}
          </p>
        </aside>
      </section>

      {/* Two classes here are load-bearing, because the requests feed beside
          these cards is a `row-span-2` item.

          `items-start` — a grid stretches its items to the row height by
          default, so the feed's height was being applied to BOTH cards in
          column one: Workstreams grew a band of dead space under its last row,
          and the collapsed Resource map rendered as a tall empty panel. No
          amount of padding tuning reaches that; the height came from the row.

          `lg:grid-rows-[auto_1fr]` — a row-spanning item hands its excess
          height to the intrinsic rows it spans, which would split the leftover
          between the two cards and open a gap in the middle of the column.
          Pinning row one to `auto` and row two to `1fr` sends all of it to the
          flexible row instead, so the slack collects below the last card as
          plain background rather than inside either panel. */}
      <section className="grid items-start gap-3 lg:grid-cols-[minmax(0,1fr)_320px] lg:grid-rows-[auto_1fr] xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="cockpit-surface overflow-hidden rounded-2xl border border-gray-800 bg-gray-900/75">
          <div className="cockpit-section-header flex items-center justify-between border-b border-gray-800 px-4 py-2.5 sm:px-5">
            <div>
              <h2 className="text-sm font-semibold text-gray-100">Workstreams</h2>
              <p className="mt-0.5 text-[11px] text-gray-500">One place to continue work across every local capability.</p>
            </div>
            <button type="button" onClick={() => onSelectTab("models")} className="cockpit-accent-text text-xs font-medium text-orange-300 hover:text-orange-200">View routing</button>
          </div>
          <div className="divide-y divide-gray-800/80">
            {WORKFLOW_KINDS.map((kind) => {
              const workflow = workflowConfig[kind];
              const Icon = workflow.icon;
              const service = managedServices.find((item) => item.id === workflow.serviceId);
              const ready = service ? isReady(service) : false;
              const recent = events.find((event) => serviceLabel(event) === workflow.label);
              return (
                <button
                  type="button"
                  key={kind}
                  onClick={() => openWorkflow(kind)}
                  className="cockpit-row group grid w-full grid-cols-[minmax(0,1fr)_82px] items-center gap-3 px-4 py-2 text-left transition hover:bg-gray-800/45 sm:grid-cols-[minmax(0,1.1fr)_minmax(140px,.75fr)_82px_100px] sm:px-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(140px,.75fr)_82px_minmax(120px,.6fr)_100px]"
                >
                  <span className="flex min-w-0 items-center gap-3">
                    <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${accentByColor[workflow.color]}`}>
                      <Icon size={18} weight="duotone" />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-gray-100">{workflow.label}</span>
                      <span className="block truncate text-[11px] text-gray-500">{workflow.description}</span>
                    </span>
                  </span>
                  <span className="hidden min-w-0 sm:block">
                    <span className={`block truncate text-xs ${workflow.available ? "text-gray-300" : "text-gray-500"}`}>{workflow.model}</span>
                    <span className="block text-[10px] tabular-nums text-gray-500">
                      {workflow.available
                        ? `${workflow.vramGb.toFixed(1)} GB VRAM profile`
                        : `needs ${workflow.serviceId}`}
                    </span>
                  </span>
                  <span className={`flex items-center gap-1.5 text-[11px] ${!workflow.available ? "text-amber-300/90" : ready ? "text-emerald-300" : "text-gray-600"}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${!workflow.available ? "bg-amber-400/80" : ready ? "bg-emerald-400" : "bg-gray-600"}`} />
                    {!workflow.available ? "Not on this machine" : ready ? "Ready" : "On demand"}
                  </span>
                  <span className="hidden min-w-0 lg:block">
                    <span className="block text-[9px] uppercase tracking-wide text-gray-500">Recent</span>
                    <span className="block truncate text-[10px] text-gray-400">{recent ? `${recent.method} ${recent.path}` : "No recent work"}</span>
                  </span>
                  <span className={`hidden items-center justify-end gap-1 text-xs font-medium sm:flex ${actionByColor[workflow.color]}`}>
                    {workflow.action}<ArrowRight size={13} className="transition group-hover:translate-x-0.5" />
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* The feed is sized BY the left column rather than sizing itself.
            Absolutely positioning its contents takes them out of intrinsic row
            sizing, so the two rows are measured from Workstreams and the
            Resource map alone; `self-stretch` then pins the card to exactly that
            height. Collapse the Resource map and the feed shrinks with it
            instead of towering over a short column; expand it and the feed grows
            and simply shows more of the list. The list scrolls, so the height is
            never a limit on what you can reach.

            All of it is `lg:`-gated — stacked on one column there is no
            neighbour to match, and the card should just flow. */}
        <aside className="cockpit-surface overflow-hidden rounded-2xl border border-gray-800 bg-gray-900/75 lg:relative lg:row-span-2 lg:self-stretch">
          <div className="flex h-full flex-col lg:absolute lg:inset-0">
          <div className="cockpit-section-header flex shrink-0 items-center justify-between border-b border-gray-800 px-4 py-3 sm:px-5">
            <div>
              <h2 className="text-sm font-semibold text-gray-100">Recent requests</h2>
              <p className="mt-0.5 text-[11px] text-gray-500">Useful traffic, without probes or internal hops.</p>
            </div>
            <span className="text-[11px] tabular-nums text-gray-500">Queue {queueDepth}</span>
          </div>
          <div className="min-h-0 flex-1 divide-y divide-gray-800/80 overflow-y-auto">
            {/* More than fits on purpose: the card's height is now set by the
                neighbouring column, so a taller column should reveal more of the
                feed rather than pad it with blank space. The rest scrolls. */}
            {events.length ? events.slice(0, 20).map((event, index) => {
              const Icon = requestIcon(event);
              return (
                <button
                  type="button"
                  key={`${event.ts}-${event.path}-${index}`}
                  onClick={() => onSelectTab("requests")}
                  className="cockpit-request flex w-full gap-3 px-4 py-3 text-left transition hover:bg-gray-800/45 sm:px-5"
                >
                  <span className="cockpit-request-icon mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gray-800 text-orange-300">
                    <Icon size={16} weight="duotone" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-xs font-medium text-gray-200">{serviceLabel(event)}</span>
                      <span className="shrink-0 text-[10px] tabular-nums text-gray-600">{formatTime(event.ts)}</span>
                    </span>
                    <span className="mt-0.5 block truncate font-mono text-[10px] text-gray-500">{event.method} {event.path}</span>
                    <span className="mt-1 flex items-center gap-2 text-[10px] text-gray-600">
                      <span className="truncate">{event.model ?? event.caller ?? event.target ?? event.service}</span>
                      <span className="ml-auto shrink-0 tabular-nums">{event.pending ? "running" : formatLatency(event.ms)}</span>
                      <span className={event.status != null && event.status >= 400 ? "text-red-400" : "text-emerald-400"}>{event.pending ? "•••" : event.status ?? "—"}</span>
                    </span>
                  </span>
                </button>
              );
            }) : (
              <div className="px-5 py-10 text-center">
                <Pulse size={24} className="mx-auto text-gray-700" />
                <p className="mt-2 text-xs text-gray-500">No useful requests captured yet.</p>
              </div>
            )}
          </div>
          <button type="button" onClick={() => onSelectTab("requests")} className="flex w-full shrink-0 items-center gap-1 border-t border-gray-800 px-5 py-3 text-xs font-medium text-orange-300 transition hover:bg-gray-800/35 hover:text-orange-200">
            View all requests <ArrowRight size={13} />
          </button>
          </div>
        </aside>

        <div id="resource-map" className="cockpit-resource cockpit-surface scroll-mt-36 overflow-hidden rounded-2xl border border-gray-800 bg-gray-900/75">
          <button
            type="button"
            onClick={() => setResourceOpen((value) => !value)}
            className="flex w-full items-center gap-3 px-4 py-3 text-left sm:px-5"
            aria-expanded={resourceOpen}
          >
            <Cpu size={17} weight="duotone" className="text-orange-300" />
            <span className="text-sm font-semibold text-gray-100">Resource map</span>
            <span className="hidden text-[11px] text-gray-500 sm:inline">Live GPU VRAM, system RAM, and resident workloads.</span>
            <span className={`ml-auto transition ${resourceOpen ? "rotate-180" : ""}`}><CaretDown size={14} className="text-gray-500" /></span>
          </button>

          {resourceOpen && (
            <div className="space-y-4 border-t border-gray-800 px-4 py-4 sm:px-5">
              <div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                  <span className="font-semibold text-gray-200">GPU</span>
                  <span className="text-gray-500">{gpu?.name ?? "GPU"} · {vramTotal.toFixed(1)} GB {gpu?.memory_model === "unified" ? "unified memory" : "VRAM"}</span>
                  <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-emerald-300">{gpu?.impact === "critical" ? "Constrained" : "Healthy"}</span>
                  <span className="ml-auto tabular-nums text-gray-500">
                    {[
                      gpu?.gpu_util != null ? `Util ${gpu.gpu_util}%` : null,
                      gpu?.temperature != null ? `${gpu.temperature}°C` : null,
                      gpu?.power_draw != null ? `${Math.round(gpu.power_draw)}W` : null,
                    ].filter(Boolean).join(" · ")}
                  </span>
                </div>
                <div className="mt-2 flex h-10 overflow-hidden rounded-lg border border-gray-700 bg-gray-800">
                  {gpuConsumerRows.length > 0 ? gpuConsumerRows.map((process) => (
                    <div
                      key={`${process.kind}-${process.name}`}
                      className={`flex min-w-[2px] items-center overflow-hidden border-r border-black/20 px-2 text-[10px] font-medium text-white ${process.service_id ? fillByService[process.service_id] ?? fillByProcessKind[process.kind] : fillByProcessKind[process.kind]}`}
                      style={{ width: `${Math.max(1, process.pct_of_total)}%` }}
                      title={`${process.name}: ${formatMemory(process.used_mb)} dedicated VRAM${process.note ? ` — ${process.note}` : ""}`}
                    >
                      {process.pct_of_total > 8 ? <span className="truncate">{process.name}</span> : null}
                    </div>
                  )) : Object.entries(gpu?.service_vram ?? {}).map(([id, service]) => (
                    <div key={id} className={`flex min-w-[2px] items-center overflow-hidden border-r border-black/20 px-2 text-[10px] font-medium text-white ${fillByService[id] ?? "bg-slate-500/75"}`} style={{ width: `${Math.max(1, service.pct_of_total)}%` }} title={`${service.name}: ${(service.used_mb / 1024).toFixed(1)} GB VRAM`}>
                      {service.pct_of_total > 12 ? <span className="truncate">{service.name}</span> : null}
                    </div>
                  ))}
                  {gpu?.vram_summary?.unaccounted_mb ? (
                    <div
                      className="flex min-w-[2px] items-center overflow-hidden bg-slate-600/65 px-2 text-[10px] text-gray-200"
                      style={{ width: `${Math.max(1, (gpu.vram_summary.unaccounted_mb / Math.max(1, gpu.mem_total)) * 100)}%` }}
                      title={`${(gpu.vram_summary.unaccounted_mb / 1024).toFixed(1)} GB other VRAM`}
                    >
                      <span className="truncate">Other</span>
                    </div>
                  ) : null}
                  <div className="flex min-w-20 flex-1 items-center justify-end px-3 text-[10px] tabular-nums text-gray-400">{Math.max(0, vramTotal - vramUsed).toFixed(1)} GB free</div>
                </div>
                <div className="mt-1 flex justify-between text-[10px] tabular-nums text-gray-600"><span>0 GB</span><span>{(vramTotal / 2).toFixed(0)} GB</span><span>{vramTotal.toFixed(1)} GB</span></div>

                {gpuConsumerRows.length > 0 && (
                  <div className="mt-3">
                    <div className="mb-1.5 flex items-center gap-2 text-[10px] uppercase tracking-wider text-gray-600">
                      <span className="font-semibold text-gray-400">{gpu?.memory_model === "unified" ? "GPU memory consumers" : "VRAM consumers"}</span>
                      <span className="normal-case tracking-normal">live Windows process counters</span>
                    </div>
                    <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                      {gpuConsumerRows.map((process) => (
                        <div key={`consumer-${process.kind}-${process.name}`} className="gpu-consumer-row flex min-w-0 items-center gap-2 rounded-lg border border-gray-800 bg-gray-950/35 px-2.5 py-2">
                          <span className={`h-2 w-2 shrink-0 rounded-full ${process.service_id ? fillByService[process.service_id] ?? fillByProcessKind[process.kind] : fillByProcessKind[process.kind]}`} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[11px] font-medium text-gray-200">{process.name}</span>
                            <span className="block truncate text-[9px] text-gray-600">{process.note ?? `${process.kind} process · PID ${process.pids[0]}`}</span>
                          </span>
                          <span className="shrink-0 text-[11px] font-semibold tabular-nums text-gray-300">{formatMemory(process.used_mb)}</span>
                        </div>
                      ))}
                    </div>
                    <p className="mt-1.5 text-[9px] leading-relaxed text-gray-600">Dedicated GPU memory by Windows process. Containerized models are reported together under the Docker / WSL GPU VM because WDDM cannot split that VM by container.</p>
                  </div>
                )}
              </div>

              <div>
                <div className="flex items-center gap-3 text-[11px]">
                  <span className="font-semibold text-gray-200">{gpu?.memory_model === "unified" ? "System memory (the same pool as the GPU above)" : "System RAM"}</span>
                  <span className="text-gray-500">{ramTotal.toFixed(1)} GB</span>
                  <span className="ml-auto tabular-nums text-gray-500">{ramUsed.toFixed(1)} GB committed · {Math.max(0, ramTotal - ramUsed).toFixed(1)} GB free</span>
                </div>
                <div className="mt-2 flex h-8 overflow-hidden rounded-lg border border-gray-700 bg-gray-800">
                  {Object.entries(gpu?.service_ram ?? {}).map(([id, service]) => (
                    <div
                      key={id}
                      className={`min-w-[2px] border-r border-black/20 ${fillByService[id] ?? "bg-slate-500/70"}`}
                      style={{ width: `${Math.max(1, service.pct_of_total)}%` }}
                      title={`${service.name}: ${(service.rss_mb / 1024).toFixed(1)} GB RAM`}
                    />
                  ))}
                  {gpu?.ram_summary?.unaccounted_mb ? (
                    <div
                      className="flex min-w-[2px] items-center overflow-hidden bg-orange-700/65 px-2 text-[10px] text-orange-100"
                      style={{ width: `${Math.max(1, (gpu.ram_summary.unaccounted_mb / 1024 / Math.max(1, ramTotal)) * 100)}%` }}
                      title={`${(gpu.ram_summary.unaccounted_mb / 1024).toFixed(1)} GB desktop, apps, WSL and OS cache`}
                    >
                      <span className="truncate">Desktop + apps + cache</span>
                    </div>
                  ) : null}
                  <div className="min-w-16 flex-1 bg-gray-800" />
                </div>
              </div>

              {(resourceControl?.leases.length ?? 0) > 0 && (
                <div className="flex flex-wrap items-center gap-2 border-t border-gray-800 pt-3 text-[10px] text-gray-500">
                  <span className="font-medium text-gray-300">Scheduler</span>
                  {resourceControl?.leases.map((lease) => (
                    <span key={lease.id} className="inline-flex items-center gap-1.5 rounded-md bg-orange-500/10 px-2 py-1 text-orange-300">
                      <CircleNotch size={11} className="animate-spin" /> {lease.workload} · {lease.resources.vramGb.toFixed(1)} GB
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </section>

      <section id="services" className="cockpit-surface overflow-hidden rounded-2xl border border-gray-800 bg-gray-900/75">
        {/* This header is no longer one wide button. The running-service chips
            sat inside it sharing `ml-auto` with the "N/M online" label, so once
            the names got long they ran underneath it and the last chip was
            unreadable. Making them scroll needs arrow controls, and a button
            cannot legally contain another button. Both ends stay buttons and the
            rail sits between them. */}
        <div className="flex items-center gap-3 px-4 py-3 sm:px-5">
          <button
            type="button"
            onClick={() => setBackstageOpen((value) => !value)}
            aria-expanded={backstageOpen}
            aria-controls="backstage-panel"
            className="flex shrink-0 items-center gap-3 text-left"
          >
            <Stack size={17} weight="duotone" className="text-orange-300" />
            <span>
              <span className="block text-sm font-semibold text-gray-100">Backstage</span>
              <span className="block text-[10px] text-gray-500">The services powering your workstreams.</span>
            </span>
          </button>

          <ServiceChipRail services={managedServices.filter((service) => service.status === "running")} />

          <button
            type="button"
            onClick={() => setBackstageOpen((value) => !value)}
            aria-expanded={backstageOpen}
            aria-controls="backstage-panel"
            className="ml-auto flex shrink-0 items-center gap-2 text-[11px] text-gray-500 transition hover:text-gray-300"
          >
            {online}/{managedServices.length} online
            <CaretDown size={13} className={`transition ${backstageOpen ? "rotate-180" : ""}`} />
          </button>
        </div>

        {backstageOpen && (
          <div id="backstage-panel" className="border-t border-gray-800">
            <div className="grid grid-cols-[minmax(0,1.5fr)_80px_70px_140px] gap-3 border-b border-gray-800 bg-gray-950/35 px-4 py-2 text-[10px] uppercase tracking-wider text-gray-700 sm:px-5">
              <span>Service</span><span>Status</span><span>Port</span><span className="text-right">Actions</span>
            </div>
            <div className="divide-y divide-gray-800/70">
              {managedServices.map((service) => {
                const running = service.status === "running";
                return (
                  <div key={service.id} className="grid grid-cols-[minmax(0,1.5fr)_80px_70px_140px] items-center gap-3 px-4 py-2.5 text-xs sm:px-5">
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-gray-200">{service.name}</span>
                      <span className="block truncate text-[10px] text-gray-600">{catalogByService[service.id]?.map((model) => model.id).join(" · ") || service.type}</span>
                    </span>
                    <span className={`flex items-center gap-1.5 text-[10px] ${running ? "text-emerald-300" : service.status === "failed" ? "text-red-300" : "text-gray-600"}`}>
                      <span className={`h-1.5 w-1.5 rounded-full ${running ? "bg-emerald-400" : service.status === "failed" ? "bg-red-400" : "bg-gray-600"}`} />{service.status}
                    </span>
                    <span className="font-mono text-[10px] text-gray-600">:{service.port}</span>
                    <span className="flex justify-end gap-1.5">
                      <button type="button" onClick={() => onSelectTab("services")} className="rounded-md border border-gray-700 px-2.5 py-1 text-[10px] text-gray-400 hover:border-gray-500 hover:text-gray-100">
                        Manage safely
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-4 border-t border-gray-800 bg-gray-950/25 px-4 py-2 text-[10px] text-gray-600 sm:px-5">
          <span className="flex items-center gap-1.5 text-emerald-300"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />{online}/{managedServices.length} services online</span>
          <span>{attentionCount ? `${attentionCount} need attention` : "No active issues"}</span>
          <span>Queue {queueDepth}</span>
          <button type="button" onClick={() => onSelectTab("services")} className="ml-auto flex items-center gap-1.5 text-gray-400 hover:text-gray-100"><Gear size={12} />Manage services<ArrowRight size={12} /></button>
        </div>
      </section>
    </div>
  );
}
