import fs from "fs";
import os from "os";
import path from "path";
import { spawn, execFile } from "child_process";
import { promisify } from "util";

const execFileP = promisify(execFile);

/**
 * Downloading open weights, from the same page that decided they would fit.
 *
 * The Models page could tell you a 27B runs on this card and then leave you to
 * go find the repo yourself — which is where the decision actually gets lost,
 * because llm-stats ids ("qwen3.8-27b") are not Hugging Face repo ids
 * ("Qwen/Qwen3.8-27B") and the useful variant is usually a sibling repo (-FP8,
 * -AWQ, -GGUF) rather than the headline one.
 *
 * So this module does three things: resolve a name to a real repo, price the
 * download in bytes BEFORE it starts, and run it somewhere it can survive a dev
 * server reload.
 */

const HF_BIN =
  process.env.HF_CLI ??
  (process.platform === "win32"
    ? "C:\\Users\\Admin\\AppData\\Local\\Programs\\Python\\Python312\\Scripts\\hf.exe"
    : "hf");

/**
 * Where weights live, which is not the same answer on both machines this
 * console runs on.
 *
 * On the Windows box it is a pinned second drive, because the boot drive would
 * have filled. On macOS there are no drive letters and the Hub's own default is
 * right, so following it means the console and every other tool that reads
 * HF_HOME agree without configuration. Hardcoding the Windows path here made
 * the Mac report an empty cache and 0 GB of weights.
 */
export function weightsHome(): string {
  if (process.env.HF_HOME) return process.env.HF_HOME;
  if (process.platform === "win32") {
    const drive = (process.env.WEIGHTS_DRIVE ?? "D:").toUpperCase();
    return `${drive}\\AI Models\\huggingface`;
  }
  return path.join(os.homedir(), ".cache", "huggingface");
}

const HF_HOME = weightsHome();
const STATE_DIR = path.join(process.cwd(), "var", "downloads");
const STATE_FILE = path.join(STATE_DIR, "state.json");

export type RepoVariant = {
  repo: string;
  /** Total bytes of the repo, from the Hub's own accounting. */
  bytes: number;
  gb: number;
  downloads: number;
  likes: number;
  gated: boolean;
  /** Quantisation read off the repo name — the reason to prefer a sibling. */
  quant?: string;
  /** Already present under HF_HOME. */
  installed: boolean;
};

export type RepoResolution = {
  query: string;
  /** Best guess at the canonical repo. */
  primary?: RepoVariant;
  /** Siblings worth considering, smallest first — usually quantisations. */
  variants: RepoVariant[];
  error?: string;
};

/**
 * Quantisation implied by a repo name.
 *
 * Naming is convention, not standard, so this is a hint for sorting and a label
 * for the UI — never something the fit arithmetic consumes. The size in bytes
 * comes from the Hub and is a fact; this is just what the author called it.
 */
function quantOf(repo: string): string | undefined {
  const s = repo.toLowerCase();
  if (/nvfp4/.test(s)) return "NVFP4";
  if (/[-_]fp8\b|[-_]fp8$/.test(s)) return "FP8";
  if (/awq/.test(s)) return "AWQ 4-bit";
  if (/gptq/.test(s)) return "GPTQ";
  if (/gguf/.test(s)) return "GGUF";
  if (/[-_]int4|[-_]4bit/.test(s)) return "4-bit";
  if (/[-_]int8|[-_]8bit/.test(s)) return "8-bit";
  if (/mlx/.test(s)) return "MLX";  // Apple silicon — listed so it can be avoided
  return undefined;
}

/** Where a repo's snapshot lands under HF_HOME, per the Hub's cache layout. */
function repoCacheDir(repo: string): string {
  return path.join(HF_HOME, "hub", `models--${repo.replace(/\//g, "--")}`);
}

export function isInstalled(repo: string): boolean {
  try {
    // A `snapshots` directory with something in it. The bare folder gets created
    // by a metadata call, so its existence alone does not mean weights are here.
    const snaps = path.join(repoCacheDir(repo), "snapshots");
    return fs.existsSync(snaps) && fs.readdirSync(snaps).length > 0;
  } catch {
    return false;
  }
}

export type InstalledRepo = { repo: string; bytes: number };

/**
 * Bytes on disk under a directory, counting each file exactly once.
 *
 * `lstat`, not `stat`, and symlinks are skipped rather than followed — that is
 * what makes this correct for BOTH Hub cache layouts. The documented layout puts
 * real files in `blobs/` and symlinks in `snapshots/`; on Windows without
 * developer mode the CLI copies instead, leaving real files in `snapshots/` and
 * `blobs/` nearly empty. Summing only `blobs/` reported 5.4 GB for a cache that
 * actually held 189 GB. Following symlinks would double-count the other layout.
 */
