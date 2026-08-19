import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { SERVICE_REGISTRY, getServiceUrl } from "./services";
import { getFootprintsByService } from "./providers";
import { discoverDrives, type StorageDrive } from "./storage-index";
import { installedRepos } from "./hf-download";
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
 * them (see `_models-doc` in scripts/service-commands.json). Checking C: instead
 * would have said "260 GB free" while the drive that matters was the one about
 * to fill.
 */
const WEIGHTS_DRIVE = (process.env.WEIGHTS_DRIVE ?? "D:").toUpperCase();
/** The HF_HOME every service is given. Used to size what is already downloaded. */
const WEIGHTS_PATH = process.env.HF_HOME ?? `${WEIGHTS_DRIVE}\\AI Models\\huggingface`;

let cache: { at: number; profile: MachineProfile } | null = null;
const CACHE_MS = 5000;

export async function readMachineProfile(): Promise<MachineProfile> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.profile;

  const [gpu, disk] = await Promise.all([readGpu(), readWeightsDrive()]);
  const profile: MachineProfile = {
    gpuName: gpu.name,
    vramTotalGb: gpu.totalGb,
    vramFreeGb: gpu.freeGb,
    ramTotalGb: round1(os.totalmem() / 1024 ** 3),
    ramFreeGb: round1(os.freemem() / 1024 ** 3),
    ...disk,
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

/**
 * The weights drive, read through the STORAGE MODULE rather than a private
 * probe of its own.
 *
 * This module used to shell out to Win32_LogicalDisk itself, which answered
 * "how many bytes are free" and nothing else. The console already has a storage
 * index that has walked these drives — it knows that D: holds 189 GB of Hugging
 * Face weights under `D:\AI Models\huggingface`, and which folders they are. A
 * "won't fit, no disk" verdict is far more useful when the same surface can say
 * what is already down there taking up the room.
 *
 * Two failure modes are kept distinct on purpose: a drive the indexer has never
 * scanned reports `weightsIndexed: false` and NO usage figure, rather than 0 GB.
 * Zero would read as "nothing downloaded yet", which is the opposite of unknown.
 */
async function readWeightsDrive(): Promise<
  Pick<
    MachineProfile,
    | "weightsDiskFreeGb"
    | "weightsDiskLabel"
    | "weightsDiskTotalGb"
    | "weightsUsedGb"
    | "weightsPath"
    | "weightsIndexed"
  >
> {
  const root = `${WEIGHTS_DRIVE}\\`;
  const base = {
    weightsDiskFreeGb: 0,
    weightsDiskLabel: root,
    weightsPath: WEIGHTS_PATH,
    weightsIndexed: false,
  };

  let drive: StorageDrive | undefined;
  try {
    const drives = await discoverDrives();
    drive = drives.find((d) => d.root.toUpperCase() === root.toUpperCase());
  } catch {
    // The storage index is optional infrastructure; the fit verdicts are not.
    return { ...base, ...(await fallbackFreeGb()) };
  }
  if (!drive) return { ...base, ...(await fallbackFreeGb()) };

  const out = {
    ...base,
    weightsDiskFreeGb: round1(drive.freeBytes / 1024 ** 3),
    weightsDiskLabel: `${drive.root} (${drive.label})`,
    weightsDiskTotalGb: round1(drive.totalBytes / 1024 ** 3),
    weightsIndexed: drive.status === "ready",
  };
  // The Hugging Face cache, summed from the filesystem RIGHT NOW. Preferred over
  // the storage index's figure for this one number: the index reports its last
  // scan, so a model downloaded five minutes ago left "189.4 GB of weights"
  // unchanged while the free-space figure beside it moved — two numbers about
  // the same event disagreeing on screen.
  try {
    const live = installedRepos().reduce((a, r) => a + r.bytes, 0);
    if (live > 0) return { ...out, weightsUsedGb: round1(live / 1024 ** 3) };
  } catch {
    /* fall through to the index */
  }

  if (drive.status !== "ready") return out;

  try {
    const used = await folderBytes(WEIGHTS_PATH);
    return used == null ? out : { ...out, weightsUsedGb: round1(used / 1024 ** 3) };
  } catch {
    return out;
  }
}

/** Size of one indexed folder, straight from the storage index's own database. */
async function folderBytes(target: string): Promise<number | null> {
  const { browseStorage } = await import("./storage-index");
  const parent = path.win32.dirname(target);
  const listing = await browseStorage(parent);
  const name = path.win32.basename(target).toLowerCase();
  const hit = listing.items?.find(
    (i) => i.kind === "folder" && i.name.toLowerCase() === name,
  );
  return hit ? hit.size : null;
}

/**
 * Free space without the storage index. Kept because a fit verdict that silently
 * assumed a full disk would refuse every local candidate on a box where the
 * indexer simply has not been set up.
 */
async function fallbackFreeGb(): Promise<{ weightsDiskFreeGb: number }> {
  try {
    const ps = `(Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${WEIGHTS_DRIVE}'").FreeSpace`;
    const { stdout } = await execFileP(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", ps],
      { timeout: 8000, windowsHide: true },
    );
    const bytes = Number(stdout.trim());
    return { weightsDiskFreeGb: Number.isFinite(bytes) && bytes > 0 ? round1(bytes / 1024 ** 3) : 0 };
  } catch {
    return { weightsDiskFreeGb: 0 };
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
