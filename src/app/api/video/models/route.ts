import { NextResponse } from "next/server";
import os from "os";
import policyJson from "../../../../../config/resource-policy.json";
import { VIDEO_MODELS, requiredFiles, type VideoModelSpec } from "@/lib/video-models";
import { getHost, servedModels } from "@/lib/host";
import { getServiceUrl } from "@/lib/services";
import { modelMetaFor, type Footprint } from "@/lib/providers";
import { gpuReading } from "@/lib/sysinfo";
import { listHolders, smallestRelease } from "@/lib/gpu-holders-live";
import type { GpuHolder } from "@/lib/gpu-holders";

export const dynamic = "force-dynamic";

export type VideoModelStatus = {
  spec: VideoModelSpec;
  /** Declared for this host in its profile (`serves.video`), or a cloud model with a key. */
  available: boolean;
  /** Every weight file ComfyUI can see; null when ComfyUI could not be asked. */
  installed: boolean | null;
  missing: string[];
  serviceUp: boolean;
  params?: string;
  checkpoint?: string;
  license?: string;
  docs?: string;
  footprint?: Footprint;
  /** Can it run right now, and if not, the fewest things to stop. */
  fit: {
    ok: boolean;
    needVramGb: number | null;
    needRamGb: number | null;
    shortVramGb: number;
    shortRamGb: number;
    stop: GpuHolder[] | null;
    note: string;
  } | null;
};

const policy = policyJson as { budgets?: { ramSafetyGb?: number; vramSafetyGb?: number } };

/** Which files ComfyUI lists per folder — the engine is the authority on what it can load. */
async function comfyListing(base: string, folders: string[]): Promise<Map<string, Set<string>> | null> {
  try {
    const out = new Map<string, Set<string>>();
    await Promise.all(
      folders.map(async (f) => {
        const r = await fetch(`${base}/models/${f}`, { signal: AbortSignal.timeout(4000) });
        if (!r.ok) throw new Error(String(r.status));
        out.set(f, new Set((await r.json()) as string[]));
      }),
    );
    return out;
  } catch {
    return null;
  }
}

/**
 * GET — the video models, on THIS host: which are declared, which ComfyUI can
 * load, what each needs, and — if one would not fit right now — the smallest
 * set of running things to stop, from live readings rather than guesses.
 */
