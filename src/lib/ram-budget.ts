/**
 * Will these models fit in host RAM at the same time?
 *
 * VRAM is the constraint everyone watches, and it is the wrong one on this box.
 * Qwen-Image keeps ~28 GB of fp8 weights in SYSTEM RAM permanently, and a FLUX
 * run through ComfyUI wants a similar amount; two of those do not fit in 63 GB.
 * That collision has already killed the Qwen service with a MemoryError
 * mid-shard-load while every VRAM figure on screen looked healthy — and compare
 * mode will happily queue exactly that pairing unless something checks first.
 *
 * Deliberately dependency-free (no `os`, no fetch) so the API route and the
 * picker run the SAME arithmetic. The caller supplies free RAM: the server reads
 * os.freemem(), the client reads it from /api/gpu.
 */

export type FootprintLike = { ramGb?: number; idleRamGb?: number };

export type RamProjection = {
  freeGb: number;
  requiredGb: number;
  headroomGb: number;
  fits: boolean;
  /** Per-service so the UI can say WHICH pairing is the problem. */
  parts: { serviceId: string; ramGb: number }[];
  /** Selected models that cost no local RAM (cloud), for an honest message. */
  offBox: string[];
};

/**
 * Left for the OS, the console, a browser and whatever else is running. Without
 * it a projection that exactly fills RAM reads as "fits" right up to the moment
 * the machine starts swapping.
 */
export const RAM_SAFETY_GB = 4;

export function projectHostRam(opts: {
  modelIds: string[];
  /** Model id or router alias → BeTenshi service id. Undefined for cloud models. */
  serviceOf: (modelId: string) => string | undefined;
  footprintOf: (serviceId: string) => FootprintLike | undefined;
  freeGb: number;
  safetyGb?: number;
}): RamProjection {
  const { modelIds, serviceOf, footprintOf, freeGb, safetyGb = RAM_SAFETY_GB } = opts;

  // By SERVICE, not by model. Comparing "qwen-image" against "local-qwen-image"
  // is one process reached two ways — counting it twice would refuse a run that
  // fits perfectly well.
  const perService = new Map<string, number>();
  const offBox: string[] = [];

  for (const id of modelIds) {
    const svc = serviceOf(id);
    if (!svc) {
      offBox.push(id);
      continue;
    }
    const ram = footprintOf(svc)?.ramGb;
    if (typeof ram === "number" && ram > 0) perService.set(svc, ram);
  }

  const parts = [...perService.entries()].map(([serviceId, ramGb]) => ({ serviceId, ramGb }));
  const requiredGb = parts.reduce((a, p) => a + p.ramGb, 0);
  const headroomGb = Math.round((freeGb - safetyGb - requiredGb) * 10) / 10;

  return {
    freeGb,
    requiredGb: Math.round(requiredGb * 10) / 10,
    headroomGb,
    // A model already loaded is counted as if it had to be loaded again, so this
    // errs toward refusing. Cheaper than an OOM that takes the service down.
    fits: headroomGb >= 0,
    parts,
    offBox,
  };
}
