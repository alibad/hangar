import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import { SERVICE_REGISTRY, getServiceUrl } from "./services";
import { getFootprintsByService } from "./providers";
import type { MachineProfile, Occupant } from "./model-fit";

const execFileP = promisify(execFile);

/**
 * What this box actually is, right now — the denominator in every "will it fit"
 * question the scout asks.
 *
 * Nothing here is hardcoded on purpose. The card, its size, the host RAM and the
 * free space on the weights drive are all read live, so the fit verdicts stay
 * correct after a GPU swap, a RAM upgrade, or a disk that quietly filled up. The
 * one thing that IS configured is which drive the weights land on, because that
 * is a decision (see `_models-doc` in scripts/service-commands.json) rather than
 * something the machine can report.
 */

/**
 * Hugging Face weights are pinned to D: by HF_HOME on every service that loads
 * them. Checking C: instead would have said "260 GB free" while the drive that
 * matters was the one about to fill.
 */
const WEIGHTS_DRIVE = (process.env.WEIGHTS_DRIVE ?? "D:").toUpperCase();

let cache: { at: number; profile: MachineProfile } | null = null;
const CACHE_MS = 5000;

export async function readMachineProfile(): Promise<MachineProfile> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.profile;

  const [gpu, disk] = await Promise.all([readGpu(), readDiskFreeGb(WEIGHTS_DRIVE)]);
  const profile: MachineProfile = {
    gpuName: gpu.name,
    vramTotalGb: gpu.totalGb,
    vramFreeGb: gpu.freeGb,
    ramTotalGb: round1(os.totalmem() / 1024 ** 3),
    ramFreeGb: round1(os.freemem() / 1024 ** 3),
    weightsDiskFreeGb: disk,
    weightsDiskLabel: `${WEIGHTS_DRIVE}\\`,
  };
  cache = { at: Date.now(), profile };
  return profile;
}

async function readGpu(): Promise<{ name: string; totalGb: number; freeGb: number }> {
  try {
    const { stdout } = await execFileP(
      "nvidia-smi",
      ["--query-gpu=name,memory.total,memory.free", "--format=csv,noheader,nounits"],
      { timeout: 5000, windowsHide: true },
    );
    const [name, total, free] = stdout.trim().split("\n")[0].split(",").map((s) => s.trim());
    return {
      name: name || "GPU",
      totalGb: round1(Number(total) / 1024),
      freeGb: round1(Number(free) / 1024),
    };
  } catch {
    // No card, or no driver. Zeroes make every local candidate report "won't
    // fit", which is the correct answer on a box that cannot run one.
    return { name: "No CUDA GPU detected", totalGb: 0, freeGb: 0 };
  }
}

async function readDiskFreeGb(drive: string): Promise<number> {
  try {
    const ps = `(Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${drive}'").FreeSpace`;
    const { stdout } = await execFileP(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", ps],
      { timeout: 8000, windowsHide: true },
    );
    const bytes = Number(stdout.trim());
    return Number.isFinite(bytes) && bytes > 0 ? round1(bytes / 1024 ** 3) : 0;
  } catch {
    return 0;
  }
}

/**
 * Which local services are up and what they are holding.
 *
 * Uses the CONFIGURED footprint rather than a live reading, deliberately. A
 * live number tells you what a service is using this instant; the fit question
 * is what it will be using when the candidate model also wants memory, and for
 * Qwen-Image those differ by 20 GB (it idles near zero and peaks at 20.3). Sizing
 * a swap decision off the idle figure is how you get an OOM ten minutes later.
 */
export async function readOccupants(): Promise<Occupant[]> {
  const footprints = getFootprintsByService();
  const ids = Object.keys(footprints);

  const checks = await Promise.all(
    ids.map(async (id) => {
      const svc = SERVICE_REGISTRY.find((s) => s.id === id);
      if (!svc) return null;
      try {
        const res = await fetch(getServiceUrl(id) + svc.healthPath, {
          signal: AbortSignal.timeout(2000),
        });
        if (!res.ok) return null;
      } catch {
        return null; // not running — holds nothing
      }
      const fp = footprints[id].footprint;
      return {
        serviceId: id,
        name: svc.name,
        vramGb: fp.vramGb ?? 0,
        ramGb: fp.ramGb ?? 0,
      } satisfies Occupant;
    }),
  );

  return checks.filter((o): o is Occupant => o !== null);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
