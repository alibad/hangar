"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import ModelPicker from "@/components/model-picker";
import ModelDiscovery from "@/components/model-discovery";
import QwenTab from "@/components/qwen-tab";
import VideoStudio from "@/components/video-studio";
import RequestsView from "@/components/requests-view";
import UsageView from "@/components/usage-view";
import Sam3dView from "@/components/sam3d-view";
import Sam3View from "@/components/sam3-view";
import ModelsPage from "@/components/models-page";
import ArenaView from "@/components/arena-view";
import ModelFootprint, { type Footprint } from "@/components/model-footprint";
import Markdown from "@/components/markdown";
import { ServiceLogsButton } from "@/components/service-control";
import { isAdopted, isOnDemand, isReady, needsAttention } from "@/lib/service-state";
import { useTheme } from "@/components/theme-provider";
import { ThemePicker } from "@/components/theme-picker";
import { CommandPalette, type ConsoleTab } from "@/components/command-palette";
import TabErrorBoundary from "@/components/tab-error-boundary";
import HomeCockpit from "@/components/home-cockpit";
import ForeignProfileNotice from "@/components/foreign-profile-notice";
import ConsoleHeader from "@/components/console-header";
import ResourcePulse from "@/components/resource-pulse";
import { VoiceCloner } from "@/components/voice-cloner";
import { useVoiceInput, appendTranscript } from "@/components/voice-input";
import { useAudioRecorder } from "@/lib/use-audio-recorder";
import type { VoiceOption } from "@/app/api/tts/voices/route";
import ServicesControlCenter from "@/components/services-control-center";
import StorageManager from "@/components/storage-manager";
import { ToolPageHeader, ToolSectionHeading } from "@/components/tool-page";
import { useLiveRefresh } from "@/lib/use-live-refresh";
import { ChatCircleText, Waveform as WaveformIcon } from "@phosphor-icons/react";
import {
  Brain, Mic, Volume2, Globe, Activity, Database,
  Sparkles, Layers, ScanLine, Scan, Server, ExternalLink, Cpu, RefreshCw,
  Sun, Moon, LayoutGrid, List, AlertTriangle, type LucideIcon,
} from "lucide-react";
import { hostHasTab, servicesForCapability } from "@/lib/host";
import HostUnavailable from "@/components/host-unavailable";
import LocalMachineRequired, { HostedRuntimeNotice } from "@/components/local-machine-required";
import { isHostedRuntime } from "@/lib/runtime";

const HOSTED_RUNTIME = isHostedRuntime();

// Small inline spinner shown while a service action (start/stop/restart) is in flight.
function Spinner() {
  return <span className="inline-block w-3 h-3 rounded-full border-[1.5px] border-current border-t-transparent animate-spin align-[-2px]" />;
}

/**
 * What the Speech tab's header chip names, derived rather than typed.
 *
 * It read "Whisper + Kokoro" as a literal, which was true for exactly as long
 * as this box had two speech services. Adding a third made the header quietly
 * wrong — the kind of staleness nothing fails on. The suffix strip is cosmetic:
 * "Whisper STT + Kokoro TTS + Chatterbox Voice" is accurate and too long for a
 * chip.
 */
const SPEECH_ENGINES = [
  ...new Set(
    [...servicesForCapability("stt"), ...servicesForCapability("tts")].map((s) =>
      s.name.replace(/\s+(STT|TTS|Voice)$/i, ""),
    ),
  ),
].join(" + ");

/**
 * A reasoning model's working, collapsed.
 *
 * Worth showing — it's most of what you're paying for with a reasoning model,
 * and it's where you see the reply go wrong. Worth collapsing — it's routinely
 * longer than the answer, and expanded by default it buries the thing you asked
 * for. Closed, with the length on the summary so you can judge before opening.
 */
function ThinkingBlock({ text }: { text: string }) {
  const words = text.trim().split(/\s+/).length;
  return (
    <details className="mb-2 rounded-lg border border-violet-500/25 bg-violet-500/5">
      <summary className="cursor-pointer select-none px-2.5 py-1.5 text-[11px] text-violet-300/90 hover:text-violet-200">
        Thinking <span className="text-violet-400/50 tabular-nums">· {words} words</span>
      </summary>
      <div className="border-t border-violet-500/20 px-2.5 py-2 text-[12px] leading-relaxed text-gray-400 whitespace-pre-wrap">
        {text}
      </div>
    </details>
  );
}

type ServiceStatus = {
  name: string;
  id: string;
  subdomain: string;
  localUrl: string;
  publicUrl: string;
  category: string;
  status: "up" | "down";
  statusCode: number;
  latency: number;
  routing: "local" | "public";
};

type HealthResponse = {
  services: ServiceStatus[];
  timestamp: string;
  upCount: number;
  totalCount: number;
  routing: "local" | "public";
};

type RoutingInfo = {
  mode: "local" | "public";
  services: {
    id: string;
    name: string;
    localPort: number;
    localUrl: string;
    publicUrl: string;
    activeUrl: string;
    category: string;
  }[];
};

/** One model from the AI Router catalogue, as far as a service card cares. */
type CatalogEntry = {
  id: string;
  serviceId?: string;
  mode: string;
  status?: string;
  checkpoint?: string;
  params?: string;
  target: string;
  footprint?: Footprint;
};

/** /api/host — which box this is, so the page names itself and hides tabs for
 *  services that do not exist here. */
type HostInfo = {
  id: string;
  name: string;
  platform: string;
  gpu: string;
  memory: { kind: "discrete" | "unified" };
  services: string[];
  /** This machine's real hostname, and whether the profile above is actually it. */
  machine?: string;
  matchesProfile?: boolean;
};

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  /** Reasoning models put their working here — see splitThinking in /api/chat. */
  thinking?: string | null;
  /** finish_reason === "length": the reply was cut off, often mid-thought. */
  truncated?: boolean;
  /** The ceiling it hit, so the notice can name a number rather than a concept. */
  maxTokens?: number;
  /** Earlier turns that did not fit the history budget — see /api/chat. */
  dropped?: number;
  latency?: number;
  tokens?: number;
  model?: string;
};

type Metrics = {
  metrics: Record<string, number>;
  raw_lines: number;
};

type TranscribeResult = {
  text: string;
  latency: number;
  fileName: string;
  /** Router alias that actually did the work — the picked model, or the fallback. */
  model?: string;
  /** Set when the routing couldn't be honoured and the local model was used. */
  degraded?: string;
};

type ManagedService = {
  id: string;
  name: string;
  type: string;
  port: number;
  category: string;
  status: string;
  healthy: boolean;
  pid: number | null;
  container: string | null;
  log_tail: string[];
  error?: string | null;
  /**
   * Who spawned the process on this port. "external" means it was started outside
   * the manager (a shell, by hand), so its configured env was never applied and
   * its output was never captured — Restart hands it over.
   */
  owner?: "manager" | "external" | null;
};

/** Stable colour per service in the VRAM bar, so the legend and bar agree. */
const VRAM_COLORS: Record<string, string> = {
  qwen: "bg-violet-500",
  vllm: "bg-purple-500",
  "vllm-small": "bg-fuchsia-500",
  whisper: "bg-blue-500",
  tts: "bg-cyan-500",
  comfyui: "bg-pink-500",
  sam3: "bg-teal-500",
  sam3d: "bg-emerald-500",
};
const vramColor = (id: string) => VRAM_COLORS[id] ?? "bg-slate-500";

type GpuStatus = {
  /** Which machine answered, and whether VRAM and RAM are one pool or two. */
  host?: { id: string; name: string };
  memory_model?: "discrete" | "unified";
  name: string;
  /** Null on hosts whose GPU exposes no such counter (Apple silicon). */
  temperature: number | null;
  gpu_util: number | null;
  mem_util: number | null;
  mem_total: number;
  mem_used: number;
  mem_free: number;
  power_draw: number | null;
  power_limit: number | null;
  fan_speed: number | null;
  pstate: string | null;
  /** Per-service VRAM, self-reported by each service (nvidia-smi can't on Windows). */
  service_vram: Record<string, {
    name: string;
    used_mb: number;
    pct_of_total: number;
    model?: string | null;
  }>;
  vram_summary: {
    accounted_mb: number;
    unaccounted_mb: number;
    unaccounted_note: string;
  };
  /** System RAM — the budget that actually runs out here. See /api/gpu. */
  host_ram?: {
    total_gb: number;
    free_gb: number;
    used_gb: number;
    pct_used: number;
  };
  /** Resident RAM per service, resolved by port→pid so it survives a restart
   *  by anything other than the manager. `docker-wsl` is a synthetic row. */
  service_ram?: Record<string, {
    name: string;
    rss_mb: number;
    pid: number;
    pct_of_total: number;
  }>;
  ram_summary?: {
    accounted_mb: number;
    unaccounted_mb: number;
    unaccounted_note: string;
  };
  impact: "ok" | "good" | "warning" | "critical" | "busy";
  impact_msg: string;
  error?: string;
};

type ResourceControlSnapshot = {
  sampledAt: number;
  budgets: { ramSafetyGb: number; vramSafetyGb: number };
  capacity: {
    ram: { totalGb: number; freeGb: number };
    vram: { totalGb: number; freeGb: number };
  };
  usage: { ramGb: number; vramGb: number };
  activeServices: string[];
  starts: Array<{ id: string; serviceId: string; owner: string; createdAt: number }>;
  leases: Array<{
    id: string;
    workload: string;
    serviceId: string | null;
    slot: string | null;
    owner: string;
    lane: "interactive" | "background";
    resources: { ramGb: number; vramGb: number };
    acquiredAt: number;
    expiresAt: number;
  }>;
  gpu_processes?: Array<{
    name: string;
    used_mb: number;
    bar_mb: number;
    pct_of_total: number;
    pids: number[];
    kind: "service" | "container" | "system" | "app";
    service_id?: string;
    note?: string;
  }>;
  queue: Array<{
    id: string;
    workload: string;
    owner: string;
    lane: "interactive" | "background";
    queuedAt: number;
    lastDenial?: { kind: string; message: string } | null;
  }>;
  lastEvent?: { at: number; type: string; message?: string; serviceId?: string; workload?: string } | null;
};

