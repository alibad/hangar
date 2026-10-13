import { getCatalogue, getFootprintsByService } from "./providers";
import { ollamaModelFromTarget, residentModels } from "./ollama";
import { SERVICE_REGISTRY, getServiceUrl } from "./services";
import { listeners } from "./sysinfo";
import type { GpuHolder } from "./gpu-holders";

export { smallestRelease } from "./gpu-holders";

/** Resident set of a ComfyUI process with nothing loaded, measured on BeTenshi 2026-09-27. */
const COMFY_EMPTY_RSS_GB = 1.1;

/**
 * What is holding the box's RAM and VRAM RIGHT NOW, and what can be done about it.
 *
 * This exists because a capacity denial names a shortfall but not a remedy, and
 * the remedy is usually not on the surface you were denied on. The Image Studio
 * can be blocked by an Ollama TEXT model that is not in its picker at all — a
 * 31B at ~20 GB of a 32 GB card is the single most common blocker here — and by
 * the Qwen image service, which keeps tens of gigabytes of RAM resident while
 * completely idle. A video run, which wants most of the card AND tens of GB of
 * host RAM for offloaded weights, is blocked by nearly anything: a vLLM
 * container, Bonsai, the Qwen service, a music model.
 *
 * Deliberately NOT built from the resource coordinator's own accounting. That
 * tracks each service's declared RESIDENT cost, which is ~0 for Ollama by
 * design — the real peak is carried by the workload lease, so between runs the
 * coordinator can correctly deny on live free VRAM while being unable to name
 * the 20 GB that is actually missing. Ollama's figure is live; a running
 * service's is its measured `reserved` footprint from model-meta, which is what
 * it holds from start to stop.
 *
 * Shared by GET /api/gpu/holders and the Video Lab's fit check.
 */

const round1 = (n: number) => Math.round(n * 10) / 10;

/** What a service holds on the card while idle, per its declared footprint. */
function residentVram(fp: { vramGb?: number; idleVramGb?: number; kind?: string }): number {
  return fp.idleVramGb ?? (fp.kind === "reserved" ? fp.vramGb ?? 0 : 0);
}
function residentRam(fp: { ramGb?: number; idleRamGb?: number; kind?: string }): number {
  return fp.idleRamGb ?? (fp.kind === "reserved" ? fp.ramGb ?? 0 : 0);
}

/** Handled specially below, or holds nothing worth listing. */
const SPECIAL = new Set(["ollama", "qwen", "comfyui"]);

async function serviceUp(id: string): Promise<boolean> {
  const svc = SERVICE_REGISTRY.find((s) => s.id === id);
  if (!svc) return false;
  try {
    const res = await fetch(getServiceUrl(id) + svc.healthPath, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function listHolders(): Promise<GpuHolder[]> {
  const holders: GpuHolder[] = [];

  // ── Ollama: live residency, per model ──
  // size_vram is what the runtime reports it actually has on the card, so this
  // is the one holder whose cost needs no estimating.
  const [resident, catalogue] = await Promise.all([residentModels(), getCatalogue()]);
  if (resident.length) {
    const aliasByTarget = new Map<string, string>();
    for (const m of catalogue.models) {
      if (m.serviceId !== "ollama") continue;
      const target = ollamaModelFromTarget(m.target);
      if (target) aliasByTarget.set(target, m.id);
    }
    for (const r of resident) {
      const alias = aliasByTarget.get(r.name);
      // Without an alias there is nothing to POST to unload, so listing it would
      // be a dead row. Rare: it means a model was pulled but never routed.
      if (!alias) continue;
      holders.push({
        id: alias,
        kind: "ollama-model",
        label: r.name,
        detail: "Text model on Ollama — not an image model",
        vramGb: round1(r.vramBytes / 1e9),
        ramGb: 0,
      });
    }
  }

  // ── Image services holding weights while idle ──
  const footprints = getFootprintsByService();
  // Declared, measured resident cost from config/model-meta.json: idleVram /
  // idleRam, or the footprint itself for a "reserved" model. The 3D pipeline's
  // SAM 3, TripoSR and trellis are this shape, as are vLLM and Bonsai. Services
  // declaring nothing resident are left out rather than listed as freeing 0.
  const others = SERVICE_REGISTRY.filter((s) => {
    if (SPECIAL.has(s.id)) return false;
    const fp = footprints[s.id]?.footprint;
    return !!fp && residentVram(fp) >= 0.5;
  });
  const [qwenUp, comfyUp, ...othersUp] = await Promise.all([
    serviceUp("qwen"),
    serviceUp("comfyui"),
    ...others.map((s) => serviceUp(s.id)),
  ]);
  if (qwenUp) {
    const fp = footprints["qwen"]?.footprint;
    holders.push({
      id: "qwen",
      kind: "image-service",
      label: "Qwen-Image service",
      detail: "Keeps its checkpoint resident while idle",
      vramGb: round1(fp?.vramGb ?? 0),
      ramGb: round1(fp?.ramGb ?? 0),
    });
  }
  if (comfyUp) {
    // Its declared footprint is the PEAK of a run, not what it is sitting on,
    // so it is not used here. What it IS sitting on is measured: ComfyUI keeps
    // the last run's weights cached in RAM until told otherwise, and was seen
    // idle at 11.5 GB resident / 25 GB private after an image run — the single
    // largest holder on the box, previously listed as 0. An empty ComfyUI
    // process is ~1 GB resident, which "Free weights" cannot release.
    const port = SERVICE_REGISTRY.find((s) => s.id === "comfyui")?.localPort;
    const rss = port ? (await listeners().catch(() => [])).find((l) => l.port === port)?.rss ?? 0 : 0;
    const cachedGb = Math.max(0, rss / 1e9 - COMFY_EMPTY_RSS_GB);
    holders.push({
      id: "comfyui",
      kind: "image-service",
      label: "ComfyUI",
      detail: cachedGb >= 1 ? "Weights cached from its last run — freeing them keeps ComfyUI running" : "Idle and empty — nothing to free",
      vramGb: 0,
      ramGb: round1(cachedGb),
    });
  }

  // ── Any other running service that reserves memory from start to stop ──
  others.forEach((s, i) => {
    if (!othersUp[i]) return;
    const fp = footprints[s.id].footprint;
    holders.push({
      id: s.id,
      kind: "service",
      label: s.name,
      detail: "Keeps its model resident while idle",
      vramGb: round1(residentVram(fp)),
      ramGb: round1(residentRam(fp)),
    });
  });

  holders.sort((a, b) => b.vramGb + b.ramGb - (a.vramGb + a.ramGb));
  return holders;
}
