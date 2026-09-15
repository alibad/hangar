import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { SERVICE_REGISTRY, getServiceUrl } from "./services";
import { gpuReading, hostMemory } from "./sysinfo";
import { getHost } from "./host";
import { getFootprintsByService } from "./providers";
import { discoverDrives, type StorageDrive } from "./storage-index";
import { installedRepos, weightsHome } from "./hf-download";
import type { MachineProfile, Occupant, Runtime } from "./model-fit";

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
const WEIGHTS_PATH = weightsHome();

let cache: { at: number; profile: MachineProfile } | null = null;
const CACHE_MS = 5000;

export async function readMachineProfile(): Promise<MachineProfile> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.profile;

  const host = getHost();
  const [gpu, ram, disk] = await Promise.all([readGpu(), hostMemory(), readWeightsDrive()]);
  const profile: MachineProfile = {
    gpuName: gpu.name,
    // Not just how much, but of what KIND. Three of the fit engine's
    // assumptions — separate memory budgets, NVFP4 on the ladder, a diffusion
    // model paying for CPU offload — are true of a discrete CUDA card and false
    // of unified Metal, so evaluateFit() has to be told which machine it is
    // answering for. Taken from the host profile rather than process.platform,
    // per the rule in host.ts.
    runtime: RUNTIME_BY_GPU[host.gpu],
    memoryModel: host.memory.kind,
    computeCapability: await computeCapability(),
    vramTotalGb: gpu.totalGb,
    vramFreeGb: gpu.freeGb,
    // Through the host probe, not os.freemem(): on macOS that reports only
    // literally-free pages and ignores tens of GB of reclaimable cache.
    ramTotalGb: ram.total_gb,
    ramFreeGb: ram.free_gb,
    ...disk,
  };
  cache = { at: Date.now(), profile };
  return profile;
}

const RUNTIME_BY_GPU: Record<"nvidia" | "apple" | "none", Runtime> = {
  nvidia: "cuda",
  apple: "metal",
  none: "cpu",
};

/**
 * CUDA compute capability, e.g. "12.0" for sm_120.
 *
 * Only NVFP4 depends on it — it is hardware on Blackwell and absent below — so
 * this is asked once and kept: silicon does not change between reads. Kept out
 * of sysinfo.gpuReading() on purpose, because that query is on the hot path for
 * the GPU meter and older drivers reject unknown fields by failing the WHOLE
 * query, which would cost the memory figures to learn one string.
 */
let capability: { value: string | undefined } | null = null;
async function computeCapability(): Promise<string | undefined> {
  if (capability) return capability.value;
  capability = { value: undefined };
  if (getHost().gpu === "nvidia") {
    try {
      const { stdout } = await execFileP(
        "nvidia-smi",
        ["--query-gpu=compute_cap", "--format=csv,noheader,nounits"],
        { timeout: 5000, windowsHide: true },
      );
      capability = { value: stdout.trim().split("\n")[0].trim() || undefined };
    } catch {
      // Older driver, or no card. precisionLadderFor() keeps NVFP4 when the
      // capability is unknown on CUDA, which is right for this box.
    }
  }
  return capability.value;
}

/**
 * Whatever GPU this host has, through the host profile's probe: nvidia-smi on
 * BeTenshi, the unified pool on Apple silicon. This used to call nvidia-smi
 * directly, which on a Mac answered "No CUDA GPU detected, 0 GB" and made the
 * scout mark every local model as not fitting on a box with 128 GB to spare.
 */
async function readGpu(): Promise<{ name: string; totalGb: number; freeGb: number }> {
  try {
    const g = await gpuReading();
    return {
      name: g.name || "GPU",
      totalGb: round1(g.mem_total / 1024),
      freeGb: round1(g.mem_free / 1024),
    };
  } catch {
    // No card, or no driver. Zeroes make every local candidate report "won't
    // fit", which is the correct answer on a box that cannot run one.
    return { name: "No GPU detected", totalGb: 0, freeGb: 0 };
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
  // The storage index is a Windows component: it enumerates Win32_LogicalDisk
  // and normalises every path with path.win32, which throws on a POSIX path. A
  // host without drive letters reads its volume directly instead — the same
  // free-space number, without the "what else is down there" breakdown that
  // only the index can give.
  if (getHost().platform !== "win32") {
    const live = installedReposGb();
    return {
      weightsDiskFreeGb: await freeGbAt(WEIGHTS_PATH),
      weightsDiskLabel: volumeLabel(WEIGHTS_PATH),
      weightsPath: WEIGHTS_PATH,
      // Honestly false: no index has walked this volume. The cache size below
      // does not need one — it is summed from the filesystem — and is omitted
      // entirely when that read fails, because 0 GB would read as "nothing
      // downloaded yet", which is the opposite of unknown.
      weightsIndexed: false,
      ...(live == null ? {} : { weightsUsedGb: live }),
    };
  }

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
  const live = installedReposGb();
  if (live != null) return { ...out, weightsUsedGb: live };

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
  return { weightsDiskFreeGb: await freeGbAt(`${WEIGHTS_DRIVE}\\`) };
}

/**
 * Free bytes on the volume holding `target`, as GB. 0 when it cannot be read.
 *
 * statfs rather than the PowerShell Win32_LogicalDisk query this used to run:
 * the same number, correct on every host, and no shell spawned to read one
 * integer.
 */
async function freeGbAt(target: string): Promise<number> {
  for (const probe of [target, path.dirname(target)]) {
    try {
      const st = await fs.promises.statfs(probe);
      // bavail, not bfree: blocks free to an unprivileged writer, which is what
      // a download actually gets.
      return round1((st.bavail * st.bsize) / 1024 ** 3);
    } catch {
      // The weights directory may not exist yet on a fresh machine; try its
      // parent before giving up.
    }
  }
  return 0;
}

/**
 * The Hugging Face cache, summed from the filesystem RIGHT NOW.
 *
 * Returns null rather than 0 when it cannot be read, so the caller can tell
 * "nothing downloaded" from "could not look" — the distinction weightsIndexed
 * draws about the storage index, applied to the one number it does not need.
 */
function installedReposGb(): number | null {
  try {
    const bytes = installedRepos().reduce((a, r) => a + r.bytes, 0);
    return bytes > 0 ? round1(bytes / 1024 ** 3) : null;
  } catch {
    return null;
  }
}

/** A human label for a POSIX volume: "/Volumes/Weights", or just "/". */
function volumeLabel(target: string): string {
  const m = /^(\/Volumes\/[^/]+)/.exec(target);
  return m ? m[1] : "/";
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