function dirBytes(root: string): number {
  let total = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) {
        try {
          total += fs.lstatSync(full).size;
        } catch {
          /* a file mid-download can vanish between readdir and lstat */
        }
      }
      // e.isSymbolicLink() falls through deliberately: its target is a blob
      // already counted elsewhere in this same walk.
    }
  }
  return total;
}

/**
 * What is actually on disk under HF_HOME, read from the Hub's cache layout.
 *
 * The definitive answer to "do I already have this", and the only one that does
 * not need a network call per model. Matching a leaderboard row against a repo
 * NAME is guesswork; matching it against the list of directories that exist is
 * not. Sizes are summed from the blobs directory, where the real bytes live —
 * snapshots are symlinks into it, so walking those would double-count.
 */
export function installedRepos(): InstalledRepo[] {
  const hub = path.join(HF_HOME, "hub");
  let entries: string[];
  try {
    entries = fs.readdirSync(hub);
  } catch {
    return [];
  }
  const out: InstalledRepo[] = [];
  for (const dir of entries) {
    if (!dir.startsWith("models--")) continue;
    const repo = dir.slice("models--".length).replace(/--/g, "/");
    if (!isInstalled(repo)) continue;
    out.push({ repo, bytes: dirBytes(path.join(hub, dir)) });
  }
  return out.sort((a, b) => b.bytes - a.bytes);
}

const resolveCache = new Map<string, { at: number; value: RepoResolution }>();
const RESOLVE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Name → Hub repo, with its real size and its quantised siblings.
 *
 * Ranked by downloads rather than by string similarity: for any given model the
 * canonical repo is overwhelmingly the most-pulled one, while string similarity
 * happily picks somebody's fine-tune because the name is longer. An exact
 * case-insensitive match on the repo's own name still wins outright.
 */
export async function resolveRepo(query: string): Promise<RepoResolution> {
  const key = query.toLowerCase();
  const hit = resolveCache.get(key);
  if (hit && Date.now() - hit.at < RESOLVE_TTL_MS) return hit.value;

  try {
    const res = await fetch(
      `https://huggingface.co/api/models?search=${encodeURIComponent(query)}&limit=20&sort=downloads&direction=-1`,
      { signal: AbortSignal.timeout(15_000) },
    );
    if (!res.ok) throw new Error(`Hub search returned ${res.status}`);
    const rows = (await res.json()) as { id: string; downloads?: number; likes?: number; gated?: unknown }[];
    if (!rows.length) {
      const value = { query, variants: [], error: `No Hugging Face repo matches "${query}".` };
      resolveCache.set(key, { at: Date.now(), value });
      return value;
    }

    // Size needs a per-repo call, so only ask about plausible candidates.
    const shortlist = rows.slice(0, 8);
    const detailed = await Promise.all(
      shortlist.map(async (r) => {
        let bytes = 0;
        try {
          const d = await fetch(`https://huggingface.co/api/models/${r.id}`, {
            signal: AbortSignal.timeout(12_000),
          });
          if (d.ok) bytes = Number((await d.json())?.usedStorage ?? 0) || 0;
        } catch {
          /* size unknown — reported as 0 and shown as "—" rather than guessed */
        }
        return {
          repo: r.id,
          bytes,
          gb: Math.round((bytes / 1024 ** 3) * 10) / 10,
          downloads: Number(r.downloads ?? 0),
          likes: Number(r.likes ?? 0),
          gated: r.gated !== false && r.gated != null,
          quant: quantOf(r.id),
          installed: isInstalled(r.id),
        } satisfies RepoVariant;
      }),
    );

    const exact = detailed.find((v) => v.repo.split("/").pop()?.toLowerCase() === key);
    const primary = exact ?? [...detailed].sort((a, b) => b.downloads - a.downloads)[0];
    const variants = detailed
      .filter((v) => v.repo !== primary?.repo)
      .sort((a, b) => (a.bytes || Infinity) - (b.bytes || Infinity));

    const value: RepoResolution = { query, primary, variants };
    resolveCache.set(key, { at: Date.now(), value });
    return value;
  } catch (e) {
    return { query, variants: [], error: e instanceof Error ? e.message : String(e) };
  }
}

// ── running downloads ───────────────────────────────────────────────────────

export type DownloadJob = {
  repo: string;
  pid: number;
  startedAt: string;
  logPath: string;
  status: "running" | "done" | "failed";
  /** 0-100 when the CLI has reported one. */
  percent?: number;
  /** Last meaningful line of output, for the UI to show verbatim. */
  detail?: string;
  finishedAt?: string;
};

function readState(): DownloadJob[] {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as DownloadJob[];
  } catch {
    return [];
  }
}

