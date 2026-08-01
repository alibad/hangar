"use client";

import { useCallback, useEffect, useState } from "react";
import { ServiceLogsButton } from "./service-control";
import ModelFootprint, { type Footprint } from "./model-footprint";

interface LlmSvc {
  id: string;
  name: string;
  port: number;
  model?: string;
  healthy: boolean;
  active: boolean;
  footprint?: Footprint;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

// In-context LLM control (lives in the LLM tab). The models share ONE GPU with
// Qwen-Image and can't be resident together, so "Use" makes a model the sole
// running + active LLM: it stops the others, starts this one, and selects it.
export default function LlmPicker() {
  const [svcs, setSvcs] = useState<LlmSvc[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/llm", { cache: "no-store" });
      const j = await r.json();
      setSvcs(j.services ?? []);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    load();
    const iv = setInterval(load, 6000);
    return () => clearInterval(iv);
  }, [load]);

  const setActive = (id: string) =>
    fetch("/api/llm", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ id }) });
  const svcAction = (id: string, action: "start" | "stop") =>
    fetch(`/api/services/${id}`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ action }) });

  // Make this the one running + active LLM: stop every other LLM first (one GPU).
  const use = useCallback(
    async (id: string) => {
      setBusy(id);
      try {
        await Promise.all(svcs.filter((s) => s.id !== id && s.healthy).map((s) => svcAction(s.id, "stop")));
        await setActive(id);
        await svcAction(id, "start");
      } catch {
        /* ignore */
      }
      // loading the model into VRAM takes a bit; poll a few times
      let n = 0;
      const iv = setInterval(() => {
        load();
        if (++n >= 12) {
          clearInterval(iv);
          setBusy(null);
        }
      }, 3000);
    },
    [svcs, load],
  );

  const stop = useCallback(
    async (id: string) => {
      setBusy(id);
      try {
        await svcAction(id, "stop");
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        load();
        setBusy(null);
      }, 2500);
    },
    [load],
  );

  return (
    <section>
      <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">
        Active LLM · prompts &amp; chat
      </h2>
      <div className="grid gap-3 sm:grid-cols-2">
        {svcs.map((s) => {
          const isBusy = busy === s.id;
          return (
            <div
              key={s.id}
              className={`rounded-xl border p-4 bg-gray-900 transition ${
                s.active ? "border-blue-500/60 shadow-[0_0_0_1px_rgba(59,130,246,0.25)]" : "border-gray-800"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className={`w-2 h-2 rounded-full flex-shrink-0 ${
                      s.healthy ? "bg-emerald-400 shadow-[0_0_5px_rgba(52,211,153,0.7)]" : "bg-gray-600"
                    }`}
                  />
                  <h3 className="text-sm font-semibold text-gray-100 truncate">{s.name}</h3>
                </div>
                {s.active && (
                  <span className="text-[10px] uppercase tracking-widest font-bold px-1.5 py-0.5 rounded-md bg-blue-500/10 text-blue-400 border border-blue-500/20 flex-shrink-0">
                    Active
                  </span>
                )}
              </div>
              <p className="mt-1.5 text-[11px] text-gray-500 font-mono">
                {s.model} · :{s.port} · {isBusy ? "working…" : s.healthy ? "running" : "stopped"}
              </p>
              {/* "Use" swaps what owns the GPU, so the cost of that swap belongs
                  on the button's own card, not in a footnote below the grid. */}
              <ModelFootprint footprint={s.footprint} className="mt-1.5" />
              <div className="mt-3 flex gap-2">
                <button
                  onClick={() => use(s.id)}
                  disabled={isBusy || (s.active && s.healthy)}
                  className="text-xs px-2.5 py-1 rounded-md border border-blue-500/40 text-blue-400 hover:bg-blue-500/10 transition disabled:opacity-40"
                >
                  {isBusy ? "…" : s.active && s.healthy ? "In use" : "Use"}
                </button>
                {s.healthy && (
                  <button
                    onClick={() => stop(s.id)}
                    disabled={isBusy}
                    className="text-xs px-2.5 py-1 rounded-md border border-red-500/30 text-red-400 hover:bg-red-500/10 transition disabled:opacity-40"
                  >
                    Stop
                  </button>
                )}
                {/* "Use" can sit at "working…" for minutes while a 30B loads —
                    the logs are the only place that says how far along it is. */}
                <ServiceLogsButton
                  id={s.id}
                  name={s.name}
                  className="text-xs px-2.5 py-1 rounded-md border border-gray-700 text-gray-400 hover:text-gray-100 hover:border-gray-500 transition ml-auto"
                />
              </div>
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-[11px] text-gray-500 leading-snug">
        One GPU, shared with Qwen-Image — only one LLM runs at a time. &ldquo;Use&rdquo; stops the
        other and starts this one. The 30B needs Qwen idle; the 7B coexists with light Qwen use.
      </p>
    </section>
  );
}
