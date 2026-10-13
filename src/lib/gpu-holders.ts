/**
 * A thing currently holding RAM or VRAM on this box, and enough to act on it.
 *
 * Shared by `GET /api/gpu/holders` and the UI that offers to free them, so the
 * two cannot drift on what `id` means — which matters here because it means
 * different things per kind, and unload rejects the wrong one.
 */
export type GpuHolder = {
  /** For "ollama-model" this is the ROUTER ALIAS, which is what unload wants. */
  id: string;
  kind: "ollama-model" | "image-service" | "service";
  label: string;
  detail: string;
  vramGb: number;
  ramGb: number;
};

/** Where a holder's Free button posts, and what it says while doing it. */
export function releaseRequest(h: GpuHolder): {
  url: string;
  body: Record<string, unknown>;
  verb: string;
  title: string;
} {
  if (h.kind === "ollama-model") {
    return {
      url: "/api/ollama/unload",
      body: { model: h.id },
      verb: "Unload",
      title: `Unload ${h.label} from Ollama. The runtime keeps running and the other models stay available.`,
    };
  }
  if (h.id === "comfyui") {
    return {
      url: "/api/comfyui/unload",
      body: {},
      verb: "Free weights",
      title: "Release ComfyUI's weights without stopping it. All four of its image models stay available.",
    };
  }
  return {
    url: `/api/services/${h.id}`,
    body: { action: "stop" },
    verb: "Stop",
    title: `Stop the ${h.label} and release everything it holds. It can be started again from Run setup.`,
  };
}

/**
 * The fewest holders whose release covers a shortfall — "stop these two
 * things". Exhaustive over subsets (there are never more than a dozen
 * holders); among the smallest sets, the one that frees the least, so nothing
 * is stopped that did not need to be. Null when even all of them are not
 * enough — then the memory is held outside the console's reach.
 */
export function smallestRelease(
  holders: GpuHolder[],
  shortVramGb: number,
  shortRamGb: number,
): GpuHolder[] | null {
  if (shortVramGb <= 0 && shortRamGb <= 0) return [];
  const pool = holders.filter((h) => h.vramGb > 0 || h.ramGb > 0).slice(0, 14);
  let best: { set: GpuHolder[]; freed: number } | null = null;
  for (let mask = 1; mask < 1 << pool.length; mask++) {
    const set = pool.filter((_, i) => mask & (1 << i));
    const v = set.reduce((a, h) => a + h.vramGb, 0);
    const r = set.reduce((a, h) => a + h.ramGb, 0);
    if (v + 1e-6 < shortVramGb || r + 1e-6 < shortRamGb) continue;
    const freed = v + r;
    if (!best || set.length < best.set.length || (set.length === best.set.length && freed < best.freed)) {
      best = { set, freed };
    }
  }
  return best?.set ?? null;
}