function writeState(jobs: DownloadJob[]): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(jobs, null, 2));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Progress, scraped from the CLI's own output.
 *
 * `hf download` renders progress bars with carriage returns rather than
 * newlines, so the log is one enormous line; splitting on \r is what makes the
 * tail readable. Only the last percentage is used — the bars interleave across
 * concurrent files and any earlier one is stale.
 */
function progressFrom(logPath: string): { percent?: number; detail?: string } {
  try {
    const buf = fs.readFileSync(logPath, "utf8");
    const tail = buf.slice(-8000).split(/[\r\n]+/).filter((l) => l.trim());
    const detail = tail.at(-1)?.trim().slice(0, 200);
    let percent: number | undefined;
    for (let i = tail.length - 1; i >= 0 && percent === undefined; i--) {
      const m = tail[i].match(/(\d{1,3})%/);
      if (m) percent = Math.min(100, Number(m[1]));
    }
    return { percent, detail };
  } catch {
    return {};
  }
}

/** Every job, with live status refreshed from the OS and the log. */
export function listDownloads(): DownloadJob[] {
  const jobs = readState();
  let changed = false;
  for (const j of jobs) {
    if (j.status === "running") {
      const { percent, detail } = progressFrom(j.logPath);
      j.percent = percent;
      j.detail = detail;
      if (!alive(j.pid)) {
        // The CLI is gone. Whether that was success is decided by the cache, not
        // by the exit code — a detached process's status is not ours to read,
        // and "are the weights on disk" is the question that actually matters.
        j.status = isInstalled(j.repo) ? "done" : "failed";
        j.finishedAt = new Date().toISOString();
        if (j.status === "done") j.percent = 100;
        changed = true;
      }
    }
  }
  if (changed) writeState(jobs);
  return jobs;
}

export class DownloadError extends Error {}

const REPO_RE = /^[A-Za-z0-9][\w.-]*\/[\w.-]+$/;

/**
 * Start a download, detached.
 *
 * Detached because these run for tens of minutes and the console is a dev server
 * that reloads whenever a file is saved — a child tied to this process would die
 * halfway through a 55 GB pull and leave a half-populated cache. The pid goes to
 * disk so a reloaded server can pick the job back up.
 */
export function startDownload(repo: string): DownloadJob {
  if (!REPO_RE.test(repo)) {
    throw new DownloadError(`"${repo}" is not a Hugging Face repo id (expected "owner/name").`);
  }
  const jobs = listDownloads();
  const running = jobs.find((j) => j.repo === repo && j.status === "running");
  if (running) return running;
  if (isInstalled(repo)) {
    throw new DownloadError(`${repo} is already downloaded.`);
  }
  if (!fs.existsSync(HF_BIN)) {
    throw new DownloadError(
      `The Hugging Face CLI was not found at ${HF_BIN}. Set HF_CLI, or run: hf download ${repo}`,
    );
  }

  fs.mkdirSync(STATE_DIR, { recursive: true });
  const logPath = path.join(STATE_DIR, `${repo.replace(/[^\w.-]/g, "_")}.log`);
  const out = fs.openSync(logPath, "w");

  const child = spawn(HF_BIN, ["download", repo], {
    // HF_HOME rather than --cache-dir: it is what every service in
    // scripts/service-commands.json is given, so the weights land exactly where
    // the thing that will load them expects to find them.
    env: { ...process.env, HF_HOME, HF_HUB_DISABLE_TELEMETRY: "1" },
    detached: true,
    windowsHide: true,
    stdio: ["ignore", out, out],
  });
  child.unref();

  const job: DownloadJob = {
    repo,
    pid: child.pid ?? -1,
    startedAt: new Date().toISOString(),
    logPath,
    status: "running",
  };
  writeState([...jobs.filter((j) => j.repo !== repo), job]);
  return job;
}

/** Stop a running download. The partial cache is left for `hf` to resume. */
export async function cancelDownload(repo: string): Promise<void> {
  const jobs = listDownloads();
  const job = jobs.find((j) => j.repo === repo && j.status === "running");
  if (!job) return;
  try {
    // taskkill /T because `hf` spawns worker processes for parallel file pulls;
    // killing only the parent orphans them and they keep writing.
    await execFileP("taskkill", ["/PID", String(job.pid), "/T", "/F"], { windowsHide: true });
  } catch {
    try {
      process.kill(job.pid);
    } catch {
      /* already gone */
    }
  }
  job.status = "failed";
  job.detail = "Cancelled.";
  job.finishedAt = new Date().toISOString();
  writeState(jobs);
}

/** Remove a finished job from the list. Does not touch the downloaded weights. */
export function clearDownload(repo: string): void {
  writeState(listDownloads().filter((j) => !(j.repo === repo && j.status !== "running")));
}
