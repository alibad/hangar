import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import { SERVICE_REGISTRY, getServiceUrl } from "@/lib/services";
import { getHost, isUnifiedMemory } from "@/lib/host";
import { gpuReading, hostMemory, listeners, dockerHostRamMb } from "@/lib/sysinfo";

const execFileP = promisify(execFile);

/**
 * GPU + memory status for THIS host.
 *
 * Which tool answers is decided by the host profile (src/lib/sysinfo.ts):
 * nvidia-smi on BeTenshi, IOAccelerator counters on a Mac. The response shape is
 * the same either way so the Stack tab renders one component, but it carries
 * `memory_model` so the UI knows whether the VRAM and System RAM figures are two
 * budgets (discrete) or the same number seen twice (unified).
 *
 * Host RAM is reported alongside VRAM because on BeTenshi it is the tighter
 * constraint and nothing was watching it. Qwen-Image keeps ~28 GB of fp8 weights
 * in system RAM permanently, and a FLUX run through ComfyUI wants a similar
 * amount. Two of those do not fit in 63 GB — a collision that has already killed
 * the Qwen service with a MemoryError mid-shard-load while every VRAM number on
 * screen looked perfectly healthy.
 *
 * PER-PROCESS VRAM: nvidia-smi cannot report per-process memory on Windows (WDDM
 * returns [N/A]). Two sources fill that in: the Windows GPU performance counters
 * (the same accounting Task Manager uses — `windowsGpuProcesses`, Windows only),
 * and each GPU service reporting its OWN torch allocation on /health. Apple
 * silicon has no per-process VRAM concept at all; there the memory bar is the
 * unified pool and only self-reporting services appear on it.
 */

type GpuProcess = {
  name: string;
  used_mb: number;
  bar_mb: number;
  pct_of_total: number;
  pids: number[];
  kind: "service" | "container" | "system" | "app";
  service_id?: string;
  note?: string;
};

type RawGpuProcess = { pid: number; dedicated_mb: number; process?: string | null; path?: string | null };

let gpuProcessCache: { at: number; rows: RawGpuProcess[] } = { at: 0, rows: [] };

/**
 * Windows WDDM hides per-process memory from nvidia-smi, but the Windows GPU
 * performance counters expose the same dedicated-memory accounting Task
 * Manager uses. Query those counters and resolve each PID to a useful name.
 */
