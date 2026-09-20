"use client";

import { useState } from "react";
import QwenStudio from "./qwen-studio";
import QwenActivity from "./qwen-activity";
import { ImageSquare } from "@phosphor-icons/react";
import { AlertTriangle, CheckCircle2, ExternalLink, LoaderCircle } from "lucide-react";
import { ToolPageHeader } from "./tool-page";
import { getHostId } from "@/lib/host";

function MacImagePlaceholder({ onActivity }: { onActivity: () => void }) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openDrawThings = async () => {
    setOpening(true);
    setError(null);
    try {
      const response = await fetch("/api/local/open-draw-things", { method: "POST" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Could not open the image app");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setOpening(false);
    }
  };

  return (
    <section className="rounded-2xl border border-gray-800 bg-gray-900/70 p-5 sm:p-6">
      <div className="flex max-w-3xl items-start gap-3">
        <span className="mt-0.5 rounded-xl border border-amber-500/25 bg-amber-500/10 p-2 text-amber-300">
          <AlertTriangle className="h-5 w-5" />
        </span>
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-300">Hangar connection needs repair</p>
          <h2 className="mt-1 text-xl font-semibold text-gray-100">Local image generation is installed, but not reliable inside Hangar yet.</h2>
          <p className="mt-2 text-sm leading-relaxed text-gray-400">
            This Mac keeps the FLUX.2 Klein image model inside <strong className="font-medium text-gray-200">Draw Things</strong>, a local image-generation app. The model works there, but Hangar&apos;s current command-line connection returns corrupted images. Generation is disabled here so you do not wait for unusable results.
          </p>
        </div>
      </div>

      <div className="mt-5 grid gap-2 sm:grid-cols-3">
        <div className="rounded-xl border border-gray-800 bg-gray-950/45 p-3">
          <span className="flex items-center gap-2 text-xs font-medium text-emerald-300"><CheckCircle2 className="h-4 w-4" /> Model installed</span>
          <p className="mt-1 text-xs text-gray-500">FLUX.2 Klein 4B</p>
        </div>
        <div className="rounded-xl border border-gray-800 bg-gray-950/45 p-3">
          <span className="flex items-center gap-2 text-xs font-medium text-emerald-300"><CheckCircle2 className="h-4 w-4" /> Native app works</span>
          <p className="mt-1 text-xs text-gray-500">Draw Things on this Mac</p>
        </div>
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.04] p-3">
          <span className="flex items-center gap-2 text-xs font-medium text-amber-300"><AlertTriangle className="h-4 w-4" /> Hangar generation paused</span>
          <p className="mt-1 text-xs text-gray-500">Output verification failed</p>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={openDrawThings}
          disabled={opening}
          className="inline-flex items-center gap-2 rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-orange-400 disabled:cursor-wait disabled:opacity-60"
        >
          {opening ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}
          {opening ? "Opening…" : "Open image generator"}
        </button>
        <button
          type="button"
          onClick={onActivity}
          className="rounded-lg border border-gray-700 px-4 py-2 text-sm font-medium text-gray-300 transition hover:border-gray-500 hover:text-white"
        >
          View saved images
        </button>
      </div>
      {error && <p role="alert" className="mt-3 text-xs text-red-300">{error}</p>}
    </section>
  );
}

// The Qwen Image tab has two surfaces:
//  • Studio   — the curated, human-driven workspace (generate/edit/batch + a
//               foldered gallery of what you saved).
//  • Activity — a read-only firehose of EVERY image the box produces, from any
//               caller (console, quote-forge, scripts), tagged by source.
export default function QwenTab() {
  const [view, setView] = useState<"studio" | "activity">("studio");
  const isMacHost = getHostId() === "b5";
  return (
    <div className="tool-page image-page space-y-4">
      <ToolPageHeader
        eyebrow="Visual workstream"
        title="Image Studio"
        description="Generate, edit, compare, and revisit local or cloud images."
        icon={<ImageSquare size={22} weight="duotone" />}
        actions={
          <div className="image-view-switch" role="tablist" aria-label="Image Studio view">
            {(
              [
                ["studio", "Create"],
                ["activity", "Activity"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                role="tab"
                aria-selected={view === id}
                onClick={() => setView(id)}
                className={view === id ? "is-active" : undefined}
              >
                {label}
              </button>
            ))}
          </div>
        }
      />
      {/* No ModelPicker here. This tab is the one place it duplicated something
          that already existed: the studio has its own Model row, so the model
          appeared twice — once as a routing card at the top and again as the
          thing you actually generate with. Local vs cloud selection and the
          box-wide routing it writes now live in that one row. */}
      {view === "studio"
        ? isMacHost
          ? <MacImagePlaceholder onActivity={() => setView("activity")} />
          : <QwenStudio />
        : <QwenActivity />}
    </div>
  );
}
