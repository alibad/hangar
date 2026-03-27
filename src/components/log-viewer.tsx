"use client";

import { useEffect, useRef, useState } from "react";
import { X, RefreshCw, ArrowDown, Terminal } from "lucide-react";

type LogViewerProps = {
  serviceId: string;
  serviceName: string;
  onClose: () => void;
};

function classifyLine(line: string): "error" | "warn" | "info" | "debug" | "plain" {
  const lower = line.toLowerCase();
  if (lower.includes("error") || lower.includes("traceback") || lower.includes("exception") || lower.includes("critical"))
    return "error";
  if (lower.includes("warn") || lower.includes("warning"))
    return "warn";
  if (lower.includes("info") || lower.includes("started") || lower.includes("healthy") || lower.includes("ready"))
    return "info";
  if (lower.includes("debug"))
    return "debug";
  return "plain";
}

const levelColors = {
  error: "text-red-400",
  warn: "text-yellow-400",
  info: "text-blue-400",
  debug: "text-gray-500",
  plain: "text-gray-300",
};

const levelBadge = {
  error: "bg-red-500/20 text-red-400 border-red-500/30",
  warn: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  info: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  debug: "bg-gray-500/20 text-gray-500 border-gray-500/30",
  plain: "",
};

export default function LogViewer({ serviceId, serviceName, onClose }: LogViewerProps) {
  const [logs, setLogs] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [autoScroll, setAutoScroll] = useState(true);
  const [filter, setFilter] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  async function fetchLogs() {
    setLoading(true);
    try {
      const res = await fetch(`/api/services/${serviceId}`);
      const data = await res.json();
      setLogs(data.logs || []);
    } catch {
      setLogs(["Failed to fetch logs"]);
    }
    setLoading(false);
  }

  useEffect(() => {
    fetchLogs();
    const interval = setInterval(fetchLogs, 5000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceId]);

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  // Close on Escape
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const filteredLogs = filter
    ? logs.filter((l) => l.toLowerCase().includes(filter.toLowerCase()))
    : logs;

  const errorCount = logs.filter((l) => classifyLine(l) === "error").length;
  const warnCount = logs.filter((l) => classifyLine(l) === "warn").length;

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* Panel */}
      <div className="relative ml-auto w-full max-w-4xl bg-gray-950 border-l border-gray-800 flex flex-col animate-in slide-in-from-right duration-200">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <div className="flex items-center gap-3">
            <Terminal className="w-4 h-4 text-gray-500" />
            <h2 className="font-semibold text-sm">{serviceName}</h2>
            <span className="text-xs text-gray-500">{logs.length} lines</span>
            {errorCount > 0 && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/20 text-red-400 border border-red-500/30">
                {errorCount} error{errorCount > 1 ? "s" : ""}
              </span>
            )}
            {warnCount > 0 && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-500/20 text-yellow-400 border border-yellow-500/30">
                {warnCount} warn{warnCount > 1 ? "s" : ""}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={fetchLogs}
              disabled={loading}
              className="p-1.5 rounded-md hover:bg-gray-800 text-gray-400 hover:text-white transition disabled:opacity-40"
              title="Refresh"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            </button>
            <button
              onClick={() => setAutoScroll(!autoScroll)}
              className={`p-1.5 rounded-md hover:bg-gray-800 transition ${
                autoScroll ? "text-blue-400" : "text-gray-500"
              }`}
              title={autoScroll ? "Auto-scroll on" : "Auto-scroll off"}
            >
              <ArrowDown className="w-4 h-4" />
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-md hover:bg-gray-800 text-gray-400 hover:text-white transition"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Filter */}
        <div className="px-5 py-2 border-b border-gray-800/50">
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter logs..."
            className="w-full bg-gray-900 rounded-lg px-3 py-1.5 text-xs text-gray-300 focus:outline-none focus:ring-1 focus:ring-blue-500/50 placeholder-gray-600"
          />
        </div>

        {/* Log content */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-3 font-mono text-xs">
          {filteredLogs.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-gray-600 italic">
                {loading ? "Loading logs..." : filter ? "No matching lines" : "No logs available"}
              </p>
            </div>
          ) : (
            <table className="w-full">
              <tbody>
                {filteredLogs.map((line, i) => {
                  const level = classifyLine(line);
                  return (
                    <tr key={i} className="group hover:bg-gray-900/50">
                      <td className="pr-3 py-px text-gray-600 select-none align-top whitespace-nowrap w-8 text-right">
                        {i + 1}
                      </td>
                      {level !== "plain" && (
                        <td className="pr-3 py-px align-top whitespace-nowrap w-16">
                          <span className={`text-[10px] px-1.5 py-0.5 rounded border ${levelBadge[level]}`}>
                            {level.toUpperCase()}
                          </span>
                        </td>
                      )}
                      {level === "plain" && <td className="pr-3 py-px w-16" />}
                      <td className={`py-px whitespace-pre-wrap break-all leading-relaxed ${levelColors[level]}`}>
                        {line}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-2 border-t border-gray-800 flex items-center justify-between text-xs text-gray-600">
          <span>
            {filter
              ? `${filteredLogs.length} / ${logs.length} lines`
              : `${logs.length} lines`
            }
          </span>
          <span>Auto-refreshes every 5s &middot; ESC to close</span>
        </div>
      </div>
    </div>
  );
}
