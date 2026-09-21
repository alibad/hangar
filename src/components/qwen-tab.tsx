"use client";

import { useState } from "react";
import QwenStudio from "./qwen-studio";
import QwenActivity from "./qwen-activity";
import { ImageSquare } from "@phosphor-icons/react";
import { AlertTriangle, CheckCircle2, ExternalLink, LoaderCircle, Search } from "lucide-react";
import { ToolPageHeader } from "./tool-page";
import { getRuntime, runtimeStatus, isVerificationStale } from "@/lib/runtimes";

/**
 * Said in place, above a working studio — never instead of it.
 *
 * This replaced the whole studio between 2026-09-20 and 2026-09-21, on a
 * `getHostId() === "b5"` check. Two things were wrong with that:
 *
 *   - It broke this console's own rule. Every surface exists on every machine;
 *     availability is SHOWN, never used to remove. Swapping the studio out left
 *     no prompt box, so the image prompt typed on Home was written to a draft
 *     the replacement never rendered, and "View saved images" opened the one
 *     gallery that is empty on this host while four real images sat in the
 *     other one.
 *   - It was keyed to a hostname, so it could not be turned off without editing
 *     the component, and it would never turn on for anyone else's Mac.
 *
 * Now it is a banner, it is driven by the profile's `runtimes.image`, and the
 * studio underneath it always works.
 */
function ImageRuntimeNotice({ status, stale }: { status: "unverified" | "unconfigured" | "absent"; stale: boolean }) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runtime = getRuntime("image");

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

  const findImageModels = () => {
    window.sessionStorage.setItem("hangar-model-setup-capability", "image");
    window.localStorage.setItem("bt-active-tab", "models");
    window.history.pushState({ tab: "models" }, "", "#models");
    window.dispatchEvent(new PopStateEvent("popstate"));
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const headline =
    status === "unverified"
      ? stale
        ? "This image model has not been re-checked recently."
        : "This image model has never been checked on this machine."
      : status === "unconfigured"
        ? "No image engine is set up on this machine yet."
        : "Image generation is not configured on this machine.";

  const body =
    status === "unverified"
      ? `Hangar can send prompts to ${runtime?.label ?? runtime?.model ?? "the configured engine"}, but nothing has confirmed that what comes back is a picture rather than static. Generate away — every result is checked before it is saved — or prove the runtime in one command first.`
      : "Declare an engine under `runtimes.image` in this host's profile, or pick a model below and let Hangar set one up.";

  return (
    <section className="rounded-2xl border border-amber-500/20 bg-amber-500/[0.04] p-4 sm:p-5">
      <div className="flex max-w-3xl items-start gap-3">
        <span className="mt-0.5 rounded-xl border border-amber-500/25 bg-amber-500/10 p-2 text-amber-300">
          <AlertTriangle className="h-5 w-5" />
        </span>
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-300">Image runtime</p>
          <h2 className="mt-1 text-lg font-semibold text-gray-100">{headline}</h2>
          <p className="mt-2 text-sm leading-relaxed text-gray-400">{body}</p>
          <code className="mt-3 inline-block rounded-md border border-gray-800 bg-gray-950/60 px-2.5 py-1 text-xs text-gray-300">
            node scripts/doctor.mjs image --write
          </code>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={findImageModels}
          className="inline-flex items-center gap-2 rounded-lg border border-sky-500/35 bg-sky-500/[0.06] px-4 py-2 text-sm font-semibold text-sky-200 transition hover:border-sky-400/60 hover:bg-sky-500/10"
        >
          <Search className="h-4 w-4" />
          Find image models
        </button>
        {/* Only offered where it can work. The route refuses on anything but a
            Mac, and a button that answers "not on this platform" is noise. */}
        {typeof navigator !== "undefined" && navigator.platform?.startsWith("Mac") && (
          <button
            type="button"
            onClick={openDrawThings}
            disabled={opening}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-700 px-4 py-2 text-sm font-medium text-gray-300 transition hover:border-gray-500 hover:text-white disabled:cursor-wait disabled:opacity-60"
          >
            {opening ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}
            {opening ? "Opening…" : "Open Draw Things"}
          </button>
        )}
      </div>
      {error && <p role="alert" className="mt-3 text-xs text-red-300">{error}</p>}
    </section>
  );
}

/** The quiet version: the runtime has been proven, so say so and get out of the way. */
function ImageRuntimeVerified() {
  const runtime = getRuntime("image");
  if (!runtime) return null;
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-500">
      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
      <span className="text-gray-400">{runtime.label ?? runtime.model}</span>
      <span className="text-gray-600">·</span>
      <span>{runtime.driver}</span>
      {runtime.verifiedNote && (
        <>
          <span className="text-gray-600">·</span>
          <span>output checked: {runtime.verifiedNote}</span>
        </>
      )}
    </p>
  );
}

// The Image tab has two surfaces:
//  • Studio   — the curated, human-driven workspace (generate/edit/batch + a
//               foldered gallery of what you saved).
//  • Activity — a read-only firehose of EVERY image the box produces, from any
//               caller (console, quote-forge, scripts), tagged by source.
export default function QwenTab() {
  const [view, setView] = useState<"studio" | "activity">("studio");
  const status = runtimeStatus("image");
  const stale = isVerificationStale("image");

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
      {view === "studio" ? (
        <>
          {status === "verified" && !stale ? (
            <ImageRuntimeVerified />
          ) : (
            <ImageRuntimeNotice status={stale ? "unverified" : (status as "unverified" | "unconfigured" | "absent")} stale={stale} />
          )}
          <QwenStudio />
        </>
      ) : (
        <QwenActivity />
      )}
    </div>
  );
}
