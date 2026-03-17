"use client";

import { useState, useEffect, useRef } from "react";

type ServiceStatus = {
  name: string;
  subdomain: string;
  status: "up" | "down";
  statusCode: number;
  latency: number;
};

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  latency?: number;
  tokens?: number;
};

export default function Home() {
  const [services, setServices] = useState<ServiceStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const messagesEnd = useRef<HTMLDivElement>(null);

  async function checkHealth() {
    setLoading(true);
    try {
      const res = await fetch("/api/health");
      const data = await res.json();
      setServices(data.services);
    } catch {
      setServices([]);
    }
    setLoading(false);
  }

  useEffect(() => {
    checkHealth();
  }, []);

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

      if (data.error) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: `Error: ${JSON.stringify(data.error)}` },
        ]);
      } else {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: data.content,
            latency: data.latency,
            tokens: data.usage?.total_tokens,
          },
        ]);
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `Connection error: ${err}` },
      ]);
    }
    setSending(false);
  }

  return (
    <div className="max-w-4xl mx-auto p-6">
      <h1 className="text-3xl font-bold mb-2">BeTenshi Console</h1>
      <p className="text-gray-400 mb-8">Monitor and test BeTenshi AI services</p>

      {/* Service Status */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">Services</h2>
          <button
            onClick={checkHealth}
            className="text-sm text-gray-400 hover:text-white transition"
          >
            {loading ? "Checking..." : "Refresh"}
          </button>
        </div>
        <div className="grid gap-3">
          {services.map((s) => (
            <div
              key={s.name}
              className="flex items-center justify-between bg-gray-900 rounded-lg px-4 py-3 border border-gray-800"
            >
              <div className="flex items-center gap-3">
                <div
                  className={`w-2.5 h-2.5 rounded-full ${
                    s.status === "up" ? "bg-green-500" : "bg-red-500"
                  }`}
                />
                <div>
                  <span className="font-medium">{s.name}</span>
                  <span className="text-gray-500 text-sm ml-2">
                    {s.subdomain}
                  </span>
                </div>
              </div>
              <div className="text-sm text-gray-400">
                {s.status === "up" ? `${s.latency}ms` : "offline"}
              </div>
            </div>
          ))}
          {services.length === 0 && !loading && (
            <div className="text-gray-500 text-sm">No services found</div>
          )}
        </div>
      </div>

      {/* Chat Playground */}
      <div>
        <h2 className="text-lg font-semibold mb-3">Chat Playground</h2>
        <div className="bg-gray-900 rounded-lg border border-gray-800 flex flex-col h-[400px]">
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {messages.length === 0 && (
              <div className="text-gray-500 text-sm text-center mt-16">
                Send a message to test the LLM
              </div>
            )}
            {messages.map((msg, i) => (
              <div
                key={i}
                className={`flex ${
                  msg.role === "user" ? "justify-end" : "justify-start"
                }`}
              >
                <div
                  className={`max-w-[80%] rounded-lg px-4 py-2 ${
                    msg.role === "user"
                      ? "bg-blue-600 text-white"
                      : "bg-gray-800 text-gray-100"
                  }`}
                >
                  <pre className="whitespace-pre-wrap text-sm font-sans">
                    {msg.content}
                  </pre>
                  {msg.latency != null && (
                    <div className="text-xs text-gray-400 mt-1">
                      {msg.latency}ms
                      {msg.tokens != null && ` / ${msg.tokens} tokens`}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {sending && (
              <div className="flex justify-start">
                <div className="bg-gray-800 rounded-lg px-4 py-2 text-sm text-gray-400">
                  Thinking...
                </div>
              </div>
            )}
            <div ref={messagesEnd} />
          </div>
          <form onSubmit={sendMessage} className="p-3 border-t border-gray-800">
            <div className="flex gap-2">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Type a message..."
                className="flex-1 bg-gray-800 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                disabled={sending}
              />
              <button
                type="submit"
                disabled={sending || !input.trim()}
                className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-lg px-4 py-2 text-sm font-medium transition"
              >
                Send
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