export async function GET() {
  const host = getHost();
  const comfy = host.services.find((s) => s.id === "comfyui");
  const served = new Set(comfy ? servedModels(comfy, "video") : []);
  const base = comfy ? getServiceUrl("comfyui") : null;
  const folders = [...new Set(VIDEO_MODELS.flatMap((m) => requiredFiles(m).map((f) => f.folder)))];
  const [listing, holders, vram] = await Promise.all([
    base ? comfyListing(base, folders) : Promise.resolve(null),
    listHolders().catch(() => [] as GpuHolder[]),
    host.gpu === "nvidia" ? gpuReading().catch(() => null) : Promise.resolve(null),
  ]);
  const freeVramGb = vram ? vram.mem_free / 1024 : null;
  const freeRamGb = os.freemem() / 1024 ** 3;
  const unified = host.memory.kind === "unified";
  const vramSafety = policy.budgets?.vramSafetyGb ?? 0;
  const ramSafety = policy.budgets?.ramSafetyGb ?? 0;

  const models: VideoModelStatus[] = VIDEO_MODELS.map((spec) => {
    const meta = modelMetaFor(spec.id);
    if (!spec.local) {
      const keyed = spec.backend === "gemini" ? !!process.env.GEMINI_API_KEY : false;
      return {
        spec,
        available: keyed,
        installed: keyed,
        missing: keyed ? [] : ["GEMINI_API_KEY"],
        serviceUp: keyed,
        license: meta?.license ?? spec.licence,
        docs: meta?.docs,
        // A key proves nothing about quota: on 27 Sep 2026 this box's key was
        // refused for Veo ("exceeded your current quota") — Veo needs billing
        // on the Gemini project. The first run is the only honest check.
        fit: {
          ok: keyed,
          needVramGb: null,
          needRamGb: null,
          shortVramGb: 0,
          shortRamGb: 0,
          stop: [],
          note: keyed ? "Key present; quota is only known once a run is tried." : "No GEMINI_API_KEY on this machine.",
        },
      };
    }
    const missing = listing
      ? requiredFiles(spec).filter((f) => !listing.get(f.folder)?.has(f.file)).map((f) => `${f.folder}/${f.file}`)
      : [];
    const fp = meta?.footprint;
    const needV = fp?.vramGb ?? null;
    const needR = fp?.ramGb ?? null;
    // On a unified host both numbers draw on one pool.
    const shortV = needV != null && freeVramGb != null && !unified ? Math.max(0, needV + vramSafety - freeVramGb) : 0;
    const shortR = needR != null ? Math.max(0, (unified ? needR + (needV ?? 0) : needR) + ramSafety - freeRamGb) : 0;
    const round1 = (n: number) => Math.round(n * 10) / 10;
    const cover = shortV || shortR ? smallestRelease(holders, shortV, shortR) : [];
    // When nothing the console controls covers it, still name what helps and
    // say what would remain — the rest is held by other applications.
    const helpful = holders.filter((h) => (shortV > 0 && h.vramGb > 0) || (shortR > 0 && h.ramGb > 0));
    const stop = cover ?? helpful;
    const leftV = Math.max(0, shortV - stop.reduce((a, h) => a + h.vramGb, 0));
    const leftR = Math.max(0, shortR - stop.reduce((a, h) => a + h.ramGb, 0));
    const short = (v: number, r: number) =>
      [v ? `${round1(v)} GB VRAM` : "", r ? `${round1(r)} GB RAM` : ""].filter(Boolean).join(" and ");
    const act = (list: GpuHolder[]) =>
      list
        .map((h) => (h.id === "comfyui" ? "freeing ComfyUI's cached weights" : h.kind === "ollama-model" ? `unloading ${h.label}` : `stopping ${h.label}`))
        .join(" and ");
    return {
      spec,
      available: served.has(spec.id),
      installed: listing ? missing.length === 0 : null,
      missing,
      serviceUp: !!listing,
      params: meta?.params,
      checkpoint: meta?.checkpoint,
      license: meta?.license ?? spec.licence,
      docs: meta?.docs,
      footprint: fp,
      fit: {
        ok: shortV === 0 && shortR === 0,
        needVramGb: needV,
        needRamGb: needR,
        shortVramGb: round1(shortV),
        shortRamGb: round1(shortR),
        stop,
        note:
          needV == null
            ? "No measured footprint yet — the coordinator will decide at run time."
            : shortV === 0 && shortR === 0
              ? `Fits now: needs ${needV} GB VRAM and ${needR ?? 0} GB RAM; ${freeVramGb != null ? `${round1(freeVramGb)} GB VRAM and ` : ""}${round1(freeRamGb)} GB RAM free.`
              : cover
                ? `Short by ${short(shortV, shortR)}. Make room by ${act(stop)}.`
                : stop.length
                  ? `Short by ${short(shortV, shortR)}. Even ${act(stop)} would leave it ${short(leftV, leftR)} short — that part is held by applications outside the console.`
                  : `Short by ${short(shortV, shortR)}, all of it held by applications outside the console — close some, or wait for them to finish.`,
      },
    };
  });

  return NextResponse.json({
    host: { id: host.id, name: host.name, memoryKind: host.memory.kind },
    comfyUp: !!listing,
    free: { vramGb: freeVramGb == null ? null : Math.round(freeVramGb * 10) / 10, ramGb: Math.round(freeRamGb * 10) / 10 },
    holders,
    models,
  });
}
