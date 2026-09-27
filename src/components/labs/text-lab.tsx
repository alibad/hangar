"use client";

import { useState } from "react";
import LabShell from "./lab-shell";
import Markdown from "@/components/markdown";
import type { LabComponentProps } from "@/lib/labs";
import type { LabRunResult } from "@/lib/lab-types";
import type { TextLabOutput } from "@/app/api/labs/text/run/route";

/**
 * The Text Lab — the first Lab on the shell, and the one to copy.
 *
 * Everything capability-specific is here: a prompt, a seed and a temperature
 * in; an answer (and any thinking) out. Model listing, Start/Stop, the cloud
 * column, latency/VRAM/cost, the runs record and the experiment doc are the
 * shell's.
 */
export default function TextLab({ lab }: LabComponentProps) {
  const [prompt, setPrompt] = useState("");
  const [seed, setSeed] = useState<string>("");
  const [temperature, setTemperature] = useState(0);

  const seedNum = seed.trim() === "" ? null : Number(seed);
  const seedValid = seedNum === null || Number.isInteger(seedNum);

  return (
    <LabShell<TextLabOutput>
      lab={lab}
      canRun={!!prompt.trim() && seedValid}
      input={
        <div className="space-y-2">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={5}
            placeholder="A prompt to try. Temperature 0 and a seed make a re-run reproducible."
            aria-label="Prompt"
            className="w-full resize-y rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-100 outline-none placeholder:text-gray-600 focus:border-gray-500"
          />
          <div className="flex flex-wrap items-center gap-4 text-xs text-gray-400">
            <label className="flex items-center gap-2">
              Seed
              <input
                value={seed}
                onChange={(e) => setSeed(e.target.value)}
                inputMode="numeric"
                placeholder="none"
                className={`w-24 rounded-md border bg-gray-950 px-2 py-1 text-gray-200 ${seedValid ? "border-gray-700" : "border-red-500"}`}
              />
            </label>
            <label className="flex items-center gap-2">
              Temperature
              <input
                type="range"
                min={0}
                max={1.5}
                step={0.1}
                value={temperature}
                onChange={(e) => setTemperature(Number(e.target.value))}
                className="accent-orange-500"
              />
              <span className="w-6 tabular-nums text-gray-300">{temperature.toFixed(1)}</span>
            </label>
          </div>
        </div>
      }
      run={async (model, { compareGroup, signal }) => {
        const r = await fetch("/api/labs/text/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: model.id, prompt, seed: seedNum, temperature, compareGroup: compareGroup || null }),
          signal,
        });
        const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
        if (!r.ok) return { ok: false, model: model.id, local: model.local, error: j.error ?? `HTTP ${r.status}` };
        return j as LabRunResult<TextLabOutput>;
      }}
      renderOutput={(r) => {
        const out = r.output;
        if (!out) return null;
        const usage = out.usage as { prompt_tokens?: number; completion_tokens?: number } | null;
        return (
          <div className="space-y-3">
            {out.thinking && (
              <details className="rounded-lg border border-gray-800 px-3 py-2 text-xs text-gray-400">
                <summary className="cursor-pointer">Thinking</summary>
                <p className="mt-2 whitespace-pre-wrap">{out.thinking}</p>
              </details>
            )}
            {out.content ? <Markdown>{out.content}</Markdown> : <p className="text-xs text-gray-500">Empty answer.</p>}
            <p className="text-[11px] text-gray-500">
              {usage ? `${usage.prompt_tokens ?? "?"} in · ${usage.completion_tokens ?? "?"} out` : "no token counts"}
              {out.truncated && <span className="ml-2 text-amber-300">cut off at the token limit</span>}
            </p>
            {out.adjusted?.length > 0 && (
              <p className="text-[11px] text-amber-300" title="The model refused these settings; this run is not directly comparable to a greedy one.">
                {out.adjusted.join(" · ")}
              </p>
            )}
          </div>
        );
      }}
    />
  );
}
