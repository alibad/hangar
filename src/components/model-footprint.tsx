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
  vramGb?: number;
  ramGb?: number;
  kind?: "reserved" | "peak";
  basis?: string;
};

const KIND_NOTE: Record<string, string> = {
  reserved: "Reserved at startup and held for as long as the service runs.",
  peak: "Transient peak while working; idles near zero.",
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

  const title = [
    hasLive && footprint?.vramGb ? `Measured now; ~${gb(footprint.vramGb)} expected.` : null,
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
    </span>
  );
}