export default function Home() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  /** Elapsed wait, so the pending bubble can count instead of just bouncing. */
  const [sendingMs, setSendingMs] = useState(0);
  /**
   * Send the thread, or just the latest message.
   *
   * On by default, because a chat that cannot remember its own last answer is
   * the surprising behaviour, not the useful one. Off is still worth having:
   * each turn re-sends the whole conversation, so on a local model a long
   * thread gets slower every message, and a one-shot prompt is sometimes
   * exactly what you want to measure.
   */
  const [chatContext, setChatContext] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [transcribeResult, setTranscribeResult] = useState<TranscribeResult | null>(null);
  const [dragOver, setDragOver] = useState(false);
  /** Shared with VoiceCloner's own recorder — see lib/use-audio-recorder. */
  const sttRecorder = useAudioRecorder();
  /** Dictation for the two long-text fields on this page. See voice-input.tsx. */
  const chatVoice = useVoiceInput({
    onTranscript: (t) => setInput((v) => appendTranscript(v, t)),
    position: "top-1/2 right-2 -translate-y-1/2",
    label: "prompt",
  });
  const speakDictation = useVoiceInput({
    onTranscript: (t) => setTtsText((v) => appendTranscript(v, t)),
    label: "text to speak",
  });
  const [ttsText, setTtsText] = useState("");
  const [ttsVoice, setTtsVoice] = useState("alloy");
  /**
   * Voices the routed speech model actually has, asked of it rather than
   * hardcoded. `source: "none"` means nothing could be enumerated, and the UI
   * offers a free-text box instead of a list of guesses. See /api/tts/voices.
   */
  const [ttsVoices, setTtsVoices] = useState<{
    alias?: string;
    source: "service" | "declared" | "none";
    voices: VoiceOption[];
    /** The engine can learn a voice from a clip — see VoiceCloner. */
    canClone?: boolean;
    limits?: { minSeconds: number; maxSeconds: number };
    detail?: string;
    /** Routing could not be honoured — e.g. a cloud alias fell back to local. */
    degraded?: string;
  } | null>(null);
  /**
   * Which half of Speech Lab is on screen.
   *
   * The two directions were rendered side by side, so each got half the width
   * and neither got enough: the model row wrapped onto three lines and the work
   * itself — record, drop a file, type — was squeezed into what was left. They
   * are also not used together; you are transcribing or you are synthesising.
   */
  const [speechMode, setSpeechMode] = useState<"stt" | "tts">("stt");
  const [ttsSpeaking, setTtsSpeaking] = useState(false);
  const [ttsLatency, setTtsLatency] = useState<number | null>(null);
  /** Which model spoke — reported by /api/tts, so the panel can't imply "local" wrongly. */
  const [ttsModel, setTtsModel] = useState<string | null>(null);
  const [ttsError, setTtsError] = useState<string | null>(null);
  const [managedServices, setManagedServices] = useState<ManagedService[]>([]);
  const [actionInProgress, setActionInProgress] = useState<{ id: string; action: "start" | "stop" | "restart" } | null>(null);
  const [actionMessage, setActionMessage] = useState<{ id: string; text: string; type: "success" | "error" } | null>(null);
  const [gpu, setGpu] = useState<GpuStatus | null>(null);
  const [host, setHost] = useState<HostInfo | null>(null);
  /** Is this service registered on the host we are running on? Unknown host
   *  (before /api/host answers) counts as yes, so nothing is hidden by a race. */
  const hostHas = useCallback(
    (...ids: string[]) => !host || ids.some((id) => host.services.includes(id)),
    [host],
  );
  const [resourceControl, setResourceControl] = useState<ResourceControlSnapshot | null>(null);
  const [routing, setRouting] = useState<RoutingInfo | null>(null);
  /**
   * Qwen-Image's own health, purely so the stack card can list BOTH checkpoints it
   * serves. The manager sees one process on :8021 and the router publishes one
   * alias, so without this the separate ~20B image-edit model existed nowhere in
   * the stack view — the card looked like a single-model service.
   */
  const [qwenHealth, setQwenHealth] = useState<{
    up: boolean;
    model?: string;
    loaded?: boolean;
    mode?: string | null;
    edit?: { enabled: boolean; model: string; loaded: boolean };
  } | null>(null);
  /**
   * The AI Router's model catalogue, keyed by the service that backs each model.
   * Lets a service card say WHAT it serves — a process card that doesn't name its
   * model made you cross-reference the Models tab to answer "what's loaded?".
   * Same source as the Models tab, so the two can't disagree.
   */
  const [catalogByService, setCatalogByService] = useState<Record<string, CatalogEntry[]>>({});
  const [activeModels, setActiveModels] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<ConsoleTab>("stack");
  // Incremented to ask the cockpit to expand its Resource map panel.
  const [resourceMapSignal, setResourceMapSignal] = useState(0);
  /** Stack tab filter — All / GPU / or a service category. */
  const [stackFilter, setStackFilter] = useState<"all" | "attention" | "ai" | "monitoring" | "app">("all");
  const [compactStack, setCompactStack] = useState(true);
  /** Resource breakdown is collapsed by default — it's diagnostics, not status. */
  const [resourcesOpen, setResourcesOpen] = useState(false);
  const messagesEnd = useRef<HTMLDivElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);

  const selectTab = useCallback((next: ConsoleTab) => {
    setTab(next);
    window.localStorage.setItem("bt-active-tab", next);
    window.history.pushState({ tab: next }, "", `#${next}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  useEffect(() => {
    const valid = new Set<ConsoleTab>(["stack", "services", "storage", "llm", "arena", "speech", "qwen", "video", "requests", "usage", "sam3d", "sam3", "models"]);
    const resolve = () => {
      const hash = window.location.hash.slice(1) as ConsoleTab;
      const saved = window.localStorage.getItem("bt-active-tab") as ConsoleTab | null;
      const next = valid.has(hash) ? hash : saved && valid.has(saved) ? saved : "stack";
      setTab(next);
    };
    resolve();
    window.addEventListener("popstate", resolve);
    return () => window.removeEventListener("popstate", resolve);
  }, []);

  useEffect(() => {
    const saved = window.localStorage.getItem("bt-stack-density");
    if (saved) setCompactStack(saved !== "detail");
  }, []);

  // Only an explicit "off" overrides the default — an absent key means the user
  // has never touched this, and the default is on.
  useEffect(() => {
    if (window.localStorage.getItem("bt-chat-context") === "off") setChatContext(false);
  }, []);

  // Ask the routed speech model what voices it has, only while that panel is on
  // screen. Re-asked on an interval because the picker sitting directly above it
  // can repoint the capability at an engine with an entirely different voice set.
  // Ticks only while a reply is outstanding; the interval is torn down as soon
  // as `sending` clears, so an idle Chat tab is not re-rendering every second.
  useEffect(() => {
    if (!sending) return;
    const started = Date.now();
    const iv = setInterval(() => setSendingMs(Date.now() - started), 1000);
    return () => clearInterval(iv);
  }, [sending]);

  // Also called directly by VoiceCloner: a voice enrolled a moment ago should
  // reach the picker now, not on the next 10-second tick.
  const loadTtsVoices = useCallback(async () => {
    try {
      const res = await fetch("/api/tts/voices", { cache: "no-store" });
      setTtsVoices(await res.json());
    } catch {
      /* keep the last good list */
    }
  }, []);

  useEffect(() => {
    if (tab !== "speech" || speechMode !== "tts") return;
    loadTtsVoices();
    const iv = setInterval(loadTtsVoices, 10_000);
    return () => clearInterval(iv);
  }, [tab, speechMode, loadTtsVoices]);

  // Keep the selection valid. Switching engines used to leave "alloy" selected
  // against a model that has never heard of it, which fails at Speak time with a
  // server error rather than at pick time with a different list.
  useEffect(() => {
    if (!ttsVoices?.voices.length) return;
    if (ttsVoices.voices.some((v) => v.id === ttsVoice)) return;
    setTtsVoice(ttsVoices.voices[0].id);
  }, [ttsVoices, ttsVoice]);

  const checkHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/health");
      setHealth(await res.json());
    } catch {
      setHealth(null);
    }
  }, []);

  const fetchMetrics = useCallback(async () => {
    try {
      const res = await fetch("/api/metrics");
      if (res.ok) setMetrics(await res.json());
    } catch {
      /* ignore */
    }
  }, []);

  const fetchServices = useCallback(async () => {
    try {
      const res = await fetch("/api/services");
      if (res.ok) {
        const data = await res.json();
        // Defensive: only an array is a valid services payload. A flaky/wrong
        // backend must never crash the whole dashboard on managedServices.filter.
        const list: ManagedService[] = Array.isArray(data) ? data : [];
        setManagedServices(list);
        return list;
      }
    } catch { /* ignore */ }
    return [] as ManagedService[];
  }, []);

  const fetchRouting = useCallback(async () => {
    try {
      const res = await fetch("/api/routing");
      if (res.ok) setRouting(await res.json());
    } catch { /* ignore */ }
  }, []);

  const fetchHost = useCallback(async () => {
    try {
      const res = await fetch("/api/host");
      if (res.ok) setHost(await res.json());
    } catch { /* fall back to the generic labels */ }
  }, []);

  const fetchGpu = useCallback(async () => {
    try {
      const res = await fetch("/api/gpu");
      if (res.ok) setGpu(await res.json());
    } catch { /* ignore */ }
  }, []);

  const fetchResourceControl = useCallback(async () => {
    try {
      const res = await fetch("/api/resources");
      if (res.ok) setResourceControl(await res.json());
      else setResourceControl(null);
    } catch {
      setResourceControl(null);
    }
  }, []);

  const fetchQwenHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/qwen/health");
      if (res.ok) setQwenHealth(await res.json());
    } catch { /* service down — the card falls back to "unknown" */ }
  }, []);

  // Refresh everything at once, exposing a `refreshing` flag so the UI can show
  // it's actually doing something — on manual click AND on each auto tick.
  /** Group the router's models by the local service that backs them. */
  const fetchCatalog = useCallback(async () => {
    try {
      const data = await fetch("/api/providers").then((r) => r.json());
      const models: CatalogEntry[] = Array.isArray(data.models) ? data.models : [];
      const grouped: Record<string, CatalogEntry[]> = {};
      for (const m of models) {
        if (!m.serviceId) continue; // cloud models have no local process
        // A configured alias for an Ollama tag that is not installed is not a
        // model this service serves. Models keeps the unavailable row (with an
        // explicit status); service cards list only real occupants/candidates.
        if (m.status === "model-missing") continue;
        (grouped[m.serviceId] ??= []).push(m);
      }
      setCatalogByService(grouped);
      // alias -> capability, so a card can show which slot it currently serves
      const active: Record<string, string> = {};
      for (const [cap, alias] of Object.entries(data.routing ?? {})) {
        if (typeof alias === "string") active[alias] = cap;
      }
      setActiveModels(active);
    } catch {
      /* router down — cards simply omit model info */
    }
  }, []);

  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([
        fetchHost(), checkHealth(), fetchServices(), fetchRouting(), fetchGpu(), fetchResourceControl(), fetchCatalog(),
        // BeTenshi-only backends: skip the poll where the service is not registered,
        // rather than logging a guaranteed 502 every tick on another host.
        ...(hostHas("prometheus") ? [fetchMetrics()] : []),
        ...(hostHas("qwen") ? [fetchQwenHealth()] : []),
      ]);
    } finally {
      setRefreshing(false);
    }
  }, [fetchHost, hostHas, checkHealth, fetchMetrics, fetchServices, fetchRouting, fetchGpu, fetchResourceControl, fetchCatalog, fetchQwenHealth]);

  async function serviceAction(id: string, action: "start" | "stop" | "restart") {
    setActionInProgress({ id, action });
    setActionMessage(null);
    const startedAt = Date.now();
    // Auto-dismiss the transient feedback so a stale message can't linger.
    const dismissSuccess = () => window.setTimeout(() => setActionMessage((message) => (message?.id === id && message.type === "success" ? null : message)), 6000);
    try {
      const res = await fetch(`/api/services/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || `Service manager returned ${res.status}`);
      const defaultMsg = action === "start" ? "launching — model loading…" : action === "stop" ? "stopping…" : "restarting…";
      setActionMessage({ id, text: data.message || defaultMsg, type: "success" });
      // The manager returns the instant it fires the signal — the process is still
      // coming up / shutting down. Keep the control in its in-progress state and poll
      // until the service actually reaches the target, so it reads as genuinely live.
      const reached = (s?: ManagedService) =>
        !s ? false : action === "stop" ? s.status === "stopped" : s.status === "running" && s.healthy;
      const deadline = Date.now() + 60000;
      let list = await fetchServices();
      while (!reached(list.find((s) => s.id === id)) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
        list = await fetchServices();
      }
      if (!reached(list.find((service) => service.id === id))) {
        throw new Error(`Timed out waiting for ${id} to ${action === "stop" ? "stop" : "become healthy"}`);
      }
      setActionMessage({
        id,
        text: action === "stop" ? "Stopped" : action === "restart" ? "Restarted and healthy" : "Ready",
        type: "success",
      });
      dismissSuccess();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setActionMessage({ id, text: `Failed: ${message}`, type: "error" });
    }
    // Hold the in-progress state for a beat even if the service flips instantly
    // (SIGTERM is near-instant on Windows), so the action always reads as deliberate.
    const elapsed = Date.now() - startedAt;
    if (elapsed < 1000) await new Promise((r) => setTimeout(r, 1000 - elapsed));
    setActionInProgress(null);
  }

  useLiveRefresh(refreshAll, { intervalMs: autoRefresh ? 15000 : null });

  function startRecording() {
    sttRecorder.start(transcribeAudio, (message) =>
      setTranscribeResult({ text: message, latency: 0, fileName: "mic" }),
    );
  }

  async function transcribeAudio(file: File) {
    setTranscribing(true);
    setTranscribeResult(null);
    const start = Date.now();
    try {
      const form = new FormData();
      form.append("file", file);
      // Via the console, not straight at Whisper: /api/stt dispatches to whichever
      // model the Speech → text picker selected (local service or cloud via router).
      const res = await fetch("/api/stt", { method: "POST", body: form });
      const data = await res.json();
      setTranscribeResult({
        text: res.ok ? data.text : `Error: ${data.error}${data.detail ? ` — ${data.detail}` : ""}`,
        latency: data.latency ?? Date.now() - start,
        fileName: file.name,
        model: data.model,
        degraded: data.degraded,
      });
    } catch (err) {
      setTranscribeResult({ text: `Error: ${err}`, latency: Date.now() - start, fileName: file.name });
    }
    setTranscribing(false);
  }

  async function speakText(e: React.FormEvent) {
    e.preventDefault();
    if (!ttsText.trim() || ttsSpeaking) return;
    setTtsSpeaking(true);
    setTtsLatency(null);
    setTtsError(null);
    const start = Date.now();
    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: ttsText, voice: ttsVoice }),
      });
      if (!res.ok) {
        // The route names the picked model and why it couldn't be reached; showing
        // only "Error" here would send you hunting through the Stack tab for it.
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      setTtsLatency(Date.now() - start);
      setTtsModel(res.headers.get("X-TTS-Model"));
      if (ttsAudioRef.current) {
        ttsAudioRef.current.src = url;
        ttsAudioRef.current.play();
      }
    } catch (err) {
      setTtsLatency(-1);
      setTtsModel(null);
      setTtsError(err instanceof Error ? err.message : String(err));
    }
    setTtsSpeaking(false);
  }

  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function sendMessage(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || sending) return;
    const userMsg: ChatMessage = { role: "user", content: input };
    // Captured BEFORE the new message is appended: this is what came before it.
    // Error bubbles are excluded — they are this app talking, not the model, and
    // replaying "Error: fetch failed" as an assistant turn teaches it nothing.
    const priorTurns = chatContext
      ? messages
          .filter((m) => m.content && !(m.role === "assistant" && m.content.startsWith("Error: ")))
          .map((m) => ({ role: m.role, content: m.content }))
      : [];
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setSending(true);
    setSendingMs(0);
    try {
      // Go through our own route so it uses the active LLM (and no browser CORS
      // to the model). The server route resolves URL + served-model + auth.
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: input, history: priorTurns }),
      });
      const data = await res.json();
      setMessages((prev) => [
        ...prev,
        data.error
          ? { role: "assistant", content: `Error: ${typeof data.error === "string" ? data.error : JSON.stringify(data.error)}` }
          : {
              role: "assistant",
              content: data.content,
              thinking: data.thinking,
              truncated: data.truncated,
              maxTokens: data.maxTokens,
              dropped: data.dropped,
              latency: data.latency,
              tokens: data.usage?.total_tokens,
              model: data.model,
            },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `Connection error: ${err}` },
      ]);
    }
    setSending(false);
  }

  const { theme, toggle: toggleTheme } = useTheme();
  const m = metrics?.metrics || {};
  const getMetric = (partial: string) => {
    const key = Object.keys(m).find((k) => k.includes(partial));
    return key ? m[key] : null;
  };

  /** Is there any vLLM telemetry at all? Drives Model pulse's empty state. */
  const chatPulse = {
    live: ["num_requests_running", "generation_tokens_total", "time_to_first_token", "prefix_cache_hit_rate"]
      .some((k) => getMetric(k) !== null),
  };

  const serviceIconMap: Record<string, LucideIcon> = {
    vllm: Brain, whisper: Mic, tts: Volume2, webui: Globe,
    grafana: Activity, prometheus: Database, qwen: Sparkles, comfyui: Layers, sam3d: ScanLine, sam3: Scan,
  };

  const overallStatus =
    health && health.upCount === health.totalCount
      ? "operational"
      : health && health.upCount > 0
        ? "degraded"
        : "down";

  const runningServices = managedServices.filter((service) => service.status === "running").length;
  const readyServices = managedServices.filter(isReady).length;
  const onDemandServices = managedServices.filter(isOnDemand).length;
  const attentionServices = managedServices.filter(needsAttention);
  // Running, but started outside the manager: none of its configured environment
  // was applied and none of its output is captured. Not a failure, but not the
  // service as configured either, so it is surfaced on its own rather than
  // folded into either bucket.
  const adoptedServices = managedServices.filter(isAdopted);
  const queueDepth = (resourceControl?.queue.length ?? 0) + (resourceControl?.starts.length ?? 0);

  const tabs = [
    // Services and GPU were two views of the same local processes — one listing
    // them, one duplicating their controls under a GPU header. Merged into
    // "Stack": the GPU is the shared constraint every service competes for, so
    // it belongs above the cards rather than in a tab of its own.
    { id: "stack" as const, label: "Stack", count: runningServices + "/" + managedServices.length },
    { id: "services" as const, label: "Services" },
    { id: "storage" as const, label: "Storage" },
    { id: "llm" as const, label: "LLM" },
    { id: "speech" as const, label: "Speech" },
    // One tab for every image model on the box. "Creative" used to sit beside
    // this as a second, weaker generator for FLUX; the model is a picker inside
    // the studio now, so both share its gallery, queue and Activity feed.
    { id: "qwen" as const, label: "Image" },
    // Not gated on a service: the Arena compares cloud models too, so it is
    // useful on a host running no local models at all.
    { id: "arena" as const, label: "Arena" },
    { id: "requests" as const, label: "Requests" },
    { id: "usage" as const, label: "Usage" },
    { id: "sam3d" as const, label: "3D Body" },
    { id: "sam3" as const, label: "Segment" },
    { id: "models" as const, label: "Models" },
  ];

  return (
    <div className="console-shell min-h-screen bg-gray-950 text-gray-100">
      <ConsoleHeader
        active={tab}
        onSelect={selectTab}
        overallStatus={attentionServices.length === 0 && runningServices > 0 ? "operational" : overallStatus}
        readyServices={readyServices}
        onDemandServices={onDemandServices}
        attentionServices={attentionServices.length}
        refreshing={refreshing}
        onRefresh={refreshAll}
        autoRefresh={autoRefresh}
        onAutoRefresh={setAutoRefresh}
        hostName={host?.name ?? gpu?.host?.name}
      />
      <ResourcePulse
        gpu={gpu}
        resources={resourceControl}
        onOpenDetails={() => {
          selectTab("stack");
          // Expand it as well as scroll to it — see openResourceMapSignal.
          setResourceMapSignal((n) => n + 1);
          window.setTimeout(() => {
            document.getElementById("resource-map")?.scrollIntoView({ behavior: "smooth", block: "center" });
          }, tab === "stack" ? 0 : 100);
        }}
      />

      <main className="mx-auto max-w-[1500px] space-y-6 px-4 pb-24 pt-4 sm:px-6 sm:pt-5 md:pb-5">

        {HOSTED_RUNTIME && <HostedRuntimeNotice />}

        <TabErrorBoundary key={tab} label={tabs.find((item) => item.id === tab)?.label ?? "Console"}>

        {/* ── STACK TAB (services + GPU) ── */}
        {tab === "stack" && !HOSTED_RUNTIME && host && host.matchesProfile === false && (
          <ForeignProfileNotice profile={host.name} profileId={host.id} machine={host.machine ?? "this machine"} />
        )}
        {tab === "stack" && (
          <HomeCockpit
            managedServices={managedServices}
            catalogByService={catalogByService}
            gpu={gpu}
            resourceControl={resourceControl}
            queueDepth={queueDepth}
            attentionCount={attentionServices.length}
            onSelectTab={selectTab}
            onPrefillChat={(value) => {
              setInput(value);
              selectTab("llm");
            }}
            onPrefillSpeech={(value) => {
              setTtsText(value);
              selectTab("speech");
            }}
            onTranscribeFile={transcribeAudio}
            openResourceMapSignal={resourceMapSignal}
          />
        )}

        {tab === "services" && (
          <ServicesControlCenter
            services={managedServices}
            catalogByService={catalogByService}
            serviceVram={gpu?.service_vram ?? {}}
            serviceRam={gpu?.service_ram ?? {}}
            actionInProgress={actionInProgress}
            actionMessage={actionMessage}
            onDismissActionMessage={(id) => setActionMessage((message) => message?.id === id ? null : message)}
            onServiceAction={serviceAction}
            onSelectTab={selectTab}
          />
        )}

        {tab === "storage" && (HOSTED_RUNTIME ? (
          <LocalMachineRequired
            title="Storage Manager runs on the machine whose disks it manages"
            description="A hosted server cannot inspect your Mac or PC drives. Run Hangar locally to discover volumes, build the private file index, watch changes, reveal files, and perform guarded moves."
            available={["Real disk capacity and mounted volumes", "Private SQLite file index and duplicate candidates", "Filesystem watching, Finder or Explorer reveal, and guarded moves"]}
          />
        ) : <StorageManager />)}

        {/* Kept hidden for one checkpoint so the former Stack markup remains a
            local rollback while the new Home cockpit settles. */}
        {tab === "stack" && (
          <div className="hidden space-y-4" aria-hidden="true">
            <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Stack overview">
              <button type="button" onClick={() => setStackFilter("all")} className="rounded-xl border border-gray-800 bg-gray-900 p-3 text-left transition hover:border-gray-600">
                <span className="text-[10px] uppercase tracking-wide text-gray-600">Running</span>
                <span className="mt-1 block text-xl font-semibold tabular-nums text-gray-100">{runningServices}<span className="text-sm text-gray-600">/{managedServices.length}</span></span>
                <span className="text-[11px] text-gray-500">managed services ready</span>
              </button>
              <button type="button" onClick={() => setStackFilter("attention")} className={`rounded-xl border p-3 text-left transition ${attentionServices.length ? "border-amber-500/30 bg-amber-500/5 hover:border-amber-500/50" : "border-gray-800 bg-gray-900 hover:border-gray-600"}`}>
                <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-gray-600"><AlertTriangle className="h-3 w-3" /> Needs attention</span>
                <span className={`mt-1 block text-xl font-semibold tabular-nums ${attentionServices.length ? "text-amber-300" : "text-gray-100"}`}>{attentionServices.length}</span>
                <span className="text-[11px] text-gray-500">{adoptedServices.length ? `failed or unhealthy · ${adoptedServices.length} started outside` : "failed or unhealthy"}</span>
              </button>
              <div className="rounded-xl border border-gray-800 bg-gray-900 p-3">
                <span className="text-[10px] uppercase tracking-wide text-gray-600">GPU memory</span>
                <span className="mt-1 block text-xl font-semibold tabular-nums text-gray-100">{gpu && !gpu.error ? `${(gpu.mem_used / 1024).toFixed(1)} GB` : "—"}</span>
                <span className="text-[11px] text-gray-500">{gpu && !gpu.error ? `${(gpu.mem_free / 1024).toFixed(1)} GB free of ${(gpu.mem_total / 1024).toFixed(0)}` : "telemetry unavailable"}</span>
              </div>
              <div className="rounded-xl border border-gray-800 bg-gray-900 p-3">
                <span className="text-[10px] uppercase tracking-wide text-gray-600">Scheduler</span>
                <span className={`mt-1 block text-xl font-semibold tabular-nums ${queueDepth ? "text-sky-300" : "text-gray-100"}`}>{queueDepth}</span>
                <span className="text-[11px] text-gray-500">{resourceControl ? `${resourceControl.leases.length} active · ${resourceControl.queue.length} queued` : "manager reconnect required"}</span>
              </div>
            </section>
            {/* GPU strip — the shared constraint, above the things competing for it */}
            {gpu && !gpu.error ? (
              <section className={`rounded-xl border p-4 ${
                gpu.impact === "critical" ? "bg-red-500/5 border-red-500/30" :
                gpu.impact === "warning" ? "bg-yellow-500/5 border-yellow-500/30" :
                gpu.impact === "busy" ? "bg-orange-500/5 border-orange-500/30" :
                "bg-gray-900 border-gray-800"
              }`}>
                <div className="flex items-center gap-3 flex-wrap mb-3">
                  <Cpu className="w-4 h-4 text-gray-400" />
                  <span className="font-semibold text-sm">{gpu.name}</span>
                  <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${
                    gpu.impact === "critical" ? "bg-red-500/15 text-red-400" :
                    gpu.impact === "warning" ? "bg-yellow-500/15 text-yellow-400" :
                    gpu.impact === "busy" ? "bg-orange-500/15 text-orange-400" :
                    "bg-green-500/15 text-green-400"
                  }`}>{gpu.impact_msg}</span>
                  <span className="ml-auto flex items-center gap-4 text-[11px] text-gray-500 tabular-nums">
                    {gpu.gpu_util != null && <span>util <span className="text-gray-200 font-semibold">{gpu.gpu_util}%</span></span>}
                    {gpu.temperature != null && <span>temp <span className={`font-semibold ${gpu.temperature > 85 ? "text-red-400" : gpu.temperature > 70 ? "text-yellow-400" : "text-gray-200"}`}>{gpu.temperature}°C</span></span>}
                    {gpu.power_draw != null && gpu.power_limit != null && <span>power <span className="text-gray-200 font-semibold">{Math.round(gpu.power_draw)}W</span><span className="text-gray-600">/{Math.round(gpu.power_limit)}</span></span>}
                  </span>
                </div>

                {/* VRAM, segmented by the service holding it */}
                <div className="flex justify-between text-[11px] text-gray-500 mb-1.5 tabular-nums">
                  <span>{gpu.memory_model === "unified" ? "Memory (unified)" : "VRAM"}</span>
                  <span>{(gpu.mem_used / 1024).toFixed(1)} / {(gpu.mem_total / 1024).toFixed(1)} GB · {(gpu.mem_free / 1024).toFixed(1)} GB free</span>
                </div>
                <div className="h-4 bg-gray-800 rounded-full overflow-hidden flex">
                  {Object.entries(gpu.service_vram ?? {}).map(([id, svc]) => (
                    <div
                      key={id}
                      className={`h-full ${vramColor(id)} transition-all`}
                      style={{ width: `${svc.pct_of_total}%` }}
                      title={`${svc.name}: ${(svc.used_mb / 1024).toFixed(1)} GB`}
                    />
                  ))}
                  {gpu.vram_summary && gpu.vram_summary.unaccounted_mb > 0 && (
                    <div
                      className="h-full bg-gray-600/70"
                      style={{ width: `${(gpu.vram_summary.unaccounted_mb / gpu.mem_total) * 100}%` }}
                      title={`${(gpu.vram_summary.unaccounted_mb / 1024).toFixed(1)} GB — ${gpu.vram_summary.unaccounted_note}`}
                    />
                  )}
                </div>
                <div className="flex items-center gap-3 flex-wrap mt-2 text-[10px] text-gray-500">
                  {Object.entries(gpu.service_vram ?? {}).map(([id, svc]) => (
                    <span key={id} className="flex items-center gap-1.5">
                      <span className={`w-2 h-2 rounded-sm ${vramColor(id)}`} />
                      {svc.name} <span className="tabular-nums text-gray-400">{(svc.used_mb / 1024).toFixed(1)} GB</span>
                    </span>
                  ))}
                  {gpu.vram_summary && gpu.vram_summary.unaccounted_mb > 0 && (
                    <span className="flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-sm bg-gray-600/70" />
                      other <span className="tabular-nums text-gray-400">{(gpu.vram_summary.unaccounted_mb / 1024).toFixed(1)} GB</span>
                    </span>
                  )}
                </div>

                {/* HOST RAM — shown beside VRAM because on this box it is the
                    tighter budget and nothing was watching it. Qwen-Image keeps
                    ~28 GB of weights in system RAM for as long as it's loaded,
                    and a FLUX run wants a similar amount; the pair has already
                    OOM-killed the Qwen service while every VRAM figure above
                    looked perfectly healthy. */}
                {/* Only when it is a SEPARATE budget — on a unified host the bar above already is system memory. */}
                {gpu.host_ram && gpu.memory_model !== "unified" && (
                  <div className="mt-3 pt-3 border-t border-gray-800">
                    <div className="flex justify-between text-[11px] text-gray-500 mb-1.5 tabular-nums">
                      <span>System RAM</span>
                      <span>
                        {gpu.host_ram.used_gb} / {gpu.host_ram.total_gb} GB · {gpu.host_ram.free_gb} GB free
                      </span>
                    </div>
                    {/* Segmented like VRAM, so the two budgets read the same way. */}
                    <div className="h-2 bg-gray-800 rounded-full overflow-hidden flex">
                      {Object.entries(gpu.service_ram ?? {}).map(([id, svc]) => (
                        <div
                          key={id}
                          className={`h-full ${vramColor(id)} transition-all`}
                          style={{ width: `${svc.pct_of_total}%` }}
                          title={`${svc.name}: ${(svc.rss_mb / 1024).toFixed(1)} GB resident`}
                        />
                      ))}
                      {gpu.ram_summary && gpu.ram_summary.unaccounted_mb > 0 && gpu.host_ram.total_gb > 0 && (
                        <div
                          className="h-full bg-gray-600/70"
                          style={{ width: `${(gpu.ram_summary.unaccounted_mb / 1024 / gpu.host_ram.total_gb) * 100}%` }}
                          title={`${(gpu.ram_summary.unaccounted_mb / 1024).toFixed(1)} GB — ${gpu.ram_summary.unaccounted_note}`}
                        />
                      )}
                    </div>
                    {gpu.host_ram.free_gb < 8 && (
                      <p className="mt-1.5 text-[10px] text-amber-400/80">
                        Low — a second host-resident model (Qwen-Image or FLUX, ~28 GB each) will not load.
                      </p>
                    )}
                  </div>
                )}

                {/* The measured bars above explain what the machine is doing;
                    this is the control plane deciding what may happen next. */}
                {resourceControl && (
                  <div className="mt-3 pt-3 border-t border-gray-800 text-[11px]">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-gray-300">Work scheduler</span>
                      <span className={`px-1.5 py-0.5 rounded-full ${
                        resourceControl.leases.length
                          ? "bg-orange-500/15 text-orange-300"
                          : "bg-green-500/15 text-green-400"
                      }`}>
                        {resourceControl.leases.length ? `${resourceControl.leases.length} active` : "idle"}
                      </span>
                      <span className="text-gray-600">
                        {resourceControl.queue.length} queued · {resourceControl.starts.length} starting
                      </span>
                      <span className="ml-auto text-gray-600 tabular-nums">
                        modeled {resourceControl.usage.vramGb.toFixed(1)} GB VRAM · {resourceControl.usage.ramGb.toFixed(1)} GB RAM
                      </span>
                    </div>

                    {resourceControl.leases.map((lease) => (
                      <div key={lease.id} className="mt-2 flex items-center gap-2 rounded-md bg-gray-950/60 px-2.5 py-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-orange-400 animate-pulse" />
                        <span className="text-gray-300">{lease.workload}</span>
                        <span className="text-gray-600 truncate">{lease.owner}</span>
                        <span className="ml-auto text-gray-500 tabular-nums">
                          {lease.resources.vramGb.toFixed(1)} GB VRAM · {lease.lane}
                        </span>
                      </div>
                    ))}

                    {resourceControl.queue.slice(0, 3).map((item, index) => (
                      <div key={item.id} className="mt-1.5 flex items-center gap-2 text-gray-500">
                        <span className="tabular-nums text-gray-700">#{index + 1}</span>
                        <span className={item.lane === "interactive" ? "text-sky-300/80" : "text-gray-500"}>{item.lane}</span>
                        <span className="text-gray-400">{item.workload}</span>
                        <span className="truncate">{item.lastDenial?.message ?? "waiting for admission"}</span>
                      </div>
                    ))}

                    {resourceControl.lastEvent?.type.endsWith("blocked") && resourceControl.lastEvent.message && (
                      <p className="mt-2 text-amber-400/80">Last refusal: {resourceControl.lastEvent.message}</p>
                    )}
                  </div>
                )}

                {/* ── WHO IS HOLDING WHAT ──
                    Both budgets in one table, per service, with the control to
                    act on it. The bars above say a resource is nearly gone; only
                    this says which process to stop to get it back. Collapsed by
                    default — it's diagnostics, not everyday status. */}
                <button
                  onClick={() => setResourcesOpen((v) => !v)}
                  className="mt-3 w-full flex items-center gap-2 text-[11px] text-gray-500 hover:text-gray-300 transition"
                >
                  <span className={`transition-transform ${resourcesOpen ? "rotate-90" : ""}`}>›</span>
                  Consumption by service
                  <span className="text-gray-700">
                    · {Object.keys(gpu.service_ram ?? {}).length} holding RAM
                    · {Object.keys(gpu.service_vram ?? {}).length} holding {gpu.memory_model === "unified" ? "GPU memory" : "VRAM"}
                  </span>
                </button>

                {resourcesOpen && (
                  <div className="mt-2 rounded-lg border border-gray-800 overflow-hidden">
                    <table className="w-full text-[11px]">
                      <thead className="bg-gray-950/60 text-gray-500">
                        <tr className="text-left">
                          <th className="px-2.5 py-1.5 font-medium">service</th>
                          <th className="px-2.5 py-1.5 font-medium text-right">RAM</th>
                          <th className="px-2.5 py-1.5 font-medium text-right">{gpu.memory_model === "unified" ? "GPU alloc" : "VRAM"}</th>
                          <th className="px-2.5 py-1.5 font-medium text-right">pid</th>
                          <th className="px-2.5 py-1.5" />
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-800/70">
                        {[...new Set([
                          ...Object.keys(gpu.service_ram ?? {}),
                          ...Object.keys(gpu.service_vram ?? {}),
                        ])]
                          .sort((a, b) =>
                            ((gpu.service_ram?.[b]?.rss_mb ?? 0) + (gpu.service_vram?.[b]?.used_mb ?? 0)) -
                            ((gpu.service_ram?.[a]?.rss_mb ?? 0) + (gpu.service_vram?.[a]?.used_mb ?? 0)))
                          .map((id) => {
                            const ram = gpu.service_ram?.[id];
                            const vram = gpu.service_vram?.[id];
                            // docker-wsl is an aggregate of every container, not
                            // a service — there is nothing here to stop.
                            const managed = managedServices.find((s) => s.id === id);
                            const busy = actionInProgress?.id === id;
                            return (
                              <tr key={id} className="hover:bg-gray-900/60">
                                <td className="px-2.5 py-1.5">
                                  <span className="inline-flex items-center gap-1.5">
                                    <span className={`w-2 h-2 rounded-sm ${vramColor(id)}`} />
                                    {ram?.name ?? vram?.name ?? id}
                                  </span>
                                </td>
                                <td className="px-2.5 py-1.5 text-right tabular-nums text-sky-300/90">
                                  {ram ? `${(ram.rss_mb / 1024).toFixed(1)} GB` : "—"}
                                </td>
                                <td className="px-2.5 py-1.5 text-right tabular-nums text-violet-300/90">
                                  {vram ? `${(vram.used_mb / 1024).toFixed(1)} GB` : "—"}
                                </td>
                                <td className="px-2.5 py-1.5 text-right tabular-nums text-gray-600">
                                  {ram?.pid ? ram.pid : "—"}
                                </td>
                                <td className="px-2.5 py-1.5 text-right">
                                  {managed ? (
                                    <button
                                      onClick={() => serviceAction(id, "stop")}
                                      disabled={busy}
                                      className="text-[10px] px-2 py-0.5 rounded border border-red-500/30 text-red-400 hover:bg-red-500/10 transition disabled:opacity-40"
                                    >
                                      {busy ? "…" : "Stop"}
                                    </button>
                                  ) : (
                                    <span className="text-[10px] text-gray-700">—</span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        {gpu.ram_summary && gpu.ram_summary.unaccounted_mb > 0 && (
                          <tr className="text-gray-600">
                            <td className="px-2.5 py-1.5">
                              <span className="inline-flex items-center gap-1.5">
                                <span className="w-2 h-2 rounded-sm bg-gray-600/70" />
                                everything else
                              </span>
                            </td>
                            <td className="px-2.5 py-1.5 text-right tabular-nums">
                              {(gpu.ram_summary.unaccounted_mb / 1024).toFixed(1)} GB
                            </td>
                            <td className="px-2.5 py-1.5 text-right tabular-nums">
                              {gpu.vram_summary ? `${(gpu.vram_summary.unaccounted_mb / 1024).toFixed(1)} GB` : "—"}
                            </td>
                            <td colSpan={2} className="px-2.5 py-1.5 text-right text-[10px]">
                              {gpu.ram_summary.unaccounted_note}
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            ) : (
              <section className="rounded-xl border border-gray-800 bg-gray-900 p-4 text-[11px] text-gray-500">
                GPU stats unavailable{gpu?.error ? ` — ${gpu.error}` : ""}.
              </section>
            )}

            {/* Filters — one per category. There is deliberately NO "GPU" filter:
                it was a near-subset of "AI", and which services hold VRAM is
                already answered better by the bar above and the per-card figure
                than by hiding the rest of the stack. */}
            <div className="flex items-center gap-2 flex-wrap">
              {([
                ["all", "All"],
                ["attention", "Attention"],
                ["ai", "AI"],
                ["app", "App"],
                ["monitoring", "Monitor"],
              ] as const).map(([id, label]) => {
                const n = id === "all"
                  ? managedServices.length
                  : id === "attention"
                    ? attentionServices.length
                  : managedServices.filter((s) => s.category === id).length;
                return (
                  <button
                    key={id}
                    onClick={() => setStackFilter(id)}
                    className={`text-[11px] px-2.5 py-1 rounded-full border transition cursor-pointer ${
                      stackFilter === id
                        ? "bg-gray-100 text-gray-900 border-gray-100 font-medium"
                        : "border-gray-700 text-gray-400 hover:text-gray-100 hover:border-gray-500"
                    }`}
                  >
                    {label} <span className="tabular-nums opacity-60">{n}</span>
                  </button>
                );
              })}
              <div className="ml-auto flex items-center rounded-lg border border-gray-800 bg-gray-900 p-0.5" aria-label="Stack card density">
                <button
                  type="button"
                  onClick={() => { setCompactStack(true); window.localStorage.setItem("bt-stack-density", "compact"); }}
                  aria-pressed={compactStack}
                  className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] transition ${compactStack ? "bg-gray-100 text-gray-900" : "text-gray-500 hover:text-gray-200"}`}
                ><LayoutGrid className="h-3 w-3" /> Compact</button>
                <button
                  type="button"
                  onClick={() => { setCompactStack(false); window.localStorage.setItem("bt-stack-density", "detail"); }}
                  aria-pressed={!compactStack}
                  className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] transition ${!compactStack ? "bg-gray-100 text-gray-900" : "text-gray-500 hover:text-gray-200"}`}
                ><List className="h-3 w-3" /> Detail</button>
              </div>
            </div>

          {stackFilter === "attention" && attentionServices.length + adoptedServices.length === 0 && (
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-5 text-sm text-emerald-300">
              Nothing needs attention. Intentionally stopped on-demand services remain available under All.
            </div>
          )}
          <div className={`grid grid-cols-1 md:grid-cols-2 gap-3 ${compactStack ? "xl:grid-cols-4" : "lg:grid-cols-3"}`}>
            {managedServices.filter((s) =>
              stackFilter === "all"
                ? true
                : stackFilter === "attention"
                  ? needsAttention(s) || isAdopted(s)
                  : s.category === stackFilter,
            ).map((s) => {
              const isActing = actionInProgress?.id === s.id;
              const actingVerb = isActing ? actionInProgress!.action : null;
              const msg = actionMessage?.id === s.id ? actionMessage : null;
              const isRunning = s.status === "running";
              const isStarting = s.status === "starting";
              const isFailed = s.status === "failed";
              const r = routing?.services.find((rs) => rs.id === s.id);
              const isLocal = routing?.mode === "local";
              const Icon = serviceIconMap[s.id] ?? Server;

              /* All gray-N classes here work WITHOUT dark: variants —
                 globals.css inverts the scale so gray-900 is light in
                 light mode and dark in dark mode automatically. */
              type CatConfig = { badge: string; accent: string; iconBg: string; iconColor: string; label: string };
              const catMap: Record<string, CatConfig> = {
                ai:         { badge: "bg-violet-500/10 text-violet-400 border border-violet-500/20",  accent: "bg-violet-500",  iconBg: "bg-violet-500/15",  iconColor: "text-violet-400",  label: "AI" },
                monitoring: { badge: "bg-sky-500/10 text-sky-400 border border-sky-500/20",           accent: "bg-sky-500",     iconBg: "bg-sky-500/15",     iconColor: "text-sky-400",     label: "Monitor" },
                app:        { badge: "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20", accent: "bg-emerald-500", iconBg: "bg-emerald-500/15", iconColor: "text-emerald-400", label: "App" },
              };
              const cat: CatConfig = catMap[s.category] ?? {
                badge: "bg-gray-700/40 text-gray-400 border border-gray-700/60",
                accent: "bg-gray-600",
                iconBg: "bg-gray-800",
                iconColor: "text-gray-400",
                label: s.category,
              };

              return (
                <div key={s.id} className={`relative flex flex-col rounded-xl border overflow-hidden transition-all duration-200 ${
                  isRunning
                    ? "bg-gray-900 border-gray-700 shadow-[0_1px_3px_rgba(0,0,0,0.12)] hover:border-gray-600"
                    : "bg-gray-900 border-gray-800 hover:border-gray-700"
                }`}>

                  {/* Left accent bar — category color when running */}
                  <div className={`absolute inset-y-0 left-0 w-[3px] rounded-l-xl transition-all ${
                    isRunning ? cat.accent : isStarting ? "bg-amber-500/60" : "bg-transparent"
                  }`} />

                  {/* Card body */}
                  <div className="flex-1 px-4 pt-4 pb-3 pl-5">
                    {/* Header row */}
                    <div className="flex items-start gap-3 mb-3">
                      {/* Icon container */}
                      <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${
                        isRunning ? cat.iconBg : "bg-gray-800"
                      }`}>
                        <Icon className={`w-[17px] h-[17px] ${isRunning ? cat.iconColor : "text-gray-500"}`} />
                      </div>

                      {/* Name + status */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <h3 className="text-sm font-semibold text-gray-100 leading-none truncate">{s.name}</h3>
                          <span className={`text-[10px] uppercase tracking-widest font-bold px-1.5 py-0.5 rounded-md flex-shrink-0 ${cat.badge}`}>
                            {cat.label}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                            isActing ? "bg-amber-400 animate-pulse"
                            : isRunning  ? "bg-emerald-400 shadow-[0_0_5px_rgba(52,211,153,0.7)]"
                            : isStarting ? "bg-amber-400 animate-pulse"
                            : isFailed ? "bg-red-500 shadow-[0_0_5px_rgba(239,68,68,0.7)]"
                            : "bg-gray-600"
                          }`} />
                          <span className={`text-[11px] font-medium ${
                            isActing ? "text-amber-400"
                            : isRunning  ? "text-emerald-400"
                            : isStarting ? "text-amber-400"
                            : isFailed ? "text-red-400"
                            : "text-gray-500"
                          }`}>{isActing ? (actingVerb === "stop" ? "stopping…" : actingVerb === "restart" ? "restarting…" : "starting…") : s.status}</span>
                          <span className="text-gray-700 select-none">·</span>
                          <span className="text-[11px] font-mono text-gray-500">:{s.port}</span>
                          {s.pid && <><span className="text-gray-700 select-none">·</span><span className="text-[10px] font-mono text-gray-600">{s.pid}</span></>}
                          {/* Started outside the manager: it runs, but with none of
                              its configured env and with no captured output. Silent
                              until now — this is what made Qwen-Image serve with its
                              edit checkpoint disabled and an empty log panel. */}
                          {s.owner === "external" && (
                            <>
                              <span className="text-gray-700 select-none">·</span>
                              <span
                                title="Started outside the manager — its configured environment wasn't applied and its output isn't captured. Restart to hand it over."
                                className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20 font-medium cursor-help"
                              >
                                external
                              </span>
                            </>
                          )}
                          {/* This service's own VRAM — the link between a
                              process and the resource it's consuming. */}
                          {gpu?.service_vram?.[s.id] && (
                            <>
                              <span className="text-gray-700 select-none">·</span>
                              <span className="flex items-center gap-1 text-[10px] tabular-nums text-gray-400">
                                <span className={`w-1.5 h-1.5 rounded-sm ${vramColor(s.id)}`} />
                                {(gpu.service_vram[s.id].used_mb / 1024).toFixed(1)} GB
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* What this process actually serves. A service card that
                        names its port but not its model made "what's loaded?" a
                        trip to another tab. Sourced from the same router
                        catalogue the Models tab uses, so they can't disagree. */}
                    {(catalogByService[s.id]?.length ?? 0) > 0 && (
                      <div className="mb-2 space-y-1">
                        {catalogByService[s.id].slice(0, compactStack ? 1 : undefined).map((m) => (
                          <div key={m.id} className="flex items-baseline gap-1.5 flex-wrap">
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-400 border border-violet-500/20 font-medium">
                              {m.id}
                            </span>
                            {activeModels[m.id] && (
                              <span className="text-[9px] uppercase tracking-wide px-1 py-0.5 rounded bg-indigo-500/15 text-indigo-300">
                                active · {activeModels[m.id]}
                              </span>
                            )}
                            {m.params && !compactStack && <span className="text-[10px] text-gray-500">{m.params}</span>}
                            {/* Live VRAM when the service is up, expected cost when
                                it isn't — the card already shows one, never the other. */}
                            <ModelFootprint
                              footprint={m.footprint}
                              liveVramMb={gpu?.service_vram?.[s.id]?.used_mb ?? null}
                            />
                            {m.checkpoint && !compactStack && (
                              <span className="text-[10px] font-mono text-gray-600 truncate w-full" title={m.checkpoint}>
                                {m.checkpoint}
                              </span>
                            )}
                          </div>
                        ))}
                        {compactStack && catalogByService[s.id].length > 1 && (
                          <span className="text-[10px] text-gray-600">+{catalogByService[s.id].length - 1} more model alias</span>
                        )}
                      </div>
                    )}

                    {/* Qwen-Image serves TWO separate ~20B checkpoints from one
                        process, and only one is in VRAM at a time. The manager and
                        the router both see a single service, so the split is only
                        visible if the card reads the service's own /health. */}
                    {s.id === "qwen" && !compactStack && (
                      <div className="mb-2 space-y-1">
                        <p className="text-[10px] uppercase tracking-wide text-gray-600">
                          Checkpoints · one in VRAM at a time
                        </p>
                        {[
                          {
                            key: "gen",
                            name: qwenHealth?.model || "Qwen-Image",
                            installed: true,
                            resident: !!qwenHealth?.loaded,
                            use: "text→image",
                          },
                          {
                            key: "edit",
                            name: qwenHealth?.edit?.model || "Qwen-Image-Edit",
                            installed: !!qwenHealth?.edit?.enabled,
                            resident: !!qwenHealth?.edit?.loaded,
                            use: "image edit",
                          },
                        ].map((c) => (
                          <div key={c.key} className="flex items-center gap-1.5 flex-wrap">
                            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                              !qwenHealth?.up || !c.installed ? "bg-gray-600"
                              : c.resident ? "bg-emerald-400 shadow-[0_0_5px_rgba(52,211,153,0.7)]"
                              : "bg-yellow-500/70"
                            }`} />
                            <span className="text-[11px] text-gray-300">{c.name}</span>
                            <span className="text-[10px] text-gray-600">{c.use}</span>
                            <span className="text-[10px] text-gray-500">
                              {!qwenHealth?.up
                                ? "· unknown"
                                : !c.installed
                                  ? "· not installed"
                                  : c.resident
                                    ? "· in VRAM"
                                    : "· loads on demand"}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Routing */}
                    {r && !compactStack && (
                      <div className="bg-gray-800/60 rounded-lg px-3 py-2 space-y-1.5 text-[11px] font-mono">
                        <div className="flex items-center gap-2">
                          <span className={`w-1 h-1 rounded-full flex-shrink-0 ${isLocal ? "bg-emerald-400" : "bg-gray-600"}`} />
                          <span className={isLocal ? "text-emerald-400" : "text-gray-600"}>localhost:{r.localPort}</span>
                          {isLocal && <span className="ml-auto font-sans text-[10px] font-semibold text-emerald-500 tracking-wide">live</span>}
                        </div>
                        <div className="flex items-center gap-2">
                          <span className={`w-1 h-1 rounded-full flex-shrink-0 ${!isLocal ? "bg-indigo-400" : "bg-gray-600"}`} />
                          <span className={`truncate ${!isLocal ? "text-indigo-400" : "text-gray-600"}`}>{r.publicUrl.replace("https://", "")}</span>
                          {!isLocal && <span className="ml-auto font-sans text-[10px] font-semibold text-indigo-400 flex-shrink-0 tracking-wide">live</span>}
                        </div>
                      </div>
                    )}

                    {/* Feedback message */}
                    {msg && (
                      <div role="status" aria-live="polite" className={`mt-2 text-[11px] px-3 py-1.5 rounded-lg border ${
                        msg.type === "error"
                          ? "bg-red-500/10 text-red-400 border-red-500/20"
                          : "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                      }`}>{msg.text}</div>
                    )}

                    {/* Crash surfaced by the manager — a failed start, not a clean stop */}
                    {isFailed && s.error && (
                      <div className="mt-2 text-[11px] px-3 py-1.5 rounded-lg border bg-red-500/10 text-red-400 border-red-500/20">
                        <span className="font-semibold">Failed to start.</span>{" "}
                        <span className="font-mono break-all">{s.error}</span>
                      </div>
                    )}
                  </div>

                  {/* Footer — action strip */}
                  <div className="border-t border-gray-800 px-3 py-2 flex items-center gap-1">
                    {isActing ? (
                      <div className="flex-1 flex items-center justify-center gap-2 py-1.5 text-xs font-medium text-amber-400 select-none">
                        <Spinner />
                        {actingVerb === "stop" ? "Stopping…" : actingVerb === "restart" ? "Restarting…" : "Starting…"}
                      </div>
                    ) : isRunning || isStarting ? (
                      <>
                        <button onClick={() => serviceAction(s.id, "stop")}
                          className="flex-1 py-1.5 rounded-lg text-xs font-medium transition-all text-red-400 hover:bg-red-500/10 hover:text-red-300">
                          Stop
                        </button>
                        <div className="w-px h-4 bg-gray-800 flex-shrink-0" />
                        <button onClick={() => serviceAction(s.id, "restart")}
                          className="flex-1 py-1.5 rounded-lg text-xs font-medium transition-all text-amber-400 hover:bg-amber-500/10 hover:text-amber-300">
                          Restart
                        </button>
                      </>
                    ) : (
                      <button onClick={() => serviceAction(s.id, "start")}
                        className="flex-1 py-1.5 rounded-lg text-xs font-medium transition-all text-emerald-400 hover:bg-emerald-500/10 hover:text-emerald-300">
                        Start
                      </button>
                    )}
                    <div className="w-px h-4 bg-gray-800 flex-shrink-0" />
                    {/* Same button component every other surface uses — this card
                        only supplies the strip's own sizing. */}
                    <ServiceLogsButton
                      id={s.id}
                      name={s.name}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium transition-all text-gray-500 hover:bg-gray-800 hover:text-gray-300"
                    />
                    {/* Open / Test CTA — only when running */}
                    {isRunning && (() => {
                      type TabId = "llm" | "speech" | "stack" | "qwen" | "requests" | "sam3d" | "sam3" | "models";
                      type Cta = { label: string; goTab?: TabId; href?: string };
                      const ctaMap: Record<string, Cta> = {
                        vllm:       { label: "Playground", goTab: "llm" },
                        whisper:    { label: "Test",       goTab: "speech" },
                        tts:        { label: "Test",       goTab: "speech" },
                        webui:      { label: "Open",       href: r?.activeUrl ?? `http://localhost:${s.port}` },
                        grafana:    { label: "Open",       href: r?.activeUrl ?? `http://localhost:${s.port}` },
                        prometheus: { label: "Open",       href: r?.activeUrl ?? `http://localhost:${s.port}` },
                        qwen:       { label: "Studio",     goTab: "qwen" },
                        comfyui:    { label: "Open",       href: r?.activeUrl ?? `http://localhost:${s.port}` },
                        sam3d:      { label: "Test",       goTab: "sam3d" },
                        sam3:       { label: "Try",        goTab: "sam3" },
                      };
                      const cta = ctaMap[s.id];
                      if (!cta) return null;
                      const cls = "flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all text-indigo-400 hover:bg-indigo-500/10 hover:text-indigo-300 flex-shrink-0";
                      if (cta.goTab) return (
                        <>
                          <div className="w-px h-4 bg-gray-800 flex-shrink-0" />
                          <button onClick={() => selectTab(cta.goTab!)} className={cls}>
                            {cta.label}
                          </button>
                        </>
                      );
                      return (
                        <>
                          <div className="w-px h-4 bg-gray-800 flex-shrink-0" />
                          <a href={cta.href} target="_blank" rel="noreferrer" className={cls}>
                            {cta.label} <ExternalLink className="w-3 h-3" />
                          </a>
                        </>
                      );
                    })()}
                  </div>
                </div>
              );
            })}
          </div>
          </div>
        )}

        {/* ── LLM TAB ── */}
        {tab === "llm" && (
          <div className="tool-page chat-page chat-page-layout">
            <ToolPageHeader
              eyebrow="Text workstream"
              title="Chat & Code"
              description="Test local reasoning, inspect response speed, and keep the active text model in view while you work."
              icon={<ChatCircleText size={24} weight="duotone" />}
              meta={<span className="tool-page-chip">OpenAI-compatible</span>}
            />
            {/* Model + telemetry as one control strip above the work.

                This page is for TALKING to a model; choosing one is the
                prerequisite, not the point. As a 22rem rail of five expanded
                cards the picker took most of the page's visual weight and pushed
                the conversation — the actual work — into a narrow column beside
                it, while telemetry fell below the fold. One line of controls, and
                the playground gets the full width. The expanded per-model list
                still exists on the Models tab, which is the page that IS about
                models. */}
            <div className="chat-controlbar">
              <ModelPicker capability="text" exclusiveLocal compact className="chat-model-picker" />

              {/* Whether the thread is a conversation or a series of unrelated
                  prompts. It was silently the latter, which reads as the model
                  being forgetful rather than as a setting. */}
              {/* Utility classes, not a rule in globals.css. The theme tokens
                  this file's custom CSS uses resolve inconsistently here, and
                  the surrounding chat controls are all written this way. */}
              <div className="flex flex-shrink-0 items-center gap-1">
                <button
                  type="button"
                  role="switch"
                  aria-checked={chatContext}
                  onClick={() => {
                    const next = !chatContext;
                    setChatContext(next);
                    try {
                      window.localStorage.setItem("bt-chat-context", next ? "on" : "off");
                    } catch {
                      /* private window — the toggle still works for this session */
                    }
                  }}
                  title={
                    chatContext
                      ? "Each prompt is sent with the conversation so far. Turn off to send prompts in isolation."
                      : "Each prompt is sent on its own — the model sees no earlier turns."
                  }
                  className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-[11px] font-medium transition ${
                    chatContext
                      ? "border-violet-500/40 bg-violet-500/5 text-violet-300 hover:border-violet-500/60"
                      : "border-gray-800 bg-gray-900 text-gray-500 hover:border-gray-600 hover:text-gray-300"
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      chatContext ? "bg-violet-400 shadow-[0_0_6px_rgba(167,139,250,0.9)]" : "bg-gray-600"
                    }`}
                  />
                  {chatContext ? "Context on" : "Context off"}
                </button>
                {messages.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setMessages([])}
                    title="Start a new thread — the model stops seeing these turns"
                    className="rounded-lg px-2 py-2 text-[11px] text-gray-500 transition hover:text-gray-200"
                  >
                    Clear
                  </button>
                )}
              </div>

              {/* These four counters are scraped from vLLM's OWN /metrics, so
                  they are blank whenever no vLLM is running — which is most of
                  the time, since Ollama serves the other three local models and
                  publishes none of them. */}
              <div className="chat-pulse" title="From the running vLLM server's /metrics">
                {chatPulse.live ? (
                  <>
                    <PulseStat label="active" value={getMetric("num_requests_running")} />
                    <PulseStat label="tokens" value={getMetric("generation_tokens_total")} compact />
                    <PulseStat label="TTFT" value={getMetric("time_to_first_token")} suffix="s" decimals={3} />
                    <PulseStat label="cache" value={getMetric("prefix_cache_hit_rate")} suffix="%" multiplier={100} decimals={1} />
                  </>
                ) : (
                  <span className="chat-pulse-empty">
                    No vLLM telemetry — start{" "}
                    <code className="text-gray-400">local-coder</code> or{" "}
                    <code className="text-gray-400">local-small</code>. Ollama models don&apos;t
                    publish counters.
                  </span>
                )}
              </div>
            </div>

            {/* Chat Playground */}
            <section className="chat-playground">
              <ToolSectionHeading eyebrow="Playground" title="Start a conversation" description="Prompt the selected model and inspect its thinking, latency, and token use." />
              {/* Height comes from .chat-canvas, which derives it from the
                  viewport — see the note there about the double scrollbar. */}
              <div className="tool-panel chat-canvas bg-gray-900 rounded-xl border border-gray-800 flex flex-col">
                <div className="flex-1 overflow-y-auto p-5 space-y-4">
                  {messages.length === 0 && (
                    <div className="flex items-center justify-center h-full">
                      <div className="text-center">
                        <div className="chat-empty-mark"><ChatCircleText size={30} weight="duotone" /></div>
                        <p className="text-gray-300 text-base font-semibold">Your local model is ready for a prompt</p>
                        <p className="text-gray-500 text-xs mt-1">Ask for code, analysis, or a quick reasoning check.</p>
                        <div className="chat-starter-row">
                          {["Explain a code path", "Draft a unit test", "Think through a bug"].map((starter) => (
                            <button key={starter} type="button" onClick={() => setInput(starter)}>{starter}</button>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                  {messages.map((msg, i) => (
                    <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                      <div className={`max-w-[75%] rounded-2xl px-4 py-3 ${
                        msg.role === "user" ? "bg-blue-600 on-accent" : "bg-gray-800 text-gray-100"
                      }`}>
                        {/* Thinking first and collapsed: it's the interesting
                            part of a reasoning model, but it is not the answer. */}
                        {msg.thinking && <ThinkingBlock text={msg.thinking} />}
                        {/* The user's own text is literal — rendering it as
                            markdown would reformat what they typed. */}
                        {msg.role === "user" ? (
                          <pre className="whitespace-pre-wrap text-sm font-sans leading-relaxed">{msg.content}</pre>
                        ) : msg.content ? (
                          <Markdown>{msg.content}</Markdown>
                        ) : (
                          <p className="text-sm italic text-gray-400">
                            {msg.truncated
                              ? "Spent the whole token budget thinking — no answer left. Raise max_tokens."
                              : "Empty reply."}
                          </p>
                        )}
                        {/* A cut-off reply that still HAS content said nothing
                            at all before — the notice below was reachable only
                            when the model returned an empty string. So "give me
                            100 prompts" stopped mid-list and looked like the
                            model's own choice. */}
                        {msg.truncated && msg.content ? (
                          <p className="mt-2 rounded-md border border-amber-500/25 bg-amber-500/5 px-2 py-1 text-[11px] text-amber-400">
                            Cut off at the {msg.maxTokens ?? "token"} limit — ask for less, or for the rest.
                          </p>
                        ) : null}
                        {/* Without this, a thread outgrowing the history budget
                            looks exactly like the model forgetting — which is
                            the bug this whole change exists to fix. */}
                        {msg.dropped ? (
                          <p className="mt-2 text-[11px] text-gray-500">
                            The first {msg.dropped} turn{msg.dropped === 1 ? "" : "s"} no longer fit and
                            were not sent. Clear the thread to start fresh.
                          </p>
                        ) : null}
                        {msg.latency != null && (
                          <div className="flex items-center gap-2 mt-2 text-xs text-gray-400">
                            <span>{msg.latency}ms</span>
                            {msg.tokens != null && (<><span className="text-gray-600">|</span><span>{msg.tokens} tokens</span></>)}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                  {sending && (
                    <div className="flex justify-start">
                      <div className="bg-gray-800 rounded-2xl px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="flex gap-1">
                            <div className="w-2 h-2 bg-gray-500 rounded-full animate-bounce [animation-delay:0ms]" />
                            <div className="w-2 h-2 bg-gray-500 rounded-full animate-bounce [animation-delay:150ms]" />
                            <div className="w-2 h-2 bg-gray-500 rounded-full animate-bounce [animation-delay:300ms]" />
                          </div>
                          {/* Three dots alone read as "stuck" once the wait runs
                              past a few seconds, and a local 31B routinely takes
                              half a minute. A counter says "working", and the
                              cold-start note says why the first one is worse. */}
                          <span className="text-[11px] tabular-nums text-gray-500">
                            {(sendingMs / 1000).toFixed(0)}s
                            {sendingMs > 12_000 ? " · a local model this size takes a while" : ""}
                          </span>
                        </div>
                      </div>
                    </div>
                  )}
                  <div ref={messagesEnd} />
                </div>
                <form onSubmit={sendMessage} className="p-4 border-t border-gray-800">
                  <div className="flex gap-3">
                    {/* Single line, so the mic is centred rather than pinned to
                        the top corner the way it sits on a tall prompt box. */}
                    <div className="relative flex-1">
                      <input type="text" value={input} onChange={(e) => setInput(e.target.value)}
                        placeholder="Ask the local model anything..."
                        className="w-full bg-gray-800 rounded-xl pl-4 pr-12 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 placeholder-gray-500"
                        disabled={sending} />
                      {chatVoice.mic}
                    </div>
                    <button type="submit" disabled={sending || !input.trim()}
                      className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:hover:bg-blue-600 rounded-xl px-5 py-2.5 text-sm font-medium transition">
                      Run
                    </button>
                  </div>
                  {chatVoice.banner && <div className="mt-2">{chatVoice.banner}</div>}
                </form>
              </div>
            </section>
          </div>
        )}

        {/* ── SPEECH TAB ── */}
        {tab === "speech" && !hostHasTab("speech") && <HostUnavailable tab="speech" title="Speech" />}
        {tab === "speech" && hostHasTab("speech") && (
          <div className="tool-page speech-page">
            <ToolPageHeader
              eyebrow="Voice workstream"
              title="Speech Lab"
              description="Transcribe recordings and synthesize natural speech from one focused local audio workspace."
              icon={<WaveformIcon size={24} weight="duotone" />}
              meta={<span className="tool-page-chip">{SPEECH_ENGINES}</span>}
            />
            {/* One direction at a time. See `speechMode`. */}
            <div className="speech-mode-tabs" role="tablist" aria-label="Speech direction">
              <button
                type="button"
                role="tab"
                aria-selected={speechMode === "stt"}
                onClick={() => setSpeechMode("stt")}
                className={speechMode === "stt" ? "is-active" : ""}
              >
                Speech → text
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={speechMode === "tts"}
                onClick={() => setSpeechMode("tts")}
                className={speechMode === "tts" ? "is-active" : ""}
              >
                Text → speech
              </button>
            </div>
            <div className="speech-workspace-grid">
            {/* Transcribe (STT) */}
            {speechMode === "stt" && (
            <section className="tool-panel speech-workspace">
              {/* Status + pick for the model this panel uses. Both speech services
                  are small enough to co-reside, so unlike the LLM picker there's no
                  stop-the-others logic — Start/Stop is per model. */}
              <ModelPicker capability="stt" className="mb-3" compact />
              <div className="flex gap-4 items-stretch">
                <button
                  onClick={sttRecorder.recording ? sttRecorder.stop : startRecording}
                  disabled={transcribing}
                  className={`flex flex-col items-center justify-center gap-2 rounded-xl px-8 py-6 font-medium transition flex-shrink-0 ${
                    sttRecorder.recording
                      ? "bg-red-600 hover:bg-red-500 shadow-[0_0_20px_rgba(239,68,68,0.4)]"
                      : "bg-gray-800 hover:bg-gray-700 border border-gray-700"
                  } disabled:opacity-40`}
                >
                  <span className="text-3xl">{sttRecorder.recording ? "⏹" : "🎙"}</span>
                  <span className="text-xs text-gray-300">
                    {sttRecorder.recording ? `${(sttRecorder.ms / 1000).toFixed(1)}s — stop` : "Record"}
                  </span>
                </button>
                <div
                  className={`flex-1 bg-gray-900 rounded-xl border-2 border-dashed transition p-6 text-center cursor-pointer ${
                    dragOver ? "border-blue-500 bg-blue-500/5" : "border-gray-700 hover:border-gray-500"
                  }`}
                  onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={(e) => { e.preventDefault(); setDragOver(false); const file = e.dataTransfer.files[0]; if (file) transcribeAudio(file); }}
                  onClick={() => audioInputRef.current?.click()}
                >
                  <input ref={audioInputRef} type="file" accept="audio/*" className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) transcribeAudio(f); }} />
                  {transcribing ? (
                    <div className="flex items-center justify-center gap-3 text-gray-400 h-full">
                      <div className="w-2 h-2 bg-blue-400 rounded-full animate-bounce [animation-delay:0ms]" />
                      <div className="w-2 h-2 bg-blue-400 rounded-full animate-bounce [animation-delay:150ms]" />
                      <div className="w-2 h-2 bg-blue-400 rounded-full animate-bounce [animation-delay:300ms]" />
                      <span className="text-sm">Transcribing on GPU...</span>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center h-full">
                      <p className="text-sm text-gray-400">Drop audio file or click to upload</p>
                      <p className="text-xs text-gray-600 mt-1">mp3, wav, m4a, ogg, webm</p>
                    </div>
                  )}
                </div>
              </div>
              {transcribeResult && (
                <div className="mt-3 bg-gray-900 rounded-xl border border-gray-800 p-5">
                  <div className="flex items-center justify-between gap-3 mb-2">
                    <span className="text-xs text-gray-500 truncate">{transcribeResult.fileName}</span>
                    <span className="flex items-center gap-2 flex-shrink-0">
                      {transcribeResult.model && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-400 border border-violet-500/20 font-medium">
                          {transcribeResult.model}
                        </span>
                      )}
                      <span className="text-xs text-green-400">{transcribeResult.latency}ms</span>
                    </span>
                  </div>
                  <p className="text-sm text-gray-100 leading-relaxed">{transcribeResult.text || <span className="text-gray-500 italic">No speech detected</span>}</p>
                  {transcribeResult.degraded && (
                    <p className="mt-2 text-[11px] text-amber-400">{transcribeResult.degraded}</p>
                  )}
                </div>
              )}
              <ModelDiscovery capability="stt" label="speech → text" className="mt-3" />
            </section>
            )}

            {/* Text-to-Speech */}
            {speechMode === "tts" && (
            <section className="tool-panel speech-workspace">
              <ModelPicker capability="tts" className="mb-3" compact />
              <form onSubmit={speakText} className="bg-gray-900 rounded-xl border border-gray-800 p-5">
                <div className="flex gap-3 mb-3">
                  {/* Dictating what to say aloud sounds circular, and is not:
                      this is the shortest path from a spoken thought to the
                      same thought in a cloned voice. */}
                  <div className="relative flex-1">
                    <textarea value={ttsText} onChange={(e) => setTtsText(e.target.value)}
                      placeholder="Type text to speak..." rows={2}
                      className="w-full bg-gray-800 rounded-xl pl-4 pr-14 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500/50 placeholder-gray-500 resize-none" />
                    {speakDictation.mic}
                  </div>
                  <div className="flex flex-col gap-2">
                    {/* The routed engine's own voices. Six names used to be
                        hardcoded here; they were right for Kokoro and wrong for
                        every cloud engine, and they hid the ~40 other voices
                        Kokoro accepts by its own id. */}
                    {ttsVoices && ttsVoices.voices.length === 0 ? (
                      <input
                        type="text"
                        value={ttsVoice}
                        onChange={(e) => setTtsVoice(e.target.value)}
                        placeholder="voice name"
                        title={ttsVoices.detail}
                        className="w-36 rounded-md border border-gray-700 bg-gray-800 px-2 py-1 text-xs text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500/50"
                      />
                    ) : (
                      <Select value={ttsVoice} onValueChange={(v) => v && setTtsVoice(v)}>
                        <SelectTrigger className="w-36 bg-gray-800 border-gray-700 text-xs text-gray-300">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="bg-gray-800 border-gray-700 text-gray-300">
                          {(ttsVoices?.voices ?? [{ id: ttsVoice }]).map((v) => (
                            <SelectItem key={v.id} value={v.id} className="text-xs">
                              {v.label ?? v.id}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                    <button type="submit" disabled={ttsSpeaking || !ttsText.trim()}
                      className="bg-purple-600 hover:bg-purple-500 disabled:opacity-40 rounded-lg px-4 py-1.5 text-sm font-medium transition">
                      {ttsSpeaking ? "..." : "Speak"}
                    </button>
                  </div>
                </div>
                <div className={`flex items-center gap-3 text-xs mt-3 ${ttsLatency === null ? "invisible" : ""}`}>
                  <span className={ttsLatency !== null && ttsLatency < 0 ? "text-red-400" : "text-green-400"}>
                    {ttsLatency !== null && ttsLatency < 0 ? "Error" : ttsLatency !== null ? `${ttsLatency}ms` : ""}
                  </span>
                  {ttsModel && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-400 border border-violet-500/20 font-medium flex-shrink-0">
                      {ttsModel}
                    </span>
                  )}
                  <audio ref={ttsAudioRef} controls className="h-8 flex-1" />
                </div>
                <div className={ttsError ? "mt-2 text-[11px] text-red-400" : "hidden"}>
                  {ttsError}
                </div>
                {speakDictation.banner && <div className="mt-2">{speakDictation.banner}</div>}
                {/* The routing could not be honoured. Without this the panel
                    shows a cloud alias beside the local engine's voices and
                    nothing explains the mismatch. */}
                {ttsVoices?.degraded && (
                  <p className="mt-2 text-[11px] text-amber-400">{ttsVoices.degraded}</p>
                )}
              </form>
              {/* Enrolling a voice belongs here, beside the picker it feeds —
                  a clone is an entry in that dropdown, not a separate feature. */}
              <VoiceCloner
                voices={ttsVoices?.voices ?? []}
                canClone={!!ttsVoices?.canClone}
                alias={ttsVoices?.alias ?? "This model"}
                limits={ttsVoices?.limits}
                onChanged={loadTtsVoices}
                className="mt-3"
              />
              <ModelDiscovery capability="tts" label="text → speech" className="mt-3" />
            </section>
            )}
            </div>
          </div>
        )}

        {/* ── CREATIVE TAB ── */}

        {/* ── IMAGE TAB — Qwen-Image + FLUX, model picked inside the studio ── */}
        {tab === "qwen" && (HOSTED_RUNTIME ? (
          <LocalMachineRequired
            title="Image Studio keeps its queue and gallery on the machine"
            description="Generation depends on installed model services and a persistent local gallery. The hosted site does not write generated images into an ephemeral server filesystem."
            available={["Installed Qwen and ComfyUI checkpoints", "Persistent generated-image gallery and folders", "Local GPU admission control and resumable queues"]}
          />
        ) : hostHasTab("qwen") ? <QwenTab /> : <HostUnavailable tab="qwen" title="Image Studio" />)}

        {tab === "video" && (HOSTED_RUNTIME ? (
          <LocalMachineRequired
            title="Video Studio runs on the local machine"
            description="Wan video generation uses the installed Draw Things models and substantial unified memory. The hosted site cannot reach or run those local checkpoints."
            available={["Local text-to-video with Wan 2.2", "Optional image-to-video starting frame", "Serialized generation that shares memory safely with image and speech"]}
          />
        ) : hostHasTab("video") ? <VideoStudio /> : <HostUnavailable tab="video" title="Video Studio" />)}

        {/* Arena — one prompt across several chat/vision models, scored. */}
        {tab === "arena" && <ArenaView />}

        {/* ── REQUESTS TAB ── */}
        {tab === "requests" && (HOSTED_RUNTIME ? (
          <LocalMachineRequired
            title="Request history is recorded by the local Hangar process"
            description="The real feed combines an in-process event ring with service access logs from your machine. A hosted function has neither the durable local history nor those log files."
            available={["Local service and console request history", "Prompt, response, latency, status, and target attribution", "Access-log tailing without uploading logs"]}
          />
        ) : <RequestsView />)}

        {/* ── USAGE TAB ── */}
        {tab === "usage" && (HOSTED_RUNTIME ? (
          <LocalMachineRequired
            title="AI usage is read from local Codex, Claude, and router history"
            description="Those records stay on the developer machine. The hosted site intentionally shows no zero-filled or invented usage dashboard."
            available={["Codex and Claude task-history accounting", "Durable AI Router usage and cost estimates", "Per-project, model, task, and date breakdowns"]}
          />
        ) : <UsageView />)}

        {/* ── SAM3D TAB ── */}
        {tab === "sam3d" && (hostHasTab("sam3d") ? <Sam3dView /> : <HostUnavailable tab="sam3d" title="3D Body" />)}
        {tab === "sam3" && (hostHasTab("sam3") ? <Sam3View /> : <HostUnavailable tab="sam3" title="Segment" />)}

        {/* ── MODELS / AI ROUTER TAB ── */}
        {tab === "models" && (HOSTED_RUNTIME ? (
          <LocalMachineRequired
            title="Model routing and downloads change the local installation"
            description="Wiring aliases, downloading weights, and deciding what fits all depend on this machine's files, runtimes, and memory. Run Hangar locally to make those changes safely."
            available={["Fit verdicts against live machine capacity", "Local model downloads and checkpoint discovery", "Persistent router configuration and service restart"]}
          />
        ) : <ModelsPage />)}
        </TabErrorBoundary>


        {/* Footer */}
        <footer className="text-center text-xs text-gray-600 py-4">
          {health?.timestamp && (
            <span>Last check: {new Date(health.timestamp).toLocaleTimeString()}</span>
          )}
        </footer>
      </main>

    </div>
  );
}

/**
 * One number in the chat control strip.
 *
 * The card version of this (MetricCard, still used where a tile is the right
 * shape) is 5.4rem tall with a border; four of them made a panel that competed
 * with the conversation for attention while saying very little. Here the number
 * leads and the label trails it in one line.
 */
function PulseStat({
  label,
  value,
  suffix = "",
  decimals = 0,
  multiplier = 1,
  compact = false,
}: {
  label: string;
  value: number | null;
  suffix?: string;
  decimals?: number;
  multiplier?: number;
  compact?: boolean;
}) {
  const shown =
    value === null
      ? "—"
      : compact
        ? Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value)
        : (value * multiplier).toFixed(decimals);
  return (
    <span className="chat-pulse-stat">
      <strong>
        {shown}
        {value === null ? "" : suffix}
      </strong>
      <span>{label}</span>
    </span>
  );
}

function MetricCard({
  label,
  value,
  suffix = "",
  format,
  decimals = 0,
  multiplier = 1,
}: {
  label: string;
  value: number | null;
  suffix?: string;
  format?: "compact";
  decimals?: number;
  multiplier?: number;
}) {
  let display = "—";
  if (value != null) {
    const v = value * multiplier;
    if (format === "compact") {
      display = Intl.NumberFormat("en", { notation: "compact" }).format(v);
    } else {
      display = v.toFixed(decimals);
    }
    display += suffix;
  }

  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className="text-2xl font-bold tabular-nums">{display}</div>
    </div>
  );
}
