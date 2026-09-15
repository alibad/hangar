import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { SERVICE_REGISTRY, getServiceUrl } from "./services";
import { getFootprintsByService } from "./providers";
import { discoverDrives, type StorageDrive } from "./storage-index";
import { installedRepos, weightsHome } from "./hf-download";
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
 *
 * ── Two machines ────────────────────────────────────────────────────────────
 * This console runs on both a Windows box with a discrete RTX 5090 and an Apple
 * silicon machine. It used to detect only the first: readGpu() shelled to
 * nvidia-smi, and the macOS failure returned zeroes with a comment claiming
 * that was "the correct answer on a box that cannot run one". It is the correct
 * answer for a machine with no GPU. It is the wrong answer for one with a very
 * capable GPU that nvidia-smi structurally cannot see, and it made the Models
 * page report every local model as "won't fit".
 *
 * So the platform is detected rather than assumed, and what comes back says
 * which RUNTIME the GPU speaks and whether its memory is its own or the host's
 * — two facts that change the fit arithmetic, not just the numbers going into
 * it. See the machine notes at the top of model-fit.ts.
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

const IS_MAC = process.platform === "darwin";

let cache: { at: number; profile: MachineProfile } | null = null;
const CACHE_MS = 5000;

export async function readMachineProfile(): Promise<MachineProfile> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.profile;

  const [gpu, disk] = await Promise.all([readGpu(), readWeightsDrive()]);
  const profile: MachineProfile = {
    ...gpu,
    ramTotalGb: round1(os.totalmem() / 1024 ** 3),
    // On macOS os.freemem() counts only genuinely free pages and excludes the
    // large purgeable/cached pool, so it understates what is available — often
    // badly. Left uncorrected on purpose: it errs toward reporting the machine
    // as busier than it is, which produces a "needs a swap" rather than an OOM.
    ramFreeGb: round1(os.freemem() / 1024 ** 3),
    ...disk,
  };
  cache = { at: Date.now(), profile };
  return profile;
}

type GpuFacts = Pick<
  MachineProfile,
  "gpuName" | "runtime" | "memoryModel" | "computeCapability" | "vramTotalGb" | "vramFreeGb" | "vramBasis"
>;

async function readGpu(): Promise<GpuFacts> {
  return IS_MAC ? readAppleGpu() : readNvidiaGpu();
}

async function readNvidiaGpu(): Promise<GpuFacts> {
  try {
    // compute_cap in the same query when the driver supports it: NVFP4 is a
    // hardware rung on sm_120 and absent below it, so the ladder needs to know.
    // Older drivers reject the field and fail the WHOLE query, which would cost
    // us the memory figures too — hence the retry without it.
    let fields = "name,memory.total,memory.free,compute_cap";
    let stdout: string;
    try {
      ({ stdout } = await smi(fields));
    } catch {
      fields = "name,memory.total,memory.free";
      ({ stdout } = await smi(fields));
    }
    const [name, total, free, cap] = stdout.trim().split("\n")[0].split(",").map((s) => s.trim());
    return {
      gpuName: name || "GPU",
      runtime: "cuda",
      memoryModel: "discrete",
      computeCapability: cap || undefined,
      vramTotalGb: round1(Number(total) / 1024),
      vramFreeGb: round1(Number(free) / 1024),
      vramBasis: "Reported by the driver via nvidia-smi.",
    };
  } catch {
    // No card, no driver, and not a Mac. Zeroes make every local candidate
    // report "won't fit", which is the correct answer on a box that genuinely
    // cannot run one.
    return {
      gpuName: "No CUDA GPU detected",
      runtime: "cpu",
      memoryModel: "discrete",
      vramTotalGb: 0,
      vramFreeGb: 0,
      vramBasis: "No GPU found — nvidia-smi is absent or reported nothing.",
    };
  }
}

function smi(fields: string) {
  return execFileP("nvidia-smi", [`--query-gpu=${fields}`, "--format=csv,noheader,nounits"], {
    timeout: 5000,
    windowsHide: true,
  });
}

/**
 * Apple silicon, where "how much VRAM" has no physical answer.
 *
 * The GPU addresses the same DRAM as the CPU, so the only ceiling is a policy
 * one: macOS caps how much of the pool the GPU may wire. That cap is readable
 * when someone has pinned it (`sysctl iogpu.wired_limit_mb`) and otherwise
 * implicit, which is precisely the kind of number this codebase refuses to
 * print without saying where it came from — hence vramBasis.
 */