async function windowsGpuProcesses(
  memTotalMb: number,
  memUsedMb: number,
  serviceRamRows: Record<string, { name: string; rss_mb: number; pid: number; pct_of_total: number }>,
  containerWorkloads: string[],
): Promise<GpuProcess[]> {
  let raw = gpuProcessCache.rows;
  if (!raw.length || Date.now() - gpuProcessCache.at > 2000) {
    const ps = [
      "$ErrorActionPreference='SilentlyContinue';",
      "$rows=Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory |",
      "Where-Object DedicatedUsage -gt 0 | ForEach-Object {",
      "if($_.Name -match 'pid_(\\d+)'){ [pscustomobject]@{pid=[int]$matches[1]; dedicated_mb=[math]::Round([double]$_.DedicatedUsage/1MB,1)} } };",
      "$rows | Group-Object pid | ForEach-Object {",
      "$id=[int]$_.Name; $proc=Get-Process -Id $id;",
      "[pscustomobject]@{pid=$id; dedicated_mb=[math]::Round(($_.Group | Measure-Object dedicated_mb -Maximum).Maximum,1); process=$proc.ProcessName; path=$proc.Path} } |",
      "Sort-Object dedicated_mb -Descending | ConvertTo-Json -Compress",
    ].join(" ");
    try {
      const { stdout } = await execFileP("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
        timeout: 8000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      });
      const parsed = JSON.parse(stdout.trim() || "[]");
      raw = (Array.isArray(parsed) ? parsed : [parsed]).filter(
        (row): row is RawGpuProcess => Number(row?.pid) > 0 && Number(row?.dedicated_mb) > 0,
      );
      gpuProcessCache = { at: Date.now(), rows: raw };
    } catch {
      return [];
    }
  }

  const serviceByPid = new Map(
    Object.entries(serviceRamRows)
      .filter(([, service]) => service.pid > 0)
      .map(([id, service]) => [service.pid, { id, name: service.name }]),
  );

  const grouped = new Map<string, Omit<GpuProcess, "bar_mb" | "pct_of_total">>();
  for (const row of raw) {
    const service = serviceByPid.get(Number(row.pid));
    const processName = String(row.process || "Unknown process");
    const path = String(row.path || "");
    const lower = processName.toLowerCase();

    let name = service?.name || processName;
    let kind: GpuProcess["kind"] = service ? "service" : "app";
    let note: string | undefined;
    if (lower === "vmwp") {
      name = "Docker / WSL GPU VM";
      kind = "container";
      note = containerWorkloads.length
        ? `Contains ${containerWorkloads.join(" + ")}`
        : "Containerized GPU workloads; Windows cannot split VRAM by container";
    } else if (lower === "dwm") {
      name = "Windows desktop compositor";
      kind = "system";
      note = "Displays, windows, and desktop composition";
    } else if (lower === "csrss") {
      name = "Windows graphics subsystem";
      kind = "system";
    } else if (/openai[.\\/]codex/i.test(path)) {
      name = "Codex";
    } else if (lower === "steamwebhelper") {
      name = "Steam";
    } else if (lower === "windowsterminal") {
      name = "Windows Terminal";
    } else if (lower === "msedgewebview2") {
      name = "Edge WebView";
    }

    const key = service ? `service:${service.id}` : `${kind}:${name.toLowerCase()}`;
    const current = grouped.get(key);
    if (current) {
      current.used_mb += Number(row.dedicated_mb);
      current.pids.push(Number(row.pid));
    } else {
      grouped.set(key, {
        name,
        used_mb: Number(row.dedicated_mb),
        pids: [Number(row.pid)],
        kind,
        service_id: service?.id,
        note,
      });
    }
  }

  const rows = [...grouped.values()].sort((a, b) => b.used_mb - a.used_mb);
  const measuredMb = rows.reduce((sum, row) => sum + row.used_mb, 0);
  // The Windows and NVIDIA counters are sampled a few hundred milliseconds
  // apart. Normalize only the bar geometry; keep the measured number in labels.
  const scale = measuredMb > memUsedMb && measuredMb > 0 ? memUsedMb / measuredMb : 1;
  return rows.map((row) => ({
    ...row,
    used_mb: Math.round(row.used_mb),
    bar_mb: Math.round(row.used_mb * scale),
    pct_of_total: memTotalMb ? Math.round(((row.used_mb * scale) / memTotalMb) * 1000) / 10 : 0,
  }));
}

/** Which containerized vLLM workloads are actually reachable right now. */
async function runningContainerWorkloads() {
  const llms = SERVICE_REGISTRY.filter((service) => Boolean(service.llm));
  const checks = await Promise.all(llms.map(async (service) => {
    try {
      const response = await fetch(getServiceUrl(service.id) + service.healthPath, {
        signal: AbortSignal.timeout(1500),
      });
      return response.ok ? service.name : null;
    } catch {
      return null;
    }
  }));
  return checks.filter((name): name is string => Boolean(name));
}

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

/**
 * Per-service host RAM, resolved by PORT → owning PID → resident set.
 *
 * Deliberately NOT taken from the manager's own pid bookkeeping: the manager
 * only knows processes it spawned itself, and this box has repeatedly had a
 * service running under a pid it never issued — a watchdog relaunched Qwen and
 * the manager went on reporting the dead pid as healthy. Whoever is actually
 * listening on the port is the process consuming the memory.
 *
 * The listener table itself comes from the host probe (PowerShell on Windows,
 * lsof + ps elsewhere); the proxy-detection below is platform-neutral.
 */
async function serviceRam(totalMb: number): Promise<Record<string, { name: string; rss_mb: number; pid: number; pct_of_total: number }>> {
  const rows = await listeners();
  const byPort = new Map(rows.map((r) => [r.port, r]));

  // A containerised service's port is held by Docker's proxy, not by the server
  // — so webui, grafana and prometheus all resolve to ONE pid. Attributing that
  // process's RSS to each of them would triple-count a few hundred MB while the
  // containers' real memory (inside vmmemWSL) went unreported entirely. Any pid
  // fronting more than one registered service is a proxy, not a workload.
  const svcByPid = new Map<number, string[]>();
  for (const svc of SERVICE_REGISTRY) {
    const hit = byPort.get(svc.localPort);
    if (!hit?.rss) continue;
    const list = svcByPid.get(hit.pid) ?? [];
    list.push(svc.id);
    svcByPid.set(hit.pid, list);
  }

  const out: Record<string, { name: string; rss_mb: number; pid: number; pct_of_total: number }> = {};
  for (const svc of SERVICE_REGISTRY) {
    const hit = byPort.get(svc.localPort);
    if (!hit?.rss) continue;
    if ((svcByPid.get(hit.pid)?.length ?? 0) > 1) continue; // proxied — counted under docker
    const rssMb = Math.round(hit.rss / 1024 ** 2);
    out[svc.id] = {
      name: svc.name,
      rss_mb: rssMb,
      pid: hit.pid,
      pct_of_total: totalMb ? Math.round((rssMb / totalMb) * 1000) / 10 : 0,
    };
  }

  // Where container memory actually is. One synthetic row rather than a lie
  // spread across several real ones. Zero on a host without Docker/WSL.
  const wsl = rows.length ? await dockerHostRamMb() : 0;
  if (wsl > 0) {
    out["docker-wsl"] = {
      name: "Docker / WSL (all containers)",
      rss_mb: wsl,
      pid: 0,
      pct_of_total: totalMb ? Math.round((wsl / totalMb) * 1000) / 10 : 0,
    };
  }
  return out;
}

