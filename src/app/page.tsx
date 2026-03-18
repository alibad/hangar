"use client";

import { useState, useEffect, useRef, useCallback } from "react";

type ServiceStatus = {
  name: string;
  subdomain: string;
  category: string;
  status: "up" | "down";
  statusCode: number;
  latency: number;
};

type HealthResponse = {
  services: ServiceStatus[];
  timestamp: string;
  upCount: number;
  totalCount: number;
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

export default function Home() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const messagesEnd = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    checkHealth();
    fetchMetrics();
  }, [checkHealth, fetchMetrics]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      checkHealth();
      fetchMetrics();
    }, 15000);
    return () => clearInterval(interval);
  }, [autoRefresh, checkHealth, fetchMetrics]);

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
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: input }),
      });
      const data = await res.json();
      setMessages((prev) => [
        ...prev,
        data.error
          ? { role: "assistant", content: `Error: ${JSON.stringify(data.error)}` }
          : {
              role: "assistant",
              content: data.content,
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

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      {/* Header */}
      <header className="border-b border-gray-800 bg-gray-950/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
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
            <span className="text-sm text-gray-500">
              {overallStatus === "operational"
                ? "All systems operational"
                : overallStatus === "degraded"
                  ? "Partial outage"
                  : "Systems down"}
            </span>
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
              onClick={() => {
                checkHealth();
                fetchMetrics();
              }}
              className="text-sm text-gray-400 hover:text-white px-3 py-1.5 rounded-md border border-gray-700 hover:border-gray-500 transition"
            >
              Refresh
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8 space-y-8">
        {/* Services Grid */}
        <section>
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">
            Services
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {health?.services.map((s) => (
              <a
                key={s.name}
                href={`https://${s.subdomain}`}
                target="_blank"
                rel="noopener noreferrer"
                className="bg-gray-900 rounded-xl border border-gray-800 hover:border-gray-600 p-4 transition group"
              >
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <div
                      className={`w-2 h-2 rounded-full ${
                        s.status === "up" ? "bg-green-500" : "bg-red-500"
                      }`}
                    />
                    <span className="font-medium text-sm">{s.name}</span>
                  </div>
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full ${
                      s.category === "ai"
                        ? "bg-purple-500/10 text-purple-400"
                        : s.category === "monitoring"
                          ? "bg-blue-500/10 text-blue-400"
                          : "bg-green-500/10 text-green-400"
                    }`}
                  >
                    {s.category}
                  </span>
                </div>
                <div className="text-xs text-gray-500 group-hover:text-gray-400 transition">
                  {s.subdomain}
                </div>
                <div className="text-right text-xs text-gray-500 mt-1">
                  {s.status === "up" ? `${s.latency}ms` : "offline"}
                </div>
              </a>
            ))}
          </div>
        </section>

        {/* Metrics Cards */}
        <section>
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">
            vLLM Metrics
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <MetricCard
              label="Requests Served"
              value={getMetric("num_requests_running")}
              suffix=" active"
            />
            <MetricCard
              label="Tokens Generated"
              value={getMetric("generation_tokens_total")}
              format="compact"
            />
            <MetricCard
              label="Avg TTFT"
              value={getMetric("time_to_first_token")}
              suffix="s"
              decimals={3}
            />
            <MetricCard
              label="Cache Hit Rate"
              value={getMetric("prefix_cache_hit_rate")}
              suffix="%"
              multiplier={100}
              decimals={1}
            />
          </div>
        </section>

        {/* Chat Playground */}
        <section>
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">
            Chat Playground
          </h2>
          <div className="bg-gray-900 rounded-xl border border-gray-800 flex flex-col h-[450px]">
            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              {messages.length === 0 && (
                <div className="flex items-center justify-center h-full">
                  <div className="text-center">
                    <div className="text-gray-600 text-4xl mb-4">AI</div>
                    <p className="text-gray-500 text-sm">
                      Send a message to test the LLM
                    </p>
                    <p className="text-gray-600 text-xs mt-1">
                      Qwen2.5-Coder-32B via BeTenshi
                    </p>
                  </div>
                </div>
              )}
              {messages.map((msg, i) => (
                <div
                  key={i}
                  className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[75%] rounded-2xl px-4 py-3 ${
                      msg.role === "user"
                        ? "bg-blue-600 text-white"
                        : "bg-gray-800 text-gray-100"
                    }`}
                  >
                    <pre className="whitespace-pre-wrap text-sm font-sans leading-relaxed">
                      {msg.content}
                    </pre>
                    {msg.latency != null && (
                      <div className="flex items-center gap-2 mt-2 text-xs text-gray-400">
                        <span>{msg.latency}ms</span>
                        {msg.tokens != null && (
                          <>
                            <span className="text-gray-600">|</span>
                            <span>{msg.tokens} tokens</span>
                          </>
                        )}
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
            <form
              onSubmit={sendMessage}
              className="p-4 border-t border-gray-800"
            >
              <div className="flex gap-3">
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="Type a message..."
                  className="flex-1 bg-gray-800 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 placeholder-gray-500"
                  disabled={sending}
                />
                <button
                  type="submit"
                  disabled={sending || !input.trim()}
                  className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:hover:bg-blue-600 rounded-xl px-5 py-2.5 text-sm font-medium transition"
                >
                  Send
                </button>
              </div>
            </form>
          </div>
        </section>

        {/* Footer */}
        <footer className="text-center text-xs text-gray-600 py-4">
          {health?.timestamp && (
            <span>
              Last check: {new Date(health.timestamp).toLocaleTimeString()}
            </span>
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
