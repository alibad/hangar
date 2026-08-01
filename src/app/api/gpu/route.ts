import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import os from "os";
import { SERVICE_REGISTRY, getServiceUrl } from "@/lib/services";

const execFileP = promisify(execFile);

/**
 * Host RAM, reported alongside VRAM because on this box it is the tighter
 * constraint and nothing was watching it.
 *
 * Qwen-Image keeps ~28 GB of fp8 weights in system RAM permanently
 * (enable_model_cpu_offload streams them to the card per stage), and a FLUX run
 * through ComfyUI wants a similar amount. Two of those do not fit in 63 GB — a
 * collision that has already killed the Qwen service once with a MemoryError
 * mid-shard-load, while every VRAM number on screen looked perfectly healthy.
 */
function hostRam() {
  const total = os.totalmem();
  const free = os.freemem();
  return {
    total_gb: Math.round((total / 1024 ** 3) * 10) / 10,
    free_gb: Math.round((free / 1024 ** 3) * 10) / 10,
    used_gb: Math.round(((total - free) / 1024 ** 3) * 10) / 10,
    pct_used: total ? Math.round(((total - free) / total) * 1000) / 10 : 0,
  };
}

/**
 * GPU status, read straight from nvidia-smi.
 *
 * This used to proxy `${MANAGER_URL}/gpu` with MANAGER_URL pointing at the
 * console's own port — an endpoint that exists on neither the console nor the
 * manager — so it had been returning 502 and the GPU tab rendered its
 * "unavailable" state permanently. The console runs on the box, so it can just
 * ask nvidia-smi.
 *
 * PER-SERVICE VRAM: nvidia-smi cannot report per-process memory on Windows
 * (WDDM returns [N/A]), so attribution comes from each GPU service reporting its
 * OWN torch allocation on /health. That is more accurate than nvidia-smi would
 * be anyway — it is the process's real reservation rather than a driver guess.
 */

const FIELDS = [
  "name",
  "pstate",
  "fan.speed",
  "memory.total",
  "memory.used",
  "memory.free",
  "utilization.gpu",
  "utilization.memory",
  "temperature.gpu",
  "power.draw",
  "power.limit",
] as const;

const num = (v: string) => {
  const n = Number(String(v).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

/**
 * Ask every service that's up how much VRAM it is holding.
 *
 * Deliberately NOT filtered by category: whether something is presentationally
 * an "app" (ComfyUI) or an "AI backend" has nothing to do with whether it uses
 * the GPU, and tying attribution to the category meant re-categorising a service
 * silently dropped it from the VRAM breakdown. Only monitoring services — which
 * are Docker sidecars that never touch CUDA — are skipped. Anything that doesn't
 * report `vram.process_mb` simply doesn't appear.
 */
/**
 * ComfyUI deliberately has NO entry here, and it is not an oversight.
 *
 * It's third-party, so it will never grow a `vram.process_mb` field, and its
 * /system_stats is not a usable substitute on this box. Measured during a FLUX
 * run on 2026-07-30: the card went to 31.7 GiB while `torch_vram_total` peaked
 * at 0.44 GiB, because ComfyUI runs cudaMallocAsync with comfy-aimdo
 * DynamicVRAM and allocates outside the torch caching allocator. Attributing
 * that field to ComfyUI would have printed "0.4 GB" next to a process holding
 * ~30 GB — worse than printing nothing.
 *
 * The other field pair, `vram_total - vram_free`, is a whole-GPU reading, which
 * is what `vram_summary.unaccounted_mb` already reports honestly. Per-process
 * VRAM would need nvidia-smi PID accounting, which Windows doesn't provide.
 * Leave ComfyUI in the unaccounted bucket until one of those changes.
 */
async function serviceVram(memTotalMb: number) {
  const candidates = SERVICE_REGISTRY.filter((s) => s.category !== "monitoring" && !s.llm);
  const entries = await Promise.all(
    candidates.map(async (svc) => {
      try {
        const res = await fetch(getServiceUrl(svc.id) + svc.healthPath, {
          signal: AbortSignal.timeout(2000),
        });
        if (!res.ok) return null;
        const h = await res.json();
        // Our services report {vram: {process_mb}}; older ones only had a
        // whole-GPU reading, which is useless for attribution — ignore it.
        const mb = h?.vram?.process_mb;
        if (typeof mb !== "number" || mb <= 0) return null;
        return [
          svc.id,
          {
            name: svc.name,
            used_mb: Math.round(mb),
            pct_of_total: memTotalMb ? Math.round((mb / memTotalMb) * 1000) / 10 : 0,
            model: typeof h?.model === "string" ? h.model : null,
          },
        ] as const;
      } catch {
        return null; // not running
      }
    }),
  );
  return Object.fromEntries(entries.filter(Boolean) as [string, object][]);
}

export async function GET() {
  try {
    const { stdout } = await execFileP(
      "nvidia-smi",
      [`--query-gpu=${FIELDS.join(",")}`, "--format=csv,noheader,nounits"],
      { timeout: 10000 },
    );
    const row = stdout.trim().split("\n")[0]?.split(",").map((s) => s.trim()) ?? [];
    if (row.length < FIELDS.length) throw new Error("unexpected nvidia-smi output");

    const [name, pstate, fan, memTotal, memUsed, memFree, gpuUtil, memUtil, temp, pDraw, pLimit] = row;
    const mem_total = num(memTotal);
    const mem_used = num(memUsed);
    const ratio = mem_total ? mem_used / mem_total : 0;

    const service_vram = await serviceVram(mem_total);
    const accounted = Object.values(service_vram).reduce(
      (a, s) => a + (s as { used_mb: number }).used_mb, 0,
    );

    // What this means for "can I start another model right now".
    const impact =
      ratio > 0.95 ? "critical" : ratio > 0.85 ? "warning" : ratio > 0.6 ? "busy" : "ok";
    const impact_msg =
      impact === "critical" ? "VRAM exhausted — stop a model before starting another"
      : impact === "warning" ? "Little VRAM left — a large model will not fit"
      : impact === "busy" ? "In use — room for a small model"
      : "Plenty of headroom";

    return NextResponse.json({
      name,
      pstate,
      fan_speed: fan === "[N/A]" ? null : num(fan),
      mem_total,
      mem_used,
      mem_free: num(memFree),
      gpu_util: num(gpuUtil),
      mem_util: num(memUtil),
      temperature: num(temp),
      power_draw: num(pDraw),
      power_limit: num(pLimit),
      impact,
      impact_msg,
      host_ram: hostRam(),
      service_vram,
      vram_summary: {
        accounted_mb: accounted,
        // Everything not claimed by a service: desktop compositing, browsers,
        // and any model whose service does not self-report.
        unaccounted_mb: Math.max(0, mem_used - accounted),
        unaccounted_note: "desktop + apps + services that don't report VRAM",
      },
    });
  } catch (err) {
    // Host RAM still goes out: it does not come from nvidia-smi, and a missing
    // GPU reading is no reason to blind the one budget that OOMs this box.
    return NextResponse.json(
      {
        error: `nvidia-smi unavailable: ${err instanceof Error ? err.message : err}`,
        host_ram: hostRam(),
      },
      { status: 502 },
    );
  }
}