export async function GET() {
  const hostProfile = getHost();
  const unified = isUnifiedMemory();
  try {
    const [g, host] = await Promise.all([gpuReading(), hostMemory()]);
    const { mem_total, mem_used } = g;
    const ratio = mem_total ? mem_used / mem_total : 0;

    const [service_vram, service_ram, containerWorkloads] = await Promise.all([
      serviceVram(mem_total),
      serviceRam(host.total_gb * 1024),
      runningContainerWorkloads(),
    ]);
    // The performance-counter path is a Windows API; every other host gets an
    // empty list and the bar falls back to service self-reporting.
    const gpu_processes = hostProfile.platform === "win32"
      ? await windowsGpuProcesses(mem_total, mem_used, service_ram, containerWorkloads)
      : [];
    const processAccountedMb = gpu_processes.reduce((sum, process) => sum + process.bar_mb, 0);
    const serviceAccountedMb = Object.values(service_vram).reduce(
      (a, s) => a + (s as { used_mb: number }).used_mb, 0,
    );
    const accounted = gpu_processes.length ? processAccountedMb : serviceAccountedMb;
    const ramAccountedMb = Object.values(service_ram).reduce((a, s) => a + s.rss_mb, 0);

    // What this means for "can I start another model right now".
    const impact =
      ratio > 0.95 ? "critical" : ratio > 0.85 ? "warning" : ratio > 0.6 ? "busy" : "ok";
    const budget = unified ? "Memory" : "VRAM";
    const impact_msg =
      impact === "critical" ? `${budget} exhausted — stop a model before starting another`
      : impact === "warning" ? `Little ${budget.toLowerCase()} left — a large model will not fit`
      : impact === "busy" ? "In use — room for a small model"
      : "Plenty of headroom";

    return NextResponse.json({
      host: { id: hostProfile.id, name: hostProfile.name },
      memory_model: hostProfile.memory.kind,
      ...g,
      impact,
      impact_msg,
      host_ram: host,
      service_vram,
      gpu_processes,
      service_ram,
      ram_summary: {
        accounted_mb: ramAccountedMb,
        // Everything not held by a registered service: the desktop, browsers,
        // WSL, and the OS's own compressed-memory store. On BeTenshi that has
        // been the larger share more than once, so it is named rather than
        // silently folded into the services' total.
        unaccounted_mb: Math.max(0, Math.round(host.used_gb * 1024) - ramAccountedMb),
        unaccounted_note: unified
          ? "desktop + apps + OS cache"
          : "desktop + apps + WSL/docker + OS cache",
      },
      vram_summary: {
        accounted_mb: accounted,
        // On Windows the process performance counters normally account for the
        // whole card. Fall back to service self-reporting when unavailable.
        unaccounted_mb: Math.max(0, mem_used - accounted),
        unaccounted_note: gpu_processes.length
          ? "GPU memory not resolved to a Windows process"
          : unified
            ? "everything not self-reported by a service (Ollama does not report per-model memory)"
            : "desktop + apps + services that don't report VRAM",
      },
    });
  } catch (err) {
    // Host RAM still goes out: it does not come from the GPU tool, and a missing
    // GPU reading is no reason to blind the one budget that OOMs a box.
    return NextResponse.json(
      {
        host: { id: hostProfile.id, name: hostProfile.name },
        memory_model: hostProfile.memory.kind,
        error: `GPU probe unavailable: ${err instanceof Error ? err.message : err}`,
        host_ram: await hostMemory(),
      },
      { status: 502 },
    );
  }
}
