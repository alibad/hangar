"use client";

import { useState } from "react";
import LabShell from "./lab-shell";
import ImageEvalView from "@/components/image-eval-view";
import type { LabComponentProps } from "@/lib/labs";
import type { LabRunResult } from "@/lib/lab-types";
import type { ImageLabOutput } from "@/app/api/labs/image/run/route";

/**
 * The Image Lab: one prompt against a local model with a cloud one beside it
 * (the shell), and below it the fixed evaluation suite with every model side
 * by side (experiments/image-eval, judged by you, not scored automatically).
 *
 * The Image Studio stays the place to make and manage images; this is the
 * place to compare models. Both call the same generateAndSave().
 */
export default function ImageLab({ lab }: LabComponentProps) {
  const [prompt, setPrompt] = useState("");
  const [seed, setSeed] = useState<string>("20260926");
  const [size, setSize] = useState(1024);

  const seedNum = seed.trim() === "" ? null : Number(seed);
  const seedValid = seedNum === null || (Number.isInteger(seedNum) && seedNum >= 0);

  return (
    <div className="space-y-6">
      <LabShell<ImageLabOutput>
        lab={lab}
        canRun={!!prompt.trim() && seedValid}
        input={
          <div className="space-y-2">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              dir="auto"
              placeholder="Describe an image. The same seed and size go to every model, so a comparison measures the model, not luck."
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
                  placeholder="random"
                  className={`w-28 rounded-md border bg-gray-950 px-2 py-1 text-gray-200 ${seedValid ? "border-gray-700" : "border-red-500"}`}
                />
              </label>
              <label className="flex items-center gap-2">
                Size
                <select value={size} onChange={(e) => setSize(Number(e.target.value))} className="rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-gray-200">
                  <option value={1024}>1024²</option>
                  <option value={768}>768²</option>
                  <option value={2048}>2048² (HiDream native; slow elsewhere)</option>
                </select>
              </label>
              <span className="text-gray-500">Hosted models ignore the seed.</span>
            </div>
          </div>
        }
        run={async (model, { compareGroup, signal }) => {
          const r = await fetch("/api/labs/image/run", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: model.id, prompt, seed: seedNum, size, compareGroup: compareGroup || null }),
            signal,
          });
          const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
          if (!r.ok) return { ok: false, model: model.id, local: model.local, error: j.error ?? `HTTP ${r.status}` };
          return j as LabRunResult<ImageLabOutput>;
        }}
        renderOutput={(r) => {
          const out = r.output;
          if (!out) return null;
          return (
            <figure className="space-y-1">
              <a href={out.url} target="_blank" rel="noreferrer">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={out.url} alt={`${r.model} output`} className="w-full rounded-lg border border-gray-800" />
              </a>
              <figcaption className="text-[11px] text-gray-500">
                {out.width}×{out.height} · seed {out.seed}{out.steps ? ` · ${out.steps} steps` : ""} · saved to Image Lab
              </figcaption>
            </figure>
          );
        }}
      />

      <section className="space-y-3">
        <div>
          <h2 className="text-base font-semibold text-gray-100">Evaluation suite</h2>
          <p className="text-xs text-gray-400">
            Twelve fixed prompts, two seeds, every installed model side by side. Run with{" "}
            <code className="text-gray-300">node scripts/experiment-image-suite.mjs</code>; judge the objective checks here.
          </p>
        </div>
        <ImageEvalView />
      </section>
    </div>
  );
}
