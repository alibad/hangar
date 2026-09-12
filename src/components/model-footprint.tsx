"use client";

/**
 * "What does this model cost to run, and what else fits beside it?"
 *
 * One GPU is the binding constraint on this box, but every surface that listed a
 * model showed only its name and parameter count — numbers that don't answer the
 * question you're actually asking when you click Use. The 30B and Qwen-Image
 * can't co-reside; the 7B and Qwen-Image can. That was prose in one tab's footer
 * and invisible everywhere else.
 *
 * Shared so the four model surfaces can't drift into quoting different numbers
 * for the same model. Values and their provenance live in config/model-meta.json.
 */

export type Footprint = {
  /** While working — a peak for `peak`, the standing reservation for `reserved`. */
  vramGb?: number;
  ramGb?: number;
  /**
   * What it costs merely by being STARTED, which is a different number and the
   * one that decides what you can leave running. ComfyUI idle holds 0.13 GB and
   * loads FLUX only on the first workflow run; Qwen-Image idles at ~0.1 GB VRAM
   * but never gives back its ~28 GB of host RAM. A single figure per model
   * cannot say either of those things.
   *
   * Omitted for `reserved` models, where idle and busy are the same by
   * definition — vLLM claims its share at startup and holds it.
   */
  idleVramGb?: number;
  idleRamGb?: number;
  kind?: "reserved" | "peak" | "estimate";
  basis?: string;
};

const KIND_NOTE: Record<string, string> = {
  reserved: "Reserved at startup and held for as long as the service runs — idle costs the same as busy.",
  peak: "Transient peak while working.",
  estimate: "Initial estimate, not a measured peak.",
};

function gb(n: number): string {
  // Sub-GB models would otherwise all read "0 GB".
  return n < 1 ? `${Math.round(n * 1000)} MB` : `${n % 1 === 0 ? n : n.toFixed(1)} GB`;
}

/**
 * `liveVramMb` is the service's self-reported current usage. When present it
 * wins: a measured number beats an estimate, and the gap between them is itself
 * informative (an idle Qwen-Image reads ~0.1 GB against a 20.3 GB peak).
 */
export default function ModelFootprint({
  footprint,
  local = true,
  liveVramMb,
  className = "",
}: {
  footprint?: Footprint;
  local?: boolean;
  liveVramMb?: number | null;
  className?: string;
}) {
  if (!local) {
    return (
      <span
        className={`text-[10px] px-1.5 py-0.5 rounded bg-gray-800/60 text-gray-500 ${className}`}
        title="Runs on the provider's hardware — costs money per call, no local VRAM or RAM."
      >
        off-box
      </span>
    );
  }

  const hasLive = typeof liveVramMb === "number" && liveVramMb > 0;
  if (!footprint?.vramGb && !footprint?.ramGb && !hasLive) return null;

  const kind = footprint?.kind ?? "reserved";
  const parts: string[] = [];
  if (hasLive) parts.push(`${gb(liveVramMb! / 1024)} VRAM now`);
  else if (footprint?.vramGb) parts.push(`~${gb(footprint.vramGb)} VRAM`);
  if (footprint?.ramGb) parts.push(`~${gb(footprint.ramGb)} RAM`);

  // Only worth saying when idle differs from busy — for a reserved model it
  // doesn't, and repeating the same number twice reads as a bug.
  const idle: string[] = [];
  if (footprint?.idleVramGb != null) idle.push(`${gb(footprint.idleVramGb)} VRAM`);
  if (footprint?.idleRamGb != null) idle.push(`${gb(footprint.idleRamGb)} RAM`);

  const title = [
    hasLive && footprint?.vramGb ? `Measured now; ~${gb(footprint.vramGb)} while working.` : null,
    idle.length ? `Idle (started, not working): ${idle.join(" · ")}` : null,
    KIND_NOTE[kind],
    footprint?.basis,
  ]
    .filter(Boolean)
    .join("\n\n");

  return (
    <span
      className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border cursor-help ${
        hasLive
          ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/25"
          : "bg-amber-500/10 text-amber-300/90 border-amber-500/20"
      } ${className}`}
      title={title}
    >
      {/* A reservation and a transient peak are not the same commitment. */}
      <span aria-hidden className="opacity-70">{kind === "peak" ? "▲" : "▮"}</span>
      <span className="tabular-nums">{parts.join(" · ")}</span>
      {/* The cost of merely leaving it started — what decides co-residency. */}
      {idle.length > 0 && !hasLive && (
        <span className="opacity-60 tabular-nums">· idle {idle.join(" · ")}</span>
      )}
    </span>
  );
}