async function readAppleGpu(): Promise<GpuFacts> {
  const totalBytes = Number(await sysctl("hw.memsize")) || os.totalmem();
  const totalGb = round1(totalBytes / 1024 ** 3);
  const chip = (await sysctl("machdep.cpu.brand_string")) || "Apple silicon";

  const pinnedMb = Number(await sysctl("iogpu.wired_limit_mb"));
  const pinned = Number.isFinite(pinnedMb) && pinnedMb > 0;

  // 0 means "OS default", which Metal reports through
  // recommendedMaxWorkingSetSize at roughly 75% of system memory. We do not
  // read Metal from Node, so this is a documented approximation and is labelled
  // as one rather than presented as a measurement.
  const wirableGb = pinned ? round1(pinnedMb / 1024) : round1(totalGb * 0.75);

  return {
    gpuName: `${chip} (integrated GPU)`,
    runtime: "metal",
    memoryModel: "unified",
    vramTotalGb: wirableGb,
    // There is no separate free-VRAM counter to read: free pool is free GPU
    // memory. The unified branch of evaluateFit budgets against ramFreeGb and
    // uses this only as the wiring ceiling.
    vramFreeGb: wirableGb,
    vramBasis: pinned
      ? `iogpu.wired_limit_mb is pinned to ${pinnedMb} MB of the ${fmtGbShort(totalGb)} shared pool.`
      : `Not measured: macOS default, taken as 75% of the ${fmtGbShort(totalGb)} shared pool (Metal's recommendedMaxWorkingSetSize). Pin iogpu.wired_limit_mb to make this exact.`,
  };
}

async function sysctl(key: string): Promise<string> {
  try {
    const { stdout } = await execFileP("sysctl", ["-n", key], { timeout: 5000 });
    return stdout.trim();
  } catch {
    return "";
  }
}

function fmtGbShort(gb: number): string {
  return `${Math.round(gb)} GB`;
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
  // The storage index is a Windows component (it enumerates Win32_LogicalDisk
  // and normalises with path.win32). On macOS there are no drive letters and
  // no index, so the volume holding the weights is read directly — which is
  // not a degraded path: statfs is the same number the index would report,
  // just without the "what else is down there" breakdown.
  if (IS_MAC) {
    const live = installedReposGb();
    return {
      weightsDiskFreeGb: await freeGbAt(WEIGHTS_PATH),
      weightsDiskLabel: volumeLabel(WEIGHTS_PATH),
      weightsPath: WEIGHTS_PATH,
      // No storage index here, so no "what else is on this volume" breakdown —
      // which is what weightsIndexed reports, and it is honestly false.
      weightsIndexed: false,
      // The cache size itself does not need the index: it is summed from the
      // filesystem. Omitted entirely when that read fails, because 0 GB would
      // read as "nothing downloaded yet", which is the opposite of unknown.
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
 *
 * statfs rather than the PowerShell query this used to run: it is the same
 * number, it works on both machines, and it does not spawn a shell to read one
 * integer.
 */
async function fallbackFreeGb(): Promise<{ weightsDiskFreeGb: number }> {
  return { weightsDiskFreeGb: await freeGbAt(`${WEIGHTS_DRIVE}\\`) };
}

/** Free bytes on the volume holding `target`, as GB. 0 when it cannot be read. */
async function freeGbAt(target: string): Promise<number> {
  for (const probe of [target, path.dirname(target)]) {
    try {
      const st = await fs.promises.statfs(probe);
      // bavail, not bfree: blocks free to an unprivileged writer, which is what
      // a download actually gets.
      return round1((st.bavail * st.bsize) / 1024 ** 3);
    } catch {
      // The weights directory may not exist yet on a fresh machine; fall back
      // to its parent before giving up.
    }
  }
  return 0;
}

/**
 * The Hugging Face cache, summed from the filesystem RIGHT NOW.
 *
 * Returns null rather than 0 when it cannot be read, so the caller can tell
 * "nothing downloaded" from "could not look" — the same distinction
 * weightsIndexed draws about the storage index.
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
