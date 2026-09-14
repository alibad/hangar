/**
 * Host probes — the only file that shells out to platform tools.
 *
 * SERVER ONLY. Every function here runs a command or reads `os`; nothing in
 * src/components may import it. Routes call these and hand the UI plain JSON.
 *
 * Each probe has one implementation per host `gpu`/`platform`, chosen from the
 * resolved profile rather than from `process.platform`, so a profile can be
 * forced with HOST_ID for testing and the behaviour follows the profile.
 */

import { execFile } from "child_process";
import os from "os";
import { promisify } from "util";
import { getHost } from "./host";

const execFileP = promisify(execFile);

// ── memory ───────────────────────────────────────────────────────────────────

export type HostMemory = {
  total_gb: number;
  free_gb: number;
  used_gb: number;
  pct_used: number;
};

const gb = (bytes: number) => Math.round((bytes / 1024 ** 3) * 10) / 10;

/**
 * Free memory, meaning "memory a new model could take without swapping".
 *
 * On Windows `os.freemem()` is that number. On macOS it is not: Darwin reports
 * only pages that are literally free, while inactive, speculative and purgeable
 * pages are all reclaimable on demand and routinely hold tens of GB of file
 * cache. Trusting freemem() on the M5 Max read 1 GB free with 55 GB reclaimable,
 * which would have refused every model. vm_stat gives the pieces.
 */
export async function hostMemory(): Promise<HostMemory> {
  const total = os.totalmem();
  let free = os.freemem();
  if (getHost().platform === "darwin") {
    const available = await darwinAvailableBytes();
    if (available != null) free = available;
  }
  return {
    total_gb: gb(total),
    free_gb: gb(free),
    used_gb: gb(total - free),
    pct_used: total ? Math.round(((total - free) / total) * 1000) / 10 : 0,
  };
}

async function darwinAvailableBytes(): Promise<number | null> {
  try {
    const { stdout } = await execFileP("vm_stat", [], { timeout: 4000 });
    const page = Number(/page size of (\d+)/.exec(stdout)?.[1] ?? 16384);
    const pages = (label: string) =>
      Number(new RegExp(`${label}:\\s+(\\d+)`).exec(stdout)?.[1] ?? 0);
    const reclaimable =
      pages("Pages free") + pages("Pages inactive") + pages("Pages speculative") + pages("Pages purgeable");
    return reclaimable * page;
  } catch {
    return null;
  }
}

/** Synchronous best-effort free GB for callers that cannot await (rare). */
export function freeMemoryGbSync(): number {
  return gb(os.freemem());
}

// ── GPU ──────────────────────────────────────────────────────────────────────

export type GpuReading = {
  name: string;
  pstate: string | null;
  fan_speed: number | null;
  /** MB. On a unified host this IS system memory. */
  mem_total: number;
  mem_used: number;
  mem_free: number;
  gpu_util: number | null;
  mem_util: number | null;
  temperature: number | null;
  power_draw: number | null;
  power_limit: number | null;
};

const NVIDIA_FIELDS = [
  "name", "pstate", "fan.speed", "memory.total", "memory.used", "memory.free",
  "utilization.gpu", "utilization.memory", "temperature.gpu", "power.draw", "power.limit",
] as const;

