"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import ModelPicker from "@/components/model-picker";
import QwenTab from "@/components/qwen-tab";
import RequestsView from "@/components/requests-view";
import UsageView from "@/components/usage-view";
import Sam3dView from "@/components/sam3d-view";
import Sam3View from "@/components/sam3-view";
import ModelsPage from "@/components/models-page";
import ModelFootprint, { type Footprint } from "@/components/model-footprint";
import Markdown from "@/components/markdown";
import { ServiceLogsButton } from "@/components/service-control";
import { useTheme } from "@/components/theme-provider";
import { ThemePicker } from "@/components/theme-picker";
import { CommandPalette, type ConsoleTab } from "@/components/command-palette";
import TabErrorBoundary from "@/components/tab-error-boundary";
import HomeCockpit from "@/components/home-cockpit";
import ConsoleHeader from "@/components/console-header";
import ResourcePulse from "@/components/resource-pulse";
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

// Small inline spinner shown while a service action (start/stop/restart) is in flight.
function Spinner() {
  return <span className="inline-block w-3 h-3 rounded-full border-[1.5px] border-current border-t-transparent animate-spin align-[-2px]" />;
}

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
};

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  /** Reasoning models put their working here — see splitThinking in /api/chat. */
  thinking?: string | null;
  /** finish_reason === "length": the reply was cut off, often mid-thought. */
  truncated?: boolean;
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
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [transcribeResult, setTranscribeResult] = useState<TranscribeResult | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordingMs, setRecordingMs] = useState(0);
  const [ttsText, setTtsText] = useState("");
  const [ttsVoice, setTtsVoice] = useState("alloy");
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
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const selectTab = useCallback((next: ConsoleTab) => {
    setTab(next);
    window.localStorage.setItem("bt-active-tab", next);
    window.history.pushState({ tab: next }, "", `#${next}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  useEffect(() => {
    const valid = new Set<ConsoleTab>(["stack", "services", "storage", "llm", "speech", "qwen", "requests", "usage", "sam3d", "sam3", "models"]);
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

  async function startRecording() {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      setTranscribeResult({ text: `Mic error: ${err}`, latency: 0, fileName: "mic" });
      return;
    }
    const recorder = new MediaRecorder(stream);
    const chunks: BlobPart[] = [];
    recorder.ondataavailable = (e) => chunks.push(e.data);
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, { type: "audio/webm" });
      transcribeAudio(new File([blob], "recording.webm", { type: "audio/webm" }));
    };
    recorder.start();
    mediaRecorderRef.current = recorder;
    setRecording(true);
    setRecordingMs(0);
    recordingTimer.current = setInterval(() => setRecordingMs((ms) => ms + 100), 100);
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop();
    if (recordingTimer.current) clearInterval(recordingTimer.current);
    setRecording(false);
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
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setSending(true);
    try {
      // Go through our own route so it uses the active LLM (and no browser CORS
      // to the model). The server route resolves URL + served-model + auth.
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: input }),
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
  const readyServices = managedServices.filter((service) => service.status === "running" && service.healthy).length;
  const onDemandServices = managedServices.filter(
    (service) => service.status !== "running" && service.status !== "failed" && service.owner !== "external",
  ).length;
  const attentionServices = managedServices.filter(
    (service) => service.status === "failed" || (service.status === "running" && !service.healthy) || service.owner === "external",
  );
  const queueDepth = (resourceControl?.queue.length ?? 0) + (resourceControl?.starts.length ?? 0);

  /** A tab for a service that is not registered on this host would be a permanent
   *  "unavailable" — hide it instead. */
  const has = hostHas;
  const tabs = [
    // Services and GPU were two views of the same local processes — one listing
    // them, one duplicating their controls under a GPU header. Merged into
    // "Stack": the GPU is the shared constraint every service competes for, so
    // it belongs above the cards rather than in a tab of its own.
    { id: "stack" as const, label: "Stack", count: runningServices + "/" + managedServices.length },
    { id: "services" as const, label: "Services" },
    { id: "storage" as const, label: "Storage" },
    { id: "llm" as const, label: "LLM" },
    ...(has("whisper", "tts") ? [{ id: "speech" as const, label: "Speech" }] : []),
    // One tab for every image model on the box. "Creative" used to sit beside
    // this as a second, weaker generator for FLUX; the model is a picker inside
    // the studio now, so both share its gallery, queue and Activity feed.
    ...(has("qwen", "comfyui") ? [{ id: "qwen" as const, label: "Image" }] : []),
    { id: "requests" as const, label: "Requests" },
    { id: "usage" as const, label: "Usage" },
    ...(has("sam3d") ? [{ id: "sam3d" as const, label: "3D Body" }] : []),
    ...(has("sam3") ? [{ id: "sam3" as const, label: "Segment" }] : []),
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
      {/* Header */}
      <header className="hidden">
        <div className="max-w-7xl mx-auto px-4 sm:px-6">
          <div className="flex items-center justify-between gap-3 py-3">
            <div className="flex items-center gap-3">
              {/* Logo */}
              <svg width="26" height="26" viewBox="0 0 96 96" fill="none" aria-hidden="true">
                <path d="M48 18 Q55 41 78 48 Q55 55 48 78 Q41 55 18 48 Q41 41 48 18 Z" fill="#31439b"/>
                <path d="M60.02 35.98 Q52 48 60.02 60.02 Q48 52 35.98 60.02 Q44 48 35.98 35.98 Q48 44 60.02 35.98 Z" fill="#7b85c7"/>
              </svg>
              <h1 className="text-lg font-semibold tracking-tight">{host?.name ?? gpu?.host?.name ?? "Console"}</h1>
              <div role="status" aria-label={`Stack ${overallStatus}`} className={`w-2 h-2 rounded-full flex-shrink-0 ${
                overallStatus === "operational"
                  ? "bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.5)]"
                  : overallStatus === "degraded"
                    ? "bg-yellow-500 shadow-[0_0_6px_rgba(234,179,8,0.5)]"
                    : "bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.5)]"
              }`} />
              {routing && (
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                  routing.mode === "local"
                    ? "bg-green-500/10 text-green-600 dark:text-green-400 border border-green-500/20"
                    : "bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20"
                }`}>
                  {routing.mode === "local" ? "Local" : "Cloud"}
                </span>
              )}
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <CommandPalette active={tab} onSelect={selectTab} />
              <label className="hidden items-center gap-2 text-sm text-gray-500 cursor-pointer select-none xl:flex">
                <input
                  type="checkbox"
                  checked={autoRefresh}
                  onChange={(e) => setAutoRefresh(e.target.checked)}
                  className="rounded accent-blue-500"
                />
                Auto-refresh
                {autoRefresh && (
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" title="auto-refreshing every 15s" />
                )}
              </label>
              <button
                onClick={refreshAll}
                disabled={refreshing}
                aria-label={refreshing ? "Refreshing console" : "Refresh console"}
                className="flex h-8 items-center gap-1.5 text-sm text-gray-400 hover:text-gray-100 px-2.5 rounded-md border border-gray-700 hover:border-gray-500 transition disabled:opacity-60 disabled:cursor-default"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
                <span className="hidden lg:inline">{refreshing ? "Refreshing…" : "Refresh"}</span>
              </button>
              {/* Theme toggle */}
              <button
                onClick={toggleTheme}
                title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
                aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
                className="w-8 h-8 flex items-center justify-center rounded-md border border-gray-700 hover:border-gray-500 text-gray-400 hover:text-gray-100 transition text-base"
              >
                {theme === "dark" ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
              </button>
              <ThemePicker />
            </div>
          </div>
          {/* Tabs */}
          <nav className="-mb-px flex gap-1 overflow-x-auto" aria-label="Console tools">
            {tabs.map((t) => (
              <button
                key={t.id}
                onClick={() => selectTab(t.id)}
                aria-current={tab === t.id ? "page" : undefined}
                className={`whitespace-nowrap px-3 sm:px-4 py-2.5 text-sm font-medium border-b-2 transition ${
                  tab === t.id
                    ? "border-blue-500 text-slate-900 dark:text-slate-100"
                    : "border-transparent text-gray-500 hover:text-gray-300 hover:border-gray-600"
                }`}
              >
                {t.label}
                {t.count && (
                  <span className="ml-2 text-xs text-gray-500">{t.count}</span>
                )}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-[1500px] space-y-6 px-4 pb-24 pt-4 sm:px-6 sm:pt-5 md:pb-5">

        <TabErrorBoundary key={tab} label={tabs.find((item) => item.id === tab)?.label ?? "Console"}>

        {/* ── STACK TAB (services + GPU) ── */}
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

        {tab === "storage" && <StorageManager />}

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
                <span className="text-[11px] text-gray-500">failed, starting or external</span>
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

          {stackFilter === "attention" && attentionServices.length === 0 && (
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-5 text-sm text-emerald-300">
              Nothing needs attention. Intentionally stopped on-demand services remain available under All.
            </div>
          )}
          <div className={`grid grid-cols-1 md:grid-cols-2 gap-3 ${compactStack ? "xl:grid-cols-4" : "lg:grid-cols-3"}`}>
            {managedServices.filter((s) =>
              stackFilter === "all"
                ? true
                : stackFilter === "attention"
                  ? s.status === "failed" || s.status === "starting" || s.owner === "external"
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
            {/* The same picker every other testing tab uses, scoped to text.
                exclusiveLocal because the two vLLMs share one 32 GB card and
                cannot both be resident — selecting one stops the other. */}
            <ModelPicker capability="text" exclusiveLocal className="chat-model-picker" />

            {/* Metrics */}
            <section className="chat-metrics tool-panel">
              <ToolSectionHeading eyebrow="Live telemetry" title="Model pulse" description="A quick read on the active engine." />
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <MetricCard label="Requests Served" value={getMetric("num_requests_running")} suffix=" active" />
                <MetricCard label="Tokens Generated" value={getMetric("generation_tokens_total")} format="compact" />
                <MetricCard label="Avg TTFT" value={getMetric("time_to_first_token")} suffix="s" decimals={3} />
                <MetricCard label="Cache Hit Rate" value={getMetric("prefix_cache_hit_rate")} suffix="%" multiplier={100} decimals={1} />
              </div>
            </section>

            {/* Chat Playground */}
            <section className="chat-playground">
              <ToolSectionHeading eyebrow="Playground" title="Start a conversation" description="Prompt the selected model and inspect its thinking, latency, and token use." />
              <div className="tool-panel chat-canvas bg-gray-900 rounded-xl border border-gray-800 flex flex-col h-[540px]">
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
                        <div className="flex gap-1">
                          <div className="w-2 h-2 bg-gray-500 rounded-full animate-bounce [animation-delay:0ms]" />
                          <div className="w-2 h-2 bg-gray-500 rounded-full animate-bounce [animation-delay:150ms]" />
                          <div className="w-2 h-2 bg-gray-500 rounded-full animate-bounce [animation-delay:300ms]" />
                        </div>
                      </div>
                    </div>
                  )}
                  <div ref={messagesEnd} />
                </div>
                <form onSubmit={sendMessage} className="p-4 border-t border-gray-800">
                  <div className="flex gap-3">
                    <input type="text" value={input} onChange={(e) => setInput(e.target.value)}
                      placeholder="Ask the local model anything..."
                      className="flex-1 bg-gray-800 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 placeholder-gray-500"
                      disabled={sending} />
                    <button type="submit" disabled={sending || !input.trim()}
                      className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:hover:bg-blue-600 rounded-xl px-5 py-2.5 text-sm font-medium transition">
                      Run
                    </button>
                  </div>
                </form>
              </div>
            </section>
          </div>
        )}

        {/* ── SPEECH TAB ── */}
        {tab === "speech" && (
          <div className="tool-page speech-page">
            <ToolPageHeader
              eyebrow="Voice workstream"
              title="Speech Lab"
              description="Transcribe recordings and synthesize natural speech from one focused local audio workspace."
              icon={<WaveformIcon size={24} weight="duotone" />}
              meta={<span className="tool-page-chip">Whisper + Kokoro</span>}
            />
            <div className="speech-workspace-grid">
            {/* Transcribe (STT) */}
            <section className="tool-panel speech-workspace">
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">
                Speech → text
              </h2>
              {/* Status + pick for the model this panel uses. Both speech services
                  are small enough to co-reside, so unlike the LLM picker there's no
                  stop-the-others logic — Start/Stop is per model. */}
              <ModelPicker capability="stt" className="mb-4" />
              <div className="flex gap-4 items-stretch">
                <button
                  onClick={recording ? stopRecording : startRecording}
                  disabled={transcribing}
                  className={`flex flex-col items-center justify-center gap-2 rounded-xl px-8 py-6 font-medium transition flex-shrink-0 ${
                    recording
                      ? "bg-red-600 hover:bg-red-500 shadow-[0_0_20px_rgba(239,68,68,0.4)]"
                      : "bg-gray-800 hover:bg-gray-700 border border-gray-700"
                  } disabled:opacity-40`}
                >
                  <span className="text-3xl">{recording ? "⏹" : "🎙"}</span>
                  <span className="text-xs text-gray-300">
                    {recording ? `${(recordingMs / 1000).toFixed(1)}s — stop` : "Record"}
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
            </section>

            {/* Text-to-Speech */}
            <section className="tool-panel speech-workspace">
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">
                Text → speech
              </h2>
              <ModelPicker capability="tts" className="mb-4" />
              <form onSubmit={speakText} className="bg-gray-900 rounded-xl border border-gray-800 p-5">
                <div className="flex gap-3 mb-3">
                  <textarea value={ttsText} onChange={(e) => setTtsText(e.target.value)}
                    placeholder="Type text to speak..." rows={2}
                    className="flex-1 bg-gray-800 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500/50 placeholder-gray-500 resize-none" />
                  <div className="flex flex-col gap-2">
                    <Select value={ttsVoice} onValueChange={(v) => v && setTtsVoice(v)}>
                      <SelectTrigger className="w-36 bg-gray-800 border-gray-700 text-xs text-gray-300">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="bg-gray-800 border-gray-700 text-gray-300">
                        <SelectItem value="alloy">Alloy (F)</SelectItem>
                        <SelectItem value="echo">Echo (M)</SelectItem>
                        <SelectItem value="fable">Fable (F, UK)</SelectItem>
                        <SelectItem value="onyx">Onyx (M)</SelectItem>
                        <SelectItem value="nova">Nova (F)</SelectItem>
                        <SelectItem value="shimmer">Shimmer (F)</SelectItem>
                      </SelectContent>
                    </Select>
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
              </form>
            </section>
            </div>
          </div>
        )}

        {/* ── CREATIVE TAB ── */}

        {/* ── IMAGE TAB — Qwen-Image + FLUX, model picked inside the studio ── */}
        {tab === "qwen" && <QwenTab />}

        {/* ── REQUESTS TAB ── */}
        {tab === "requests" && <RequestsView />}

        {/* ── USAGE TAB ── */}
        {tab === "usage" && <UsageView />}

        {/* ── SAM3D TAB ── */}
        {tab === "sam3d" && <Sam3dView />}
        {tab === "sam3" && <Sam3View />}

        {/* ── MODELS / AI ROUTER TAB ── */}
        {tab === "models" && <ModelsPage />}
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
