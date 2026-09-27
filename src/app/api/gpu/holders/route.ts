import { NextResponse } from "next/server";
import { getCatalogue, getFootprintsByService } from "@/lib/providers";
import { ollamaModelFromTarget, residentModels } from "@/lib/ollama";
import { SERVICE_REGISTRY, getServiceUrl } from "@/lib/services";
import type { GpuHolder } from "@/lib/gpu-holders";

export const dynamic = "force-dynamic";

/**
 * What is holding the box's RAM and VRAM RIGHT NOW, and what can be done about it.
 *
 * This exists because a capacity denial names a shortfall but not a remedy, and
 * the remedy is usually not on the surface you were denied on. The Image Studio
 * can be blocked by an Ollama TEXT model that is not in its picker at all — a
 * 31B at ~20 GB of a 32 GB card is the single most common blocker here — and by
 * the Qwen image service, which keeps tens of gigabytes of RAM resident while
 * completely idle.
 *
 * Deliberately NOT built from the resource coordinator's own accounting. That
 * tracks each service's declared RESIDENT cost, which is ~0 for Ollama by
 * design — the real peak is carried by the workload lease, so between runs the
 * coordinator can correctly deny on live free VRAM while being unable to name
 * the 20 GB that is actually missing. Every figure below is measured instead.
 */

const round1 = (n: number) => Math.round(n * 10) / 10;

/** What a service holds on the card while idle, per its declared footprint. */
function residentVram(fp: { vramGb?: number; idleVramGb?: number; kind?: string }): number {
  return fp.idleVramGb ?? (fp.kind === "reserved" ? fp.vramGb ?? 0 : 0);
}

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

export async function GET() {
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
  const [qwenUp, comfyUp] = await Promise.all([serviceUp("qwen"), serviceUp("comfyui")]);
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
    // ComfyUI releases weights when idle, so its declared footprint is the PEAK
    // of a run, not what it is sitting on. Reporting the peak here would invite
    // freeing the cheapest holder on the box.
    holders.push({
      id: "comfyui",
      kind: "image-service",
      label: "ComfyUI",
      detail: "Releases weights when idle — frees little unless a run just finished",
      vramGb: 0,
      ramGb: 0,
    });
  }

  // ── Any other running service that keeps memory resident while idle ──
  // Qwen was the first of these; the 3D pipeline's SAM 3, TripoSR and trellis
  // are the same shape, and a Lab that chains them (image → cutout → mesh) is
  // exactly where the card runs out. Declared, measured resident cost from
  // config/model-meta.json: idleVram/idleRam, or the footprint itself for a
  // "reserved" model. Services declaring nothing resident are left out rather
  // than listed as freeing 0.
  const candidates = Object.entries(footprints).filter(([svc, { footprint: fp }]) => {
    if (svc === "qwen" || svc === "comfyui" || svc === "ollama") return false;
    return residentVram(fp) >= 0.5 && SERVICE_REGISTRY.some((s) => s.id === svc);
  });
  const up = await Promise.all(candidates.map(([svc]) => serviceUp(svc)));
  candidates.forEach(([svc, { footprint: fp }], i) => {
    if (!up[i]) return;
    const name = SERVICE_REGISTRY.find((s) => s.id === svc)?.name ?? svc;
    holders.push({
      id: svc,
      kind: "service",
      label: name,
      detail: "Keeps its model resident while idle",
      vramGb: round1(residentVram(fp)),
      ramGb: round1(fp.idleRamGb ?? (fp.kind === "reserved" ? fp.ramGb ?? 0 : 0)),
    });
  });

  holders.sort((a, b) => b.vramGb + b.ramGb - (a.vramGb + a.ramGb));
  return NextResponse.json({ holders });
}