const num = (v: string) => {
  const n = Number(String(v).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

/**
 * One GPU reading, from whatever this host can be asked.
 *
 * nvidia: nvidia-smi, unchanged from before hosts existed. Throws if the tool
 *         is missing so the route can report "unavailable" the way it always has.
 * apple:  no nvidia-smi and no per-process VRAM concept. Utilisation comes from
 *         IOAccelerator's PerformanceStatistics via ioreg (no sudo — powermetrics
 *         needs root). Memory is the unified pool, so the "VRAM" numbers are the
 *         host's, and temperature/power are null rather than guessed.
 */
export async function gpuReading(): Promise<GpuReading> {
  const host = getHost();
  if (host.gpu === "nvidia") return nvidiaSmi();
  if (host.gpu === "apple") return appleGpu();
  throw new Error(`no GPU probe for host "${host.id}" (gpu: ${host.gpu})`);
}

async function nvidiaSmi(): Promise<GpuReading> {
  const { stdout } = await execFileP(
    "nvidia-smi",
    [`--query-gpu=${NVIDIA_FIELDS.join(",")}`, "--format=csv,noheader,nounits"],
    { timeout: 10000 },
  );
  const row = stdout.trim().split("\n")[0]?.split(",").map((s) => s.trim()) ?? [];
  if (row.length < NVIDIA_FIELDS.length) throw new Error("unexpected nvidia-smi output");
  const [name, pstate, fan, memTotal, memUsed, memFree, gpuUtil, memUtil, temp, pDraw, pLimit] = row;
  return {
    name,
    pstate,
    fan_speed: fan === "[N/A]" ? null : num(fan),
    mem_total: num(memTotal),
    mem_used: num(memUsed),
    mem_free: num(memFree),
    gpu_util: num(gpuUtil),
    mem_util: num(memUtil),
    temperature: num(temp),
    power_draw: num(pDraw),
    power_limit: num(pLimit),
  };
}

async function appleGpu(): Promise<GpuReading> {
  const [mem, chip, util] = await Promise.all([hostMemory(), appleChipName(), appleGpuUtil()]);
  const mb = (g: number) => Math.round(g * 1024);
  return {
    name: chip,
    pstate: null,
    fan_speed: null,
    mem_total: mb(mem.total_gb),
    mem_used: mb(mem.used_gb),
    mem_free: mb(mem.free_gb),
    gpu_util: util,
    mem_util: null,
    temperature: null,
    power_draw: null,
    power_limit: null,
  };
}

async function appleChipName(): Promise<string> {
  try {
    const { stdout } = await execFileP("sysctl", ["-n", "machdep.cpu.brand_string"], { timeout: 3000 });
    return stdout.trim() || "Apple Silicon";
  } catch {
    return "Apple Silicon";
  }
}

/** "Device Utilization %" from the accelerator's own counters. */
async function appleGpuUtil(): Promise<number | null> {
  try {
    const { stdout } = await execFileP("ioreg", ["-r", "-d", "1", "-c", "IOAccelerator"], {
      timeout: 4000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const m = /"Device Utilization %"=(\d+)/.exec(stdout);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

// ── listeners: port → pid → resident memory ──────────────────────────────────

export type Listener = { port: number; pid: number; rss: number };

/**
 * Every listening TCP port with the owning pid and its resident set, in bytes.
 *
 * Resident, not committed: committed memory counts mapped files and pagefile
 * reservations, which is why Qwen-Image reads 89 GB "private" on a 63 GB box.
 * Only the resident figure competes for physical RAM.
 *
 * win32:  one PowerShell call (Get-NetTCPConnection joined to Get-Process).
 * darwin: lsof for the listener table, then one `ps` for all the pids at once.
 */
export async function listeners(): Promise<Listener[]> {
  const host = getHost();
  if (host.platform === "win32") return win32Listeners();
  return posixListeners();
}

async function win32Listeners(): Promise<Listener[]> {
  const ps = [
    "$ErrorActionPreference='SilentlyContinue';",
    "Get-NetTCPConnection -State Listen |",
    "Select-Object -Property LocalPort,OwningProcess -Unique |",
    "ForEach-Object { $p = Get-Process -Id $_.OwningProcess;",
    "  if ($p) { [pscustomobject]@{ port=$_.LocalPort; pid=$_.OwningProcess; rss=$p.WorkingSet64 } } } |",
    "ConvertTo-Json -Compress",
  ].join(" ");
  try {
    const { stdout } = await execFileP("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
      timeout: 10000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout.trim() || "[]");
    const rows: { port: number; pid: number; rss: number }[] = Array.isArray(parsed) ? parsed : [parsed];
    return rows.map((r) => ({ port: Number(r.port), pid: Number(r.pid), rss: Number(r.rss) }));
  } catch {
    return []; // no listener table — better to show nothing than to guess
  }
}

async function posixListeners(): Promise<Listener[]> {
  let table = "";
  try {
    // -F gives one field per line with a type prefix: p<pid>, n<name>. Far
    // easier to parse reliably than the human table.
    const { stdout } = await execFileP("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pn"], {
      timeout: 6000,
      maxBuffer: 4 * 1024 * 1024,
    });
    table = stdout;
  } catch (e) {
    // lsof exits 1 when there are simply no listeners; anything with output is fine.
    const err = e as { stdout?: string };
    if (!err.stdout) return [];
    table = err.stdout;
  }
  const byPort = new Map<number, number>();
  let pid = 0;
  for (const line of table.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n")) {
      const port = Number(/:(\d+)$/.exec(line)?.[1]);
      if (port && pid && !byPort.has(port)) byPort.set(port, pid);
    }
  }
  const pids = [...new Set(byPort.values())];
  if (!pids.length) return [];
  const rss = new Map<number, number>();
  try {
    const { stdout } = await execFileP("ps", ["-o", "pid=,rss=", "-p", pids.join(",")], { timeout: 4000 });
    for (const line of stdout.split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)/.exec(line);
      if (m) rss.set(Number(m[1]), Number(m[2]) * 1024); // ps reports KB
    }
  } catch {
    /* rss stays unknown → 0 */
  }
  return [...byPort.entries()].map(([port, p]) => ({ port, pid: p, rss: rss.get(p) ?? 0 }));
}

/** vmmemWSL holds every container's memory as one Windows process. 0 elsewhere. */
export async function dockerHostRamMb(): Promise<number> {
  if (getHost().platform !== "win32") return 0;
  try {
    const { stdout } = await execFileP(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command",
       "(Get-Process -Name 'vmmem*' -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum).Sum"],
      { timeout: 8000, windowsHide: true },
    );
    const bytes = Number(stdout.trim());
    return Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes / 1024 ** 2) : 0;
  } catch {
    return 0;
  }
}
