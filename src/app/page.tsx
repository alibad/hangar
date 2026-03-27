"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import LogViewer from "@/components/log-viewer";

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

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
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
};

type GpuProcess = {
  pid: number;
  name: string;
  mem_mb: number | null;
  category: string;
  desc: string;
};

type GpuStatus = {
  name: string;
  temperature: number;
  gpu_util: number;
  mem_util: number;
  mem_total: number;
  mem_used: number;
  mem_free: number;
  power_draw: number;
  power_limit: number;
  fan_speed: number | null;
  pstate: string;
  processes: GpuProcess[];
  service_vram: Record<string, {
    name: string;
    allocated_mb?: number;
    estimated_mb?: number;
    reserved_mb?: number;
    pct_of_total: number;
    kv_cache_usage_pct?: number | null;
    source: string;
  }>;
  vram_summary: {
    accounted_mb: number;
    accounted_pct: number;
    used_mb: number;
    unaccounted_mb: number;
    unaccounted_note: string;
  };
  impact: "good" | "warning" | "critical" | "busy";
  impact_msg: string;
  error?: string;
};

export default function Home() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [transcribing, setTranscribing] = useState(false);
  const [transcribeResult, setTranscribeResult] = useState<TranscribeResult | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordingMs, setRecordingMs] = useState(0);
  const [ttsText, setTtsText] = useState("");
  const [ttsVoice, setTtsVoice] = useState("alloy");
  const [ttsSpeaking, setTtsSpeaking] = useState(false);
  const [ttsLatency, setTtsLatency] = useState<number | null>(null);
  const [managedServices, setManagedServices] = useState<ManagedService[]>([]);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<{ id: string; text: string; type: "success" | "error" } | null>(null);
  const [logViewerService, setLogViewerService] = useState<{ id: string; name: string } | null>(null);
  const [gpu, setGpu] = useState<GpuStatus | null>(null);
  const [routing, setRouting] = useState<RoutingInfo | null>(null);
  const [tab, setTab] = useState<"llm" | "speech" | "services" | "gpu">("services");
  const messagesEnd = useRef<HTMLDivElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingTimer = useRef<ReturnType<typeof setInterval> | null>(null);

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
      if (res.ok) setManagedServices(await res.json());
    } catch { /* ignore */ }
  }, []);

  const fetchRouting = useCallback(async () => {
    try {
      const res = await fetch("/api/routing");
      if (res.ok) setRouting(await res.json());
    } catch { /* ignore */ }
  }, []);

  const fetchGpu = useCallback(async () => {
    try {
      const res = await fetch("/api/gpu");
      if (res.ok) setGpu(await res.json());
    } catch { /* ignore */ }
  }, []);

  const getActiveUrl = useCallback((serviceId: string) => {
    const svc = routing?.services.find((s) => s.id === serviceId);
    return svc?.activeUrl ?? svc?.publicUrl ?? "";
  }, [routing]);

  async function serviceAction(id: string, action: "start" | "stop" | "restart") {
    setActionInProgress(id);
    setActionMessage(null);
    try {
      const res = await fetch(`/api/services/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (data.error) {
        setActionMessage({ id, text: data.error, type: "error" });
      } else {
        setActionMessage({ id, text: data.message || `${action} complete`, type: "success" });
      }
      fetchServices();
    } catch (err) {
      setActionMessage({ id, text: `Failed: ${err}`, type: "error" });
    }
    setActionInProgress(null);
  }

  useEffect(() => {
    checkHealth();
    fetchMetrics();
    fetchServices();
    fetchRouting();
    fetchGpu();
  }, [checkHealth, fetchMetrics, fetchServices, fetchRouting, fetchGpu]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      checkHealth();
      fetchMetrics();
      fetchServices();
      fetchGpu();
    }, 15000);
    return () => clearInterval(interval);
  }, [autoRefresh, checkHealth, fetchMetrics, fetchServices, fetchGpu]);

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
      form.append("model", "whisper-1");
      const whisperBase = getActiveUrl("whisper") || "https://whisper.betenshi.com";
      const res = await fetch(`${whisperBase}/v1/audio/transcriptions`, {
        method: "POST",
        body: form,
      });
      const data = await res.json();
      setTranscribeResult({ text: data.text, latency: Date.now() - start, fileName: file.name });
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
    const start = Date.now();
    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: ttsText, voice: ttsVoice }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      setTtsLatency(Date.now() - start);
      if (ttsAudioRef.current) {
        ttsAudioRef.current.src = url;
        ttsAudioRef.current.play();
      }
    } catch (err) {
      setTtsLatency(-1);
      console.error("TTS error:", err);
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
      const start = Date.now();
      const llmBase = getActiveUrl("vllm") || "https://llm.betenshi.com";
      const res = await fetch(`${llmBase}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "Qwen/Qwen2.5-Coder-32B-Instruct-AWQ",
          messages: [{ role: "user", content: input }],
          max_tokens: 1024,
        }),
      });
      const data = await res.json();
      setMessages((prev) => [
        ...prev,
        data.error
          ? { role: "assistant", content: `Error: ${JSON.stringify(data.error)}` }
          : {
              role: "assistant",
              content: data.choices[0].message.content,
              latency: Date.now() - start,
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

  const m = metrics?.metrics || {};
  const getMetric = (partial: string) => {
    const key = Object.keys(m).find((k) => k.includes(partial));
    return key ? m[key] : null;
  };

  const overallStatus =
    health && health.upCount === health.totalCount
      ? "operational"
      : health && health.upCount > 0
        ? "degraded"
        : "down";

  const tabs = [
    { id: "services" as const, label: "Services", count: managedServices.filter((s) => s.status === "running").length + "/" + managedServices.length },
    { id: "gpu" as const, label: "GPU", count: gpu ? `${Math.round((gpu.mem_used / gpu.mem_total) * 100)}%` : undefined },
    { id: "llm" as const, label: "LLM" },
    { id: "speech" as const, label: "Speech" },
  ];

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      {/* Header */}
      <header className="border-b border-gray-800 bg-gray-950/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-6">
          <div className="flex items-center justify-between py-4">
            <div className="flex items-center gap-4">
              <div
                className={`w-3 h-3 rounded-full ${
                  overallStatus === "operational"
                    ? "bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]"
                    : overallStatus === "degraded"
                      ? "bg-yellow-500 shadow-[0_0_8px_rgba(234,179,8,0.5)]"
                      : "bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.5)]"
                }`}
              />
              <h1 className="text-xl font-bold tracking-tight">BeTenshi</h1>
              {routing && (
                <span className={`text-xs px-2 py-0.5 rounded-full ${
                  routing.mode === "local"
                    ? "bg-green-500/10 text-green-400 border border-green-500/20"
                    : "bg-blue-500/10 text-blue-400 border border-blue-500/20"
                }`}>
                  {routing.mode === "local" ? "Local" : "Cloud"}
                </span>
              )}
            </div>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoRefresh}
                  onChange={(e) => setAutoRefresh(e.target.checked)}
                  className="rounded"
                />
                Auto-refresh
              </label>
              <button
                onClick={() => { checkHealth(); fetchMetrics(); fetchServices(); }}
                className="text-sm text-gray-400 hover:text-white px-3 py-1.5 rounded-md border border-gray-700 hover:border-gray-500 transition"
              >
                Refresh
              </button>
            </div>
          </div>
          {/* Tabs */}
          <nav className="flex gap-1 -mb-px">
            {tabs.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`px-4 py-2.5 text-sm font-medium border-b-2 transition ${
                  tab === t.id
                    ? "border-blue-500 text-white"
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

      <main className="max-w-7xl mx-auto px-6 py-8 space-y-8">

        {/* ── GPU QUICK STATUS (visible on all tabs) ── */}
        {gpu && !gpu.error && tab !== "gpu" && (
          <button onClick={() => setTab("gpu")} className={`w-full rounded-lg border px-4 py-2 flex items-center gap-4 text-left transition hover:border-gray-600 ${
            gpu.impact === "critical" ? "bg-red-500/5 border-red-500/30" :
            gpu.impact === "warning" ? "bg-yellow-500/5 border-yellow-500/30" :
            "bg-gray-900 border-gray-800"
          }`}>
            <span className="text-xs text-gray-400">{gpu.name}</span>
            <div className="flex-1 h-2 bg-gray-800 rounded-full overflow-hidden">
              <div className={`h-full rounded-full ${
                gpu.mem_used / gpu.mem_total > 0.95 ? "bg-red-500" :
                gpu.mem_used / gpu.mem_total > 0.8 ? "bg-yellow-500" : "bg-green-500"
              }`} style={{ width: `${(gpu.mem_used / gpu.mem_total) * 100}%` }} />
            </div>
            <span className="text-xs tabular-nums text-gray-500">{(gpu.mem_used / 1024).toFixed(1)}/{(gpu.mem_total / 1024).toFixed(1)} GB</span>
            <span className="text-xs tabular-nums text-gray-500">{gpu.temperature}°C</span>
            <span className="text-xs tabular-nums text-gray-500">{gpu.gpu_util}%</span>
            <span className={`text-[11px] px-2 py-0.5 rounded-full ${
              gpu.impact === "critical" ? "bg-red-500/15 text-red-400" :
              gpu.impact === "warning" ? "bg-yellow-500/15 text-yellow-400" :
              gpu.impact === "busy" ? "bg-orange-500/15 text-orange-400" :
              "bg-green-500/15 text-green-400"
            }`}>{gpu.impact}</span>
          </button>
        )}

        {/* ── SERVICES TAB ── */}
        {tab === "services" && (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {managedServices.map((s) => {
                const isActing = actionInProgress === s.id;
                const msg = actionMessage?.id === s.id ? actionMessage : null;
                return (
                  <div key={s.id} className="bg-gray-900 rounded-xl border border-gray-800 p-4 transition">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <div className={`w-2.5 h-2.5 rounded-full ${
                          s.status === "running" ? "bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.5)]"
                            : s.status === "starting" ? "bg-yellow-500 animate-pulse" : "bg-red-500"
                        }`} />
                        <span className="font-medium text-sm">{s.name}</span>
                      </div>
                      <span className={`text-xs px-2 py-0.5 rounded-full ${
                        s.category === "ai" ? "bg-purple-500/10 text-purple-400"
                          : s.category === "monitoring" ? "bg-blue-500/10 text-blue-400"
                            : "bg-green-500/10 text-green-400"
                      }`}>{s.category}</span>
                    </div>
                    <div className="flex items-center justify-between text-xs text-gray-500 mb-2">
                      <span>:{s.port} &middot; {s.type}{s.pid ? ` (PID ${s.pid})` : ""}</span>
                      <span className={
                        s.status === "running" ? "text-green-400" :
                        s.status === "starting" ? "text-yellow-400" : "text-red-400"
                      }>{s.status}</span>
                    </div>
                    {(() => {
                      const r = routing?.services.find((rs) => rs.id === s.id);
                      if (!r) return null;
                      const isLocal = routing?.mode === "local";
                      return (
                        <div className="text-[11px] space-y-0.5 mb-3 font-mono">
                          <div className="flex items-center gap-1.5">
                            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${isLocal ? "bg-green-500" : "bg-gray-600"}`} />
                            <span className={isLocal ? "text-green-400" : "text-gray-600"}>localhost:{r.localPort}</span>
                            {isLocal && <span className="text-green-600 ml-auto">active</span>}
                          </div>
                          <div className="flex items-center gap-1.5">
                            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${!isLocal ? "bg-blue-500" : "bg-gray-600"}`} />
                            <span className={!isLocal ? "text-blue-400" : "text-gray-600"}>{r.publicUrl.replace("https://", "")}</span>
                            {!isLocal && <span className="text-blue-600 ml-auto">active</span>}
                          </div>
                        </div>
                      );
                    })()}
                    {msg && (
                      <div className={`text-xs px-3 py-2 rounded-lg mb-3 ${
                        msg.type === "error" ? "bg-red-500/10 text-red-400 border border-red-500/20"
                          : "bg-green-500/10 text-green-400 border border-green-500/20"
                      }`}>{msg.text}</div>
                    )}
                    <div className="flex gap-2">
                      {s.status === "running" || s.status === "starting" ? (
                        <>
                          <button onClick={() => serviceAction(s.id, "stop")} disabled={isActing}
                            className="flex-1 bg-red-600/20 hover:bg-red-600/30 text-red-400 border border-red-600/30 rounded-lg px-3 py-1.5 text-xs font-medium transition disabled:opacity-40">
                            {isActing ? "Stopping..." : "Stop"}
                          </button>
                          <button onClick={() => serviceAction(s.id, "restart")} disabled={isActing}
                            className="flex-1 bg-yellow-600/20 hover:bg-yellow-600/30 text-yellow-400 border border-yellow-600/30 rounded-lg px-3 py-1.5 text-xs font-medium transition disabled:opacity-40">
                            {isActing ? "..." : "Restart"}
                          </button>
                        </>
                      ) : (
                        <button onClick={() => serviceAction(s.id, "start")} disabled={isActing}
                          className="flex-1 bg-green-600/20 hover:bg-green-600/30 text-green-400 border border-green-600/30 rounded-lg px-3 py-1.5 text-xs font-medium transition disabled:opacity-40">
                          {isActing ? "Starting..." : "Start"}
                        </button>
                      )}
                      <button onClick={() => setLogViewerService({ id: s.id, name: s.name })}
                        className="bg-gray-800 hover:bg-gray-700 text-gray-400 rounded-lg px-3 py-1.5 text-xs transition">
                        Logs
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {/* ── LLM TAB ── */}
        {tab === "llm" && (
          <>
            {/* Metrics */}
            <section>
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">
                vLLM Metrics
              </h2>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <MetricCard label="Requests Served" value={getMetric("num_requests_running")} suffix=" active" />
                <MetricCard label="Tokens Generated" value={getMetric("generation_tokens_total")} format="compact" />
                <MetricCard label="Avg TTFT" value={getMetric("time_to_first_token")} suffix="s" decimals={3} />
                <MetricCard label="Cache Hit Rate" value={getMetric("prefix_cache_hit_rate")} suffix="%" multiplier={100} decimals={1} />
              </div>
            </section>

            {/* Chat Playground */}
            <section>
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">
                Chat Playground
              </h2>
              <div className="bg-gray-900 rounded-xl border border-gray-800 flex flex-col h-[500px]">
                <div className="flex-1 overflow-y-auto p-5 space-y-4">
                  {messages.length === 0 && (
                    <div className="flex items-center justify-center h-full">
                      <div className="text-center">
                        <div className="text-gray-600 text-4xl mb-4">AI</div>
                        <p className="text-gray-500 text-sm">Send a message to test the LLM</p>
                        <p className="text-gray-600 text-xs mt-1">Qwen2.5-Coder-32B via BeTenshi</p>
                      </div>
                    </div>
                  )}
                  {messages.map((msg, i) => (
                    <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                      <div className={`max-w-[75%] rounded-2xl px-4 py-3 ${
                        msg.role === "user" ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-100"
                      }`}>
                        <pre className="whitespace-pre-wrap text-sm font-sans leading-relaxed">{msg.content}</pre>
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
                      placeholder="Type a message..."
                      className="flex-1 bg-gray-800 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 placeholder-gray-500"
                      disabled={sending} />
                    <button type="submit" disabled={sending || !input.trim()}
                      className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:hover:bg-blue-600 rounded-xl px-5 py-2.5 text-sm font-medium transition">
                      Send
                    </button>
                  </div>
                </form>
              </div>
            </section>
          </>
        )}

        {/* ── SPEECH TAB ── */}
        {tab === "speech" && (
          <>
            {/* Transcribe (STT) */}
            <section>
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">
                Speech-to-Text — Whisper large-v3
              </h2>
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
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-gray-500">{transcribeResult.fileName}</span>
                    <span className="text-xs text-green-400">{transcribeResult.latency}ms</span>
                  </div>
                  <p className="text-sm text-gray-100 leading-relaxed">{transcribeResult.text || <span className="text-gray-500 italic">No speech detected</span>}</p>
                </div>
              )}
            </section>

            {/* Text-to-Speech */}
            <section>
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">
                Text-to-Speech — Kokoro 82M
              </h2>
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
                  <audio ref={ttsAudioRef} controls className="h-8 flex-1" />
                </div>
              </form>
            </section>
          </>
        )}

        {/* ── GPU TAB ── */}
        {tab === "gpu" && gpu && !gpu.error && (
          <>
            {/* GPU Overview */}
            <section className={`rounded-xl border p-5 ${
              gpu.impact === "critical" ? "bg-red-500/5 border-red-500/30" :
              gpu.impact === "warning" ? "bg-yellow-500/5 border-yellow-500/30" :
              gpu.impact === "busy" ? "bg-orange-500/5 border-orange-500/30" :
              "bg-gray-900 border-gray-800"
            }`}>
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-lg font-semibold">{gpu.name}</h2>
                  <p className="text-xs text-gray-500 mt-0.5">Performance State: {gpu.pstate} {gpu.fan_speed != null ? `| Fan: ${gpu.fan_speed}%` : ""}</p>
                </div>
                <span className={`text-sm px-3 py-1 rounded-full font-medium ${
                  gpu.impact === "critical" ? "bg-red-500/15 text-red-400" :
                  gpu.impact === "warning" ? "bg-yellow-500/15 text-yellow-400" :
                  gpu.impact === "busy" ? "bg-orange-500/15 text-orange-400" :
                  "bg-green-500/15 text-green-400"
                }`}>{gpu.impact_msg}</span>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {/* VRAM */}
                <div className="col-span-2">
                  <div className="flex justify-between text-xs text-gray-500 mb-1.5">
                    <span>VRAM Usage</span>
                    <span className="tabular-nums">{(gpu.mem_used / 1024).toFixed(1)} / {(gpu.mem_total / 1024).toFixed(1)} GB ({Math.round((gpu.mem_used / gpu.mem_total) * 100)}%)</span>
                  </div>
                  <div className="h-4 bg-gray-800 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${
                        gpu.mem_used / gpu.mem_total > 0.95 ? "bg-red-500" :
                        gpu.mem_used / gpu.mem_total > 0.8 ? "bg-yellow-500" :
                        "bg-green-500"
                      }`}
                      style={{ width: `${(gpu.mem_used / gpu.mem_total) * 100}%` }}
                    />
                  </div>
                  <p className="text-[11px] text-gray-600 mt-1">{(gpu.mem_free / 1024).toFixed(1)} GB free for KV cache and new workloads</p>
                </div>
                {/* GPU util */}
                <div className="bg-gray-800/50 rounded-lg p-3">
                  <div className="text-xs text-gray-500 mb-1">GPU Utilization</div>
                  <div className="text-2xl font-bold tabular-nums">{gpu.gpu_util}%</div>
                </div>
                {/* Temp */}
                <div className="bg-gray-800/50 rounded-lg p-3">
                  <div className="text-xs text-gray-500 mb-1">Temperature</div>
                  <div className={`text-2xl font-bold tabular-nums ${
                    gpu.temperature > 85 ? "text-red-400" : gpu.temperature > 70 ? "text-yellow-400" : "text-gray-100"
                  }`}>{gpu.temperature}°C</div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4 mt-4">
                {/* Power */}
                <div className="bg-gray-800/50 rounded-lg p-3">
                  <div className="text-xs text-gray-500 mb-1">Power Draw</div>
                  <div className="flex items-baseline gap-1">
                    <span className="text-xl font-bold tabular-nums">{Math.round(gpu.power_draw)}W</span>
                    <span className="text-xs text-gray-500">/ {Math.round(gpu.power_limit)}W</span>
                  </div>
                  <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden mt-2">
                    <div className="h-full bg-blue-500 rounded-full" style={{ width: `${(gpu.power_draw / gpu.power_limit) * 100}%` }} />
                  </div>
                </div>
                {/* Memory util */}
                <div className="bg-gray-800/50 rounded-lg p-3">
                  <div className="text-xs text-gray-500 mb-1">Memory Controller</div>
                  <div className="text-xl font-bold tabular-nums">{gpu.mem_util}%</div>
                  <p className="text-[11px] text-gray-600 mt-1">Bandwidth utilization</p>
                </div>
              </div>
            </section>

            {/* VRAM Breakdown */}
            {Object.keys(gpu.service_vram).length > 0 && (
              <section>
                <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
                  VRAM Breakdown
                </h2>
                <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
                  {/* Stacked bar */}
                  <div className="h-6 bg-gray-800 rounded-full overflow-hidden flex mb-4">
                    {Object.entries(gpu.service_vram).map(([id, svc]) => {
                      const colors: Record<string, string> = {
                        vllm: "bg-purple-500",
                        whisper: "bg-blue-500",
                        tts: "bg-cyan-500",
                      };
                      return (
                        <div
                          key={id}
                          className={`${colors[id] || "bg-gray-500"} h-full transition-all relative group`}
                          style={{ width: `${svc.pct_of_total}%` }}
                          title={`${svc.name}: ${svc.pct_of_total}%`}
                        />
                      );
                    })}
                    {gpu.vram_summary.unaccounted_mb > 0 && (
                      <div
                        className="bg-gray-600 h-full"
                        style={{ width: `${((gpu.vram_summary.unaccounted_mb / gpu.mem_total) * 100)}%` }}
                        title={`System/Desktop: ${gpu.vram_summary.unaccounted_note}`}
                      />
                    )}
                  </div>
                  {/* Legend */}
                  <div className="space-y-2">
                    {Object.entries(gpu.service_vram).map(([id, svc]) => {
                      const colors: Record<string, string> = {
                        vllm: "bg-purple-500",
                        whisper: "bg-blue-500",
                        tts: "bg-cyan-500",
                      };
                      const mem = svc.allocated_mb ?? svc.estimated_mb ?? 0;
                      return (
                        <div key={id} className="flex items-center gap-3 text-xs">
                          <div className={`w-3 h-3 rounded ${colors[id] || "bg-gray-500"} flex-shrink-0`} />
                          <span className="text-gray-300 font-medium min-w-[180px]">{svc.name}</span>
                          <span className="text-gray-500 tabular-nums">{(mem / 1024).toFixed(1)} GB</span>
                          <span className="text-gray-600 tabular-nums">({svc.pct_of_total}%)</span>
                          {svc.kv_cache_usage_pct != null && (
                            <span className={`ml-2 px-1.5 py-0.5 rounded text-[11px] ${
                              svc.kv_cache_usage_pct > 80 ? "bg-red-500/10 text-red-400" :
                              svc.kv_cache_usage_pct > 50 ? "bg-yellow-500/10 text-yellow-400" :
                              "bg-green-500/10 text-green-400"
                            }`}>KV cache: {svc.kv_cache_usage_pct}%</span>
                          )}
                          {svc.estimated_mb && !svc.allocated_mb && (
                            <span className="text-gray-600 text-[11px]">(estimated)</span>
                          )}
                          <span className="text-gray-700 text-[11px] ml-auto">{svc.source}</span>
                        </div>
                      );
                    })}
                    {gpu.vram_summary.unaccounted_mb > 0 && (
                      <div className="flex items-center gap-3 text-xs">
                        <div className="w-3 h-3 rounded bg-gray-600 flex-shrink-0" />
                        <span className="text-gray-500 min-w-[180px]">System / Desktop</span>
                        <span className="text-gray-500 tabular-nums">{(gpu.vram_summary.unaccounted_mb / 1024).toFixed(1)} GB</span>
                        <span className="text-gray-600 text-[11px] ml-auto">{gpu.vram_summary.unaccounted_note}</span>
                      </div>
                    )}
                  </div>
                  {/* Total */}
                  <div className="border-t border-gray-800 mt-3 pt-2 flex items-center gap-3 text-xs">
                    <span className="text-gray-400 font-medium min-w-[180px] ml-6">Accounted</span>
                    <span className="text-gray-400 tabular-nums">{(gpu.vram_summary.accounted_mb / 1024).toFixed(1)} GB</span>
                    <span className="text-gray-500 tabular-nums">({gpu.vram_summary.accounted_pct}%)</span>
                  </div>
                </div>
              </section>
            )}

            {/* Process List */}
            <section>
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
                GPU Processes ({gpu.processes.length})
              </h2>
              {gpu.processes.length === 0 ? (
                <p className="text-sm text-gray-500">No GPU processes detected</p>
              ) : (
                <div className="space-y-1">
                  {/* Group by category */}
                  {(["ai", "dev", "browser", "app", "gaming", "system", "other"] as const).map((cat) => {
                    const procs = gpu.processes.filter((p) => p.category === cat);
                    if (procs.length === 0) return null;
                    const catLabels: Record<string, { label: string; color: string }> = {
                      ai: { label: "AI / Compute", color: "text-purple-400" },
                      dev: { label: "Development", color: "text-blue-400" },
                      browser: { label: "Browsers", color: "text-cyan-400" },
                      app: { label: "Applications", color: "text-green-400" },
                      gaming: { label: "Gaming", color: "text-orange-400" },
                      system: { label: "System", color: "text-gray-400" },
                      other: { label: "Other", color: "text-gray-500" },
                    };
                    const info = catLabels[cat] || catLabels.other;
                    return (
                      <div key={cat} className="mb-3">
                        <div className={`text-[11px] font-medium uppercase tracking-wider mb-1 ${info.color}`}>{info.label}</div>
                        <div className="space-y-0.5">
                          {procs.map((p) => (
                            <div key={p.pid} className={`flex items-center gap-3 text-xs py-1.5 px-3 rounded-lg ${
                              cat === "ai" ? "bg-purple-500/5 border border-purple-500/10" : "bg-gray-900/50"
                            }`}>
                              <span className={`font-mono font-medium ${cat === "ai" ? "text-purple-300" : "text-gray-300"}`}>{p.name}</span>
                              <span className="text-gray-600">PID {p.pid}</span>
                              {p.mem_mb != null && (
                                <span className="text-gray-500">{p.mem_mb >= 1024 ? `${(p.mem_mb / 1024).toFixed(1)} GB` : `${p.mem_mb} MB`}</span>
                              )}
                              <span className="text-gray-600 ml-auto text-[11px]">{p.desc}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            {/* Explainer */}
            <section className="bg-gray-900 rounded-xl border border-gray-800 p-5">
              <h3 className="text-sm font-semibold text-gray-300 mb-2">Why is VRAM full?</h3>
              <p className="text-xs text-gray-500 leading-relaxed">
                On Windows, every application that renders a window uses GPU memory for hardware-accelerated compositing.
                Electron apps (Slack, Notion, Spotify, VS Code, ChatGPT) are particularly heavy since each runs its own
                Chromium renderer. Your RTX 5090 has 32 GB VRAM which is shared between desktop rendering and AI workloads.
                When VRAM is full, vLLM&apos;s KV cache shrinks, drastically reducing inference speed. To free VRAM: close
                Electron apps you&apos;re not using, or disable hardware acceleration in their settings.
              </p>
            </section>
          </>
        )}
        {tab === "gpu" && (!gpu || gpu.error) && (
          <div className="text-center text-gray-500 py-12">
            {gpu?.error || "Loading GPU data..."}
          </div>
        )}

        {/* Footer */}
        <footer className="text-center text-xs text-gray-600 py-4">
          {health?.timestamp && (
            <span>Last check: {new Date(health.timestamp).toLocaleTimeString()}</span>
          )}
        </footer>
      </main>

      {/* Log Viewer Panel */}
      {logViewerService && (
        <LogViewer
          serviceId={logViewerService.id}
          serviceName={logViewerService.name}
          onClose={() => setLogViewerService(null)}
        />
      )}
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
