/**
 * The video queue: long generations run here, not inside an HTTP request.
 *
 * A clip takes minutes, so the Lab POSTs a job and polls it. One local job runs
 * at a time — they all want the whole card — while cloud jobs (Veo) run
 * alongside, since they only wait on someone else's servers. Jobs persist in
 * the console's DuckDB store (table `video_jobs`, created here on first use) so
 * a restart neither loses the queue nor re-runs a clip ComfyUI already made.
 *
 * Precedent: src/lib/batch-queue.ts. Same rules learned there: a dead backend
 * must hold the queue rather than burn through it, and an in-flight job whose
 * browser went away still finishes and is collected.
 *
 * SERVER ONLY.
 */

import os from "os";
import fs from "fs/promises";
import { spawn } from "child_process";
import path from "path";
import { randomUUID } from "crypto";
import { getDb } from "./db";
import { getServiceUrl } from "./services";
import { gpuReading, listeners } from "./sysinfo";
import { getHost } from "./host";
import { outputDir } from "./save-image";
import { recordLabRun } from "./lab-runs";
import { buildVideoWorkflow, type ComfyGraph } from "./comfy-video-workflows";
import {
  clampSeconds,
  framesFor,
  getVideoModel,
  resolutionFor,
  videoSecondsPerMinute,
  type VideoMode,
  type VideoModelSpec,
  type VideoTier,
} from "./video-models";

const MANAGER_URL = process.env.MANAGER_URL ?? "http://localhost:8099";
const LOCAL_TIMEOUT_MS = 60 * 60 * 1000; // an hour: a 15 s H3 clip at 768p is long
const CLOUD_TIMEOUT_MS = 15 * 60 * 1000;
const SAMPLE_MS = 1000;

export type VideoJobStatus = "queued" | "waiting" | "running" | "done" | "failed" | "cancelled";

export type VideoStage =
  | "queued"
  | "waiting for memory"
  | "waiting for GPU"
  | "waiting for ComfyUI"
  | "uploading source"
  | "loading weights"
  | "encoding prompt"
  | "sampling"
  | "upscaling"
  | "decoding"
  | "writing mp4"
  | "submitted to cloud"
  | "rendering in cloud"
  | "downloading"
  | "done";

export type VideoJobRequest = {
  model: string;
  mode: VideoMode;
  prompt: string;
  seconds: number;
  tier: VideoTier;
  seed?: number;
  steps?: number;
  /** Path relative to the output dir, from /api/video/source. Required for i2v. */
  sourceImage?: string;
  /** Shared by a local job and its cloud comparison. */
  compareGroup?: string;
  /** Where the request came from — "lab", "mcp", "bench". */
  origin?: string;
};

/** Why a job is not running yet, in the coordinator's own words. */
export type VideoBlock = {
  kind: "capacity" | "slot" | "service-stopped";
  message: string;
  serviceId?: string;
};

export type VideoJob = VideoJobRequest & {
  id: string;
  status: VideoJobStatus;
  stage: VideoStage;
  width: number;
  height: number;
  frames: number;
  fps: number;
  seed: number;
  steps: number;
  local: boolean;
  createdAt: string;
  startedAt?: string;
  doneAt?: string;
  /** Sampling progress across every sampler in the graph. */
  stepsDone?: number;
  stepsTotal?: number;
  /** Seconds left, and what the estimate is based on. Null when there is no basis yet. */
  etaSec?: number | null;
  etaBasis?: string;
  /** Wall-clock phases, for the next job's estimate. */
  phases?: Partial<Record<"wait" | "load" | "sample" | "decode", number>>;
  /** Generation time, from lease to file on disk — queue wait excluded. */
  latencyMs?: number;
  peakVramGb?: number | null;
  baselineVramGb?: number | null;
  peakRamUsedGb?: number | null;
  baselineRamUsedGb?: number | null;
  /** ComfyUI's own dedicated VRAM and working set — per-process, not card-wide. */
  processPeakVramGb?: number | null;
  processBaselineVramGb?: number | null;
  processPeakRamGb?: number | null;
  processBaselineRamGb?: number | null;
  block?: VideoBlock | null;
  output?: string;
  outputBytes?: number;
  hasAudio?: boolean;
  costUsd?: number | null;
  error?: string;
  runId?: string | null;
  /** ComfyUI prompt id or cloud operation name — lets a restart collect the result. */
  remoteId?: string;
};

// ── persistence ─────────────────────────────────────────────────────────────

let schemaReady: Promise<void> | null = null;
async function db() {
  const d = await getDb();
  schemaReady ??= serial(() =>
    retrying(() =>
      d.run(
        `CREATE TABLE IF NOT EXISTS video_jobs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL)`,
      ),
    ),
  );
  await schemaReady;
  return d;
}

// The duckdb binding runs every statement on one shared connection, and two in
// flight at once fail with "cannot start a transaction within a transaction".
// The queue writes often (progress, denials), so its writes go one at a time,
// and a collision with some other route's statement is retried.
let writes: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = writes.then(fn, fn);
  writes = next.catch(() => undefined);
  return next;
}
async function retrying<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= 6 || !/transaction/i.test(String(err))) throw err;
      await new Promise((r) => setTimeout(r, 40 * attempt));
    }
  }
}

async function persist(job: VideoJob) {
  const d = await db();
  const snapshot = JSON.stringify(job);
  await serial(() =>
    retrying(() =>
      d.run(
        `INSERT INTO video_jobs VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, data = EXCLUDED.data`,
        [job.id, job.createdAt, job.status, snapshot],
      ),
    ),
  );
}

// ── paths ───────────────────────────────────────────────────────────────────

export function videoRoot(): string {
  return path.join(outputDir(), "video");
}

/** Resolve a stored relative path, refusing anything that escapes the video dir. */
export function resolveVideoPath(rel: string): string | null {
  const root = path.resolve(videoRoot());
  const full = path.resolve(root, rel);
  return full.startsWith(root + path.sep) ? full : null;
}

// ── measurement ─────────────────────────────────────────────────────────────

/**
 * ComfyUI's OWN dedicated VRAM and resident RAM, from Windows' GPU performance
 * counters (`\GPU Process Memory(pid_<pid>_*)\Dedicated Usage` — what Task
 * Manager's per-process GPU column reads) and the process working set.
 *
 * This is the number that answers "what does this model need", because the
 * card-wide figure on this box always includes someone else: quote-forge's
 * vLLM holds 13 GB permanently, and other explorations come and go mid-run.
 * One long-lived PowerShell streams a line per sample; Get-Counter itself takes
 * about a second, so samples land every ~1.5 s.
 */
function startProcessProbe(pid: number, onSample: (vramBytes: number, rssBytes: number) => void): () => void {
  const script =
    "$ErrorActionPreference='SilentlyContinue'; while ($true) { " +
    `$v = (Get-Counter '\\GPU Process Memory(pid_${pid}_*)\\Dedicated Usage').CounterSamples | Measure-Object CookedValue -Sum; ` +
    `$p = Get-Process -Id ${pid}; [Console]::Out.WriteLine(\"$([int64]$v.Sum) $($p.WorkingSet64)\"); Start-Sleep -Milliseconds 500 }`;
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
  } catch {
    return () => undefined;
  }
  let buf = "";
  child.stdout?.on("data", (d: Buffer) => {
    buf += d.toString();
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const [v, r] = buf.slice(0, i).trim().split(/\s+/).map(Number);
      buf = buf.slice(i + 1);
      if (Number.isFinite(v) && Number.isFinite(r)) onSample(v, r);
    }
  });
  child.on("error", () => undefined);
  return () => {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  };
}

/** The pid listening on a URL's port — ComfyUI's, for the probe above. */
async function pidFor(base: string): Promise<number | null> {
  try {
    const port = Number(new URL(base).port) || 80;
    return (await listeners()).find((l) => l.port === port)?.pid ?? null;
  } catch {
    return null;
  }
}

/**
 * Card-wide VRAM and box-wide RAM, sampled while a job runs, plus — on a
 * Windows NVIDIA host — the ComfyUI process's own figures (startProcessProbe).
 */
function startSampler(job: VideoJob, base?: string) {
  const sampleable = getHost().gpu === "nvidia" && getHost().memory.kind === "discrete";
  const ramUsed = () => (os.totalmem() - os.freemem()) / 1024 ** 3;
  const round = (n: number) => Math.round(n * 100) / 100;
  let stopped = false;
  const tick = async () => {
    const ram = ramUsed();
    job.peakRamUsedGb = round(Math.max(job.peakRamUsedGb ?? 0, ram));
    if (sampleable) {
      try {
        const vram = (await gpuReading()).mem_used / 1024;
        job.peakVramGb = round(Math.max(job.peakVramGb ?? 0, vram));
      } catch {
        /* a missed sample is not a failed job */
      }
    }
  };
  let stopProbe: (() => void) | null = null;
  const begin = async () => {
    job.baselineRamUsedGb = round(ramUsed());
    job.peakRamUsedGb = job.baselineRamUsedGb;
    if (sampleable && base && getHost().platform === "win32") {
      const pid = await pidFor(base);
      if (pid) {
        stopProbe = startProcessProbe(pid, (vramBytes, rssBytes) => {
          const v = round(vramBytes / 1024 ** 3);
          const r = round(rssBytes / 1024 ** 3);
          job.processBaselineVramGb ??= v;
          job.processBaselineRamGb ??= r;
          job.processPeakVramGb = Math.max(job.processPeakVramGb ?? 0, v);
          job.processPeakRamGb = Math.max(job.processPeakRamGb ?? 0, r);
        });
      }
    }
    if (sampleable) {
      try {
        job.baselineVramGb = round((await gpuReading()).mem_used / 1024);
        job.peakVramGb = job.baselineVramGb;
      } catch {
        job.baselineVramGb = null;
      }
    }
  };
  const timer = setInterval(() => {
    if (!stopped) void tick();
  }, SAMPLE_MS);
  return {
    begin,
    async stop() {
      stopped = true;
      clearInterval(timer);
      stopProbe?.();
      await tick();
    },
  };
}

// ── ETA ─────────────────────────────────────────────────────────────────────

type Timing = { model: string; mode: VideoMode; width: number; height: number; frames: number; phases: VideoJob["phases"]; latencyMs: number };

/**
 * Seconds a job should take, from the most similar finished runs of the same
 * model. Attention cost grows faster than linearly with the token count, so a
 * run is scaled by (pixels × frames) to the power 1.3 — a compromise between
 * linear (the MLPs) and quadratic (attention), stated in the basis so nobody
 * mistakes it for a measurement.
 */
function estimateFrom(history: Timing[], job: Pick<VideoJob, "model" | "mode" | "width" | "height" | "frames">): { sec: number; basis: string } | null {
  const same = history.filter((h) => h.model === job.model && h.latencyMs > 0);
  if (!same.length) return null;
  const size = (x: { width: number; height: number; frames: number }) => x.width * x.height * x.frames;
  const target = size(job);
  const best = same
    .map((h) => ({ h, d: Math.abs(Math.log(size(h) / target)) + (h.mode === job.mode ? 0 : 0.2) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 3);
  const secs = best.map(({ h }) => (h.latencyMs / 1000) * Math.pow(target / size(h), 1.3));
  const sec = secs.reduce((a, b) => a + b, 0) / secs.length;
  const exact = best[0].d < 0.01;
  return {
    sec: Math.round(sec),
    basis: exact
      ? `median of ${best.length} past run${best.length > 1 ? "s" : ""} at this size`
      : `scaled from ${best.length} past run${best.length > 1 ? "s" : ""} of this model at other sizes`,
  };
}

// ── ComfyUI ─────────────────────────────────────────────────────────────────

const STAGE_BY_CLASS: Record<string, VideoStage> = {
  UNETLoader: "loading weights",
  CLIPLoader: "loading weights",
  DualCLIPLoader: "loading weights",
  VAELoader: "loading weights",
  LoraLoaderModelOnly: "loading weights",
  CLIPVisionLoader: "loading weights",
  LatentUpscaleModelLoader: "loading weights",
  CLIPTextEncode: "encoding prompt",
  MiniMaxH3ImageToVideo: "encoding prompt",
  KSampler: "sampling",
  KSamplerAdvanced: "sampling",
  SamplerCustomAdvanced: "sampling",
  LTXVLatentUpsampler: "upscaling",
  VAEDecode: "decoding",
  VAEDecodeTiled: "decoding",
  VAEDecodeAudio: "decoding",
  LTXVAudioVAEDecode: "decoding",
  CreateVideo: "writing mp4",
  SaveVideo: "writing mp4",
};

/** Total sampler steps in a graph, so progress is "11 of 12", not "3 of 4, twice". */
function samplerSteps(graph: ComfyGraph): number {
  let total = 0;
  for (const node of Object.values(graph)) {
    if (node.class_type === "KSampler") total += Number(node.inputs.steps) || 0;
    if (node.class_type === "KSamplerAdvanced") total += Number(node.inputs.end_at_step) - Number(node.inputs.start_at_step);
    if (node.class_type === "SamplerCustomAdvanced") {
      const sig = graph[(node.inputs.sigmas as [string, number])[0]];
      if (sig?.class_type === "ManualSigmas") total += String(sig.inputs.sigmas).split(",").length - 1;
      else if (sig?.class_type === "BasicScheduler") total += Number(sig.inputs.steps) || 0;
    }
  }
  return total;
}

/**
 * Where local video jobs run. VIDEO_COMFY_URL points a console at a second
 * ComfyUI - how the cu128-vs-cu130 comparison in the experiment doc was run -
 * without touching the one the image studio uses.
 */
function comfyBase(): string {
  return process.env.VIDEO_COMFY_URL || getServiceUrl("comfyui");
}

async function comfyAlive(base: string): Promise<boolean> {
  try {
    const r = await fetch(`${base}/system_stats`, { signal: AbortSignal.timeout(4000) });
    return r.ok;
  } catch {
    return false;
  }
}

async function uploadToComfy(base: string, file: string): Promise<string> {
  const bytes = await fs.readFile(file);
  const form = new FormData();
  const ext = path.extname(file).slice(1).toLowerCase() || "png";
  form.set("image", new Blob([bytes], { type: `image/${ext === "jpg" ? "jpeg" : ext}` }), `betenshi-video-${randomUUID()}.${ext}`);
  const r = await fetch(`${base}/upload/image`, { method: "POST", body: form });
  if (!r.ok) throw new Error(`Source upload to ComfyUI failed: HTTP ${r.status}`);
  const j = (await r.json()) as { name: string; subfolder?: string };
  return j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
}

type HistoryEntry = {
  status?: { status_str?: string; completed?: boolean; messages?: [string, Record<string, unknown>][] };
  outputs?: Record<string, Record<string, { filename: string; subfolder?: string; type?: string }[] | unknown>>;
};

/** The file SaveVideo wrote, whatever key this ComfyUI version files it under. */
function videoOutput(entry: HistoryEntry): { filename: string; subfolder?: string; type?: string } | null {
  for (const out of Object.values(entry.outputs ?? {})) {
    for (const value of Object.values(out)) {
      if (!Array.isArray(value)) continue;
      const hit = value.find((f) => typeof f?.filename === "string" && /\.(mp4|webm|mkv|mov)$/i.test(f.filename));
      if (hit) return hit;
    }
  }
  return null;
}

// ── the queue ───────────────────────────────────────────────────────────────

class VideoQueue {
  jobs: VideoJob[] = [];
  private history: Timing[] = [];
  private running = false;
  private stopped = false;
  private currentAbort: AbortController | null = null;
  private cloudInFlight = new Set<string>();
  private ready: Promise<void>;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.ready = this.init();
  }

  private async init() {
    try {
      const d = await db();
      const rows = await serial(() => retrying(() => d.all<{ data: string }>(`SELECT data FROM video_jobs ORDER BY created_at`)));
      this.jobs = rows.map((r) => JSON.parse(r.data) as VideoJob);
    } catch (err) {
      console.error("[video] could not load jobs:", err);
    }
    for (const j of this.jobs) {
      if (j.status === "done" && j.latencyMs) this.history.push(j as Timing);
      // Interrupted mid-run. If ComfyUI accepted it, collect rather than re-run.
      if (j.status === "running" || j.status === "waiting") {
        j.status = "queued";
        j.stage = "queued";
        await persist(j);
      }
    }
    this.kick();
  }

  shutdown() {
    this.stopped = true;
    this.currentAbort?.abort();
    if (this.retryTimer) clearTimeout(this.retryTimer);
  }

  async list(limit = 50): Promise<VideoJob[]> {
    await this.ready;
    return [...this.jobs].reverse().slice(0, limit);
  }

  async get(id: string): Promise<VideoJob | undefined> {
    await this.ready;
    return this.jobs.find((j) => j.id === id);
  }

  /** Validate, size and enqueue. Throws a readable Error on bad input. */
  async add(req: VideoJobRequest): Promise<VideoJob> {
    await this.ready;
    const spec = getVideoModel(req.model);
    if (!spec) throw new Error(`Unknown video model "${req.model}"`);
    if (!spec.modes.includes(req.mode)) throw new Error(`${spec.label} does not do ${req.mode === "i2v" ? "image-to-video" : "text-to-video"}`);
    if (!req.prompt?.trim()) throw new Error("A prompt is required");
    if (req.mode === "i2v") {
      if (!req.sourceImage || !resolveVideoPath(req.sourceImage)) throw new Error("Image-to-video needs a source image");
    }
    const seconds = clampSeconds(spec, Number(req.seconds) || spec.nativeSeconds);
    const res = resolutionFor(spec, req.tier === "high" ? "high" : "low");
    const job: VideoJob = {
      ...req,
      prompt: req.prompt.trim().slice(0, 4000),
      seconds,
      tier: res.tier,
      id: `v_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`,
      status: "queued",
      stage: "queued",
      width: res.width,
      height: res.height,
      frames: spec.local ? framesFor(spec, seconds) : Math.round(seconds * spec.fps),
      fps: spec.fps,
      seed: Number.isFinite(req.seed) ? Math.floor(Number(req.seed)) : Math.floor(Math.random() * 2 ** 31),
      steps: req.steps ?? spec.steps,
      local: spec.local,
      createdAt: new Date().toISOString(),
      hasAudio: spec.audio,
    };
    const est = estimateFrom(this.history, job);
    job.etaSec = est?.sec ?? null;
    job.etaBasis = est?.basis ?? "no estimate yet — the first run of this model sets one";
    await persist(job); // before it joins the queue, so a failed write leaves no ghost
    this.jobs.push(job);
    this.kick();
    return job;
  }

  async cancel(id: string): Promise<VideoJob | undefined> {
    const job = await this.get(id);
    if (!job) return undefined;
    if (job.status === "queued" || job.status === "waiting") {
      job.status = "cancelled";
      job.stage = "done";
      job.doneAt = new Date().toISOString();
      await persist(job);
      if (this.current?.id === id) this.currentAbort?.abort();
    } else if (job.status === "running") {
      job.error = "Cancelled while running";
      this.cancelled.add(id);
      this.currentAbort?.abort();
      if (job.local && job.remoteId) {
        // Stop ComfyUI too — interrupt only if it is OUR prompt running, and
        // drop it from ComfyUI's own queue if it had not started.
        try {
          const base = comfyBase();
          const q = (await fetch(`${base}/queue`).then((r) => r.json())) as { queue_running?: unknown[][]; queue_pending?: unknown[][] };
          if (q.queue_running?.some((e) => e[1] === job.remoteId)) await fetch(`${base}/interrupt`, { method: "POST" });
          else if (q.queue_pending?.some((e) => e[1] === job.remoteId)) {
            await fetch(`${base}/queue`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ delete: [job.remoteId] }) });
          }
        } catch {
          /* best effort */
        }
      }
    }
    return job;
  }

  async remove(id: string): Promise<boolean> {
    const job = await this.get(id);
    if (!job) return false;
    if (job.status === "running" || job.status === "queued" || job.status === "waiting") await this.cancel(id);
    this.jobs = this.jobs.filter((j) => j.id !== id);
    const d = await db();
    await serial(() => retrying(() => d.run(`DELETE FROM video_jobs WHERE id = ?`, [id])));
    return true;
  }

  private cancelled = new Set<string>();
  private current: VideoJob | null = null;

  kick() {
    if (this.stopped) return;
    // Cloud jobs don't queue behind the GPU.
    for (const j of this.jobs) {
      if (!j.local && j.status === "queued" && !this.cloudInFlight.has(j.id)) {
        this.cloudInFlight.add(j.id);
        void this.runCloud(j).finally(() => this.cloudInFlight.delete(j.id));
      }
    }
    if (!this.running) void this.drainLocal();
  }

  private async drainLocal() {
    this.running = true;
    try {
      while (!this.stopped) {
        const job = this.jobs.find((j) => j.local && j.status === "queued");
        if (!job) break;
        const base = comfyBase();
        if (!(await comfyAlive(base))) {
          // Hold the queue; never consume it against a dead backend.
          job.status = "waiting";
          job.stage = "waiting for ComfyUI";
          job.block = { kind: "service-stopped", message: "ComfyUI isn't running.", serviceId: "comfyui" };
          await persist(job);
          this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            if (job.status === "waiting") {
              job.status = "queued";
              this.kick();
            }
          }, 15_000);
          this.retryTimer.unref?.();
          break;
        }
        await this.runLocal(job, base);
      }
    } finally {
      this.running = false;
    }
  }

  // ── local ──

  private async runLocal(job: VideoJob, base: string) {
    const spec = getVideoModel(job.model) as VideoModelSpec;
    const ac = new AbortController();
    this.currentAbort = ac;
    this.current = job;
    job.status = "waiting";
    job.stage = "waiting for GPU";
    job.block = null;
    job.error = undefined;
    const queuedAt = Date.now();
    await persist(job);

    const owner = `video:${job.id}`;
    // Report the coordinator's reason while we wait in ITS queue — fair to the
    // other sessions' work, and the reason is what the Lab turns into buttons.
    const watcher = setInterval(() => void this.readDenial(job, owner), 3000);
    let lease: { id: string } | null = null;
    try {
      lease = await acquireLease(spec.workload!, owner, ac.signal);
    } catch (err) {
      clearInterval(watcher);
      this.current = null;
      this.currentAbort = null;
      // cancel() may have changed it while we waited; TS can't see that.
      if ((job.status as VideoJobStatus) === "cancelled") return;
      return this.fail(job, err);
    }
    clearInterval(watcher);

    const sampler = startSampler(job, base);
    const started = Date.now();
    job.phases = { wait: started - queuedAt };
    job.status = "running";
    job.block = null;
    job.startedAt = new Date().toISOString();
    job.stage = "uploading source";
    await sampler.begin();
    await persist(job);

    let ws: WebSocket | null = null;
    try {
      // A restart mid-run leaves ComfyUI still rendering this job's prompt.
      // Collect that one instead of paying for the same clip twice.
      let entry = job.remoteId ? await this.reattach(base, job, ac.signal) : null;
      if (!entry) {
        const image = job.mode === "i2v" ? await uploadToComfy(base, resolveVideoPath(job.sourceImage!)!) : undefined;
        const graph = buildVideoWorkflow(spec, {
          mode: job.mode,
          prompt: job.prompt,
          image,
          width: job.width,
          height: job.height,
          frames: job.frames,
          seed: job.seed,
          steps: job.steps !== spec.steps ? job.steps : undefined,
          prefix: `betenshi-video/${job.id}`,
        });
        job.stepsTotal = samplerSteps(graph);
        job.stepsDone = 0;

        const clientId = randomUUID();
        ws = this.watchProgress(base, clientId, job, graph, started);
        const q = await fetch(`${base}/prompt`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: graph, client_id: clientId }),
        });
        if (!q.ok) throw new Error(`ComfyUI refused the graph: ${(await q.text()).slice(0, 600)}`);
        job.remoteId = ((await q.json()) as { prompt_id: string }).prompt_id;
        await persist(job);
        entry = await this.waitForComfy(base, job.remoteId, ac.signal);
      }
      const out = videoOutput(entry);
      if (!out) throw new Error("ComfyUI finished but wrote no video");
      job.stage = "downloading";
      const q2 = new URLSearchParams({ filename: out.filename, subfolder: out.subfolder ?? "", type: out.type ?? "output" });
      const res = await fetch(`${base}/view?${q2}`);
      if (!res.ok) throw new Error(`Could not read the video back from ComfyUI: HTTP ${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      const rel = path.join(job.createdAt.slice(0, 10), `${job.id}-${job.model}.mp4`);
      const full = resolveVideoPath(rel)!;
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, bytes);
      job.output = rel.replaceAll("\\", "/");
      job.outputBytes = bytes.length;
      await sampler.stop();
      job.latencyMs = Date.now() - started;
      this.closePhases(job);
      job.status = "done";
      job.stage = "done";
      job.etaSec = 0;
      job.doneAt = new Date().toISOString();
      this.history.push(job as Timing);
    } catch (err) {
      await sampler.stop();
      if (this.stopped) {
        // Retired by a reload. The job stays `running` with its remoteId, and
        // the new queue reattaches to it.
        ws?.close();
        await releaseLease(lease.id);
        return;
      }
      job.latencyMs = Date.now() - started;
      if (this.cancelled.has(job.id)) {
        this.cancelled.delete(job.id);
        job.status = "cancelled";
        job.stage = "done";
        job.doneAt = new Date().toISOString();
      } else {
        job.status = "failed";
        job.stage = "done";
        job.error = err instanceof Error ? err.message : String(err);
        job.doneAt = new Date().toISOString();
      }
    } finally {
      ws?.close();
      await releaseLease(lease.id);
      await this.freeComfy(base);
      this.current = null;
      this.currentAbort = null;
    }
    job.runId = (await this.record(job))?.id ?? null;
    await persist(job);
  }

  /** Close out phase timings once the job ends. */
  private closePhases(job: VideoJob) {
    const p = (job.phases ??= {});
    const total = job.latencyMs ?? 0;
    p.decode ??= Math.max(0, total - (p.load ?? 0) - (p.sample ?? 0));
  }

  /** Stream step progress and the running node over ComfyUI's websocket. */
  private watchProgress(base: string, clientId: string, job: VideoJob, graph: ComfyGraph, started: number): WebSocket | null {
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${base.replace(/^http/, "ws")}/ws?clientId=${clientId}`);
    } catch {
      return null;
    }
    let completedSamplers = 0;
    let lastValue = 0;
    let lastMax = 0;
    let samplingSince: number | null = null;
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return; // binary = preview frames
      let msg: { type: string; data: Record<string, unknown> };
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      const d = msg.data ?? {};
      if (d.prompt_id && d.prompt_id !== job.remoteId && job.remoteId) return;
      if (msg.type === "executing" && typeof d.node === "string") {
        const cls = graph[d.node]?.class_type;
        const stage = cls ? STAGE_BY_CLASS[cls] : undefined;
        if (stage) {
          if (stage === "sampling" && job.stage !== "sampling") {
            job.phases!.load ??= Date.now() - started;
          }
          if (stage !== "sampling" && job.stage === "sampling" && samplingSince) {
            job.phases!.sample = (job.phases!.sample ?? 0) + (Date.now() - samplingSince);
            samplingSince = null;
          }
          // The clock starts when a sampler node starts, not at its first
          // progress tick, so step 1 is counted.
          if (stage === "sampling" && job.stage !== "sampling") samplingSince = Date.now();
          job.stage = stage;
        }
      }
      // Tiled VAE decodes report progress too; only sampler steps count.
      if (msg.type === "progress" && job.stage === "sampling") {
        const value = Number(d.value) || 0;
        const max = Number(d.max) || 0;
        // A new sampler starts from the bottom again (Wan's two experts, LTX's
        // draft and refine passes).
        if (value < lastValue) completedSamplers += lastMax;
        lastValue = value;
        lastMax = max;
        samplingSince ??= Date.now();
        job.stepsDone = Math.min(job.stepsTotal ?? 0, completedSamplers + value);
        // All sampling so far: finished passes plus the one in flight.
        const sampledMs = (job.phases?.sample ?? 0) + (Date.now() - samplingSince);
        this.liveEta(job, sampledMs, job.stepsDone);
      }
    };
    ws.onerror = () => {
      /* progress is a nicety; history polling decides the outcome */
    };
    return ws;
  }

  /** Remaining time from this run's own step rate, plus decode time from history. */
  private liveEta(job: VideoJob, sampledMs: number, done: number) {
    const total = job.stepsTotal ?? 0;
    if (!total || done <= 0) return;
    const perStep = sampledMs / done;
    const remainingSample = perStep * (total - done);
    const prior = this.history.filter((h) => h.model === job.model && h.phases?.decode);
    const decode = prior.length ? prior.reduce((a, h) => a + (h.phases!.decode ?? 0), 0) / prior.length : null;
    job.etaSec = Math.round((remainingSample + (decode ?? 0)) / 1000);
    job.etaBasis = decode != null
      ? `this run's step rate (${(perStep / 1000).toFixed(1)} s/step), plus decode time from ${prior.length} past run${prior.length > 1 ? "s" : ""}`
      : `this run's step rate (${(perStep / 1000).toFixed(1)} s/step); decode time not yet known`;
  }

  /**
   * Find a prompt this job submitted before a restart. Returns its finished
   * history entry (waiting for it if ComfyUI is still on it), or null if
   * ComfyUI has never heard of it — then it is simply run again.
   */
  private async reattach(base: string, job: VideoJob, signal: AbortSignal): Promise<HistoryEntry | null> {
    const id = job.remoteId!;
    try {
      const h = (await fetch(`${base}/history/${id}`).then((r) => r.json())) as Record<string, HistoryEntry>;
      if (h[id]?.status?.completed || h[id]?.status?.status_str === "success") return h[id];
      const q = (await fetch(`${base}/queue`).then((r) => r.json())) as { queue_running?: unknown[][]; queue_pending?: unknown[][] };
      const live = [...(q.queue_running ?? []), ...(q.queue_pending ?? [])].some((e) => e[1] === id);
      if (!live) return null;
      job.stage = "sampling";
      job.etaBasis = "reattached after a restart — no live progress for this run";
      return await this.waitForComfy(base, id, signal);
    } catch {
      return null;
    }
  }

  private async waitForComfy(base: string, promptId: string, signal: AbortSignal): Promise<HistoryEntry> {
    const deadline = Date.now() + LOCAL_TIMEOUT_MS;
    let failures = 0;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      if (signal.aborted) throw new Error("Cancelled");
      let entry: HistoryEntry | undefined;
      try {
        const h = (await fetch(`${base}/history/${promptId}`, { signal: AbortSignal.timeout(10_000) }).then((r) => r.json())) as Record<string, HistoryEntry>;
        entry = h[promptId];
        failures = 0;
      } catch (err) {
        // ComfyUI drops connections while it swaps tens of GB of weights.
        if (++failures >= 30) throw new Error(`ComfyUI stopped answering: ${err instanceof Error ? err.message : err}`);
        continue;
      }
      if (!entry) continue;
      if (entry.status?.status_str === "error") {
        const m = entry.status.messages?.find((x) => x[0] === "execution_error")?.[1] as { exception_message?: string; node_type?: string } | undefined;
        throw new Error(`${m?.node_type ? `${m.node_type}: ` : ""}${m?.exception_message?.trim() ?? "ComfyUI reported an error"}`);
      }
      if (entry.status?.completed || entry.status?.status_str === "success") return entry;
    }
    throw new Error(`No result after ${LOCAL_TIMEOUT_MS / 60000} minutes`);
  }

  /**
   * Drop ComfyUI's cached weights when nothing else is queued there. A video
   * model leaves 20–40 GB in host RAM otherwise, which is exactly what the next
   * Qwen-Image or LLM start will be refused for.
   */
  private async freeComfy(base: string) {
    try {
      const q = (await fetch(`${base}/queue`).then((r) => r.json())) as { queue_running?: unknown[]; queue_pending?: unknown[] };
      if (!q.queue_running?.length && !q.queue_pending?.length) {
        await fetch(`${base}/free`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ unload_models: true, free_memory: true }),
        });
      }
    } catch {
      /* the clip is safe on disk; this is housekeeping */
    }
  }

  private async readDenial(job: VideoJob, owner: string) {
    try {
      const snap = (await fetch(`${MANAGER_URL}/resources`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json())) as {
        queue?: { owner: string; lastDenial?: { kind?: string; message?: string } | null }[];
      };
      const mine = snap.queue?.find((q) => q.owner === owner);
      const denial = mine?.lastDenial;
      if (!denial?.message) return;
      const kind = denial.kind === "slot" ? "slot" : "capacity";
      job.stage = kind === "slot" ? "waiting for GPU" : "waiting for memory";
      job.block = { kind, message: denial.message };
      await persist(job);
    } catch {
      /* the manager being slow to answer is not news */
    }
  }

  private async fail(job: VideoJob, err: unknown) {
    job.status = "failed";
    job.stage = "done";
    job.error = err instanceof Error ? err.message : String(err);
    job.doneAt = new Date().toISOString();
    await persist(job);
  }

  // ── cloud ──

  private async runCloud(job: VideoJob) {
    const spec = getVideoModel(job.model) as VideoModelSpec;
    job.status = "running";
    job.startedAt = new Date().toISOString();
    job.stage = "submitted to cloud";
    await persist(job);
    const started = Date.now();
    try {
      if (spec.backend !== "gemini") throw new Error(`No cloud backend for ${spec.id}`);
      const bytes = await veoGenerate(job, spec, (stage) => {
        job.stage = stage;
        void persist(job);
      });
      const rel = path.join(job.createdAt.slice(0, 10), `${job.id}-${job.model}.mp4`);
      const full = resolveVideoPath(rel)!;
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, bytes);
      job.output = rel.replaceAll("\\", "/");
      job.outputBytes = bytes.length;
      job.status = "done";
      job.costUsd = Math.round(job.seconds * (spec.usdPerSecond ?? 0) * 1000) / 1000;
    } catch (err) {
      job.status = "failed";
      job.error = err instanceof Error ? err.message : String(err);
    }
    job.stage = "done";
    job.latencyMs = Date.now() - started;
    job.doneAt = new Date().toISOString();
    job.runId = (await this.record(job))?.id ?? null;
    await persist(job);
  }

  // ── runs record ──

  /**
   * recordLabRun never throws — it logs and returns null — and the one thing
   * that makes it fail here is the shared-connection collision above. A
   * measured run is worth three tries.
   */
  private async record(job: VideoJob) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const run = await serial(() => this.recordOnce(job));
      if (run) return run;
      await new Promise((r) => setTimeout(r, 200 * attempt));
    }
    return null;
  }

  private recordOnce(job: VideoJob) {
    const spec = getVideoModel(job.model);
    const vsm = job.status === "done" && job.latencyMs ? videoSecondsPerMinute(job.frames / job.fps, job.latencyMs) : null;
    return recordLabRun({
      lab: "video",
      capability: "video",
      model: job.model,
      local: job.local,
      compareGroup: job.compareGroup ?? null,
      inputSummary: `${job.mode === "i2v" ? "image→video" : "text→video"} · ${job.seconds}s · ${job.width}×${job.height} · ${job.prompt.slice(0, 160)}`,
      params: {
        mode: job.mode,
        seconds: job.seconds,
        frames: job.frames,
        fps: job.fps,
        width: job.width,
        height: job.height,
        steps: job.steps,
        tier: job.tier,
        sourceImage: job.sourceImage ?? null,
        phasesMs: job.phases ?? null,
        peakRamUsedGb: job.peakRamUsedGb ?? null,
        baselineRamUsedGb: job.baselineRamUsedGb ?? null,
        processPeakVramGb: job.processPeakVramGb ?? null,
        processBaselineVramGb: job.processBaselineVramGb ?? null,
        processPeakRamGb: job.processPeakRamGb ?? null,
        processBaselineRamGb: job.processBaselineRamGb ?? null,
        videoSecondsPerMinute: vsm,
        jobId: job.id,
        origin: job.origin ?? null,
      },
      seed: job.seed,
      status: job.status === "done" ? "ok" : "error",
      error: job.status === "done" ? null : job.error ?? job.status,
      latencyMs: job.latencyMs ?? null,
      peakVramGb: job.local ? job.peakVramGb ?? null : null,
      baselineVramGb: job.local ? job.baselineVramGb ?? null : null,
      vramNote: job.local
        ? job.processPeakVramGb != null
          ? `Card-wide peak from nvidia-smi. ComfyUI's own: ${job.processPeakVramGb} GB VRAM, ${job.processPeakRamGb} GB RAM resident (Windows per-process GPU counters).`
          : "Card-wide peak from nvidia-smi, sampled every second while the job held the GPU lease; not per-process."
        : "Cloud run — no local memory used.",
      costUsd: job.local ? null : job.costUsd ?? null,
      outputPath: job.output ? path.join(videoRoot(), job.output) : null,
      outputSummary: job.output
        ? `${job.frames} frames @ ${job.fps} fps${spec?.audio ? " with audio" : ""}${vsm != null ? ` · ${vsm} s of video per minute` : ""}`
        : null,
    });
  }
}

// ── resource lease (waits in the coordinator's own queue) ─────────────────────

async function acquireLease(workload: string, owner: string, signal: AbortSignal): Promise<{ id: string }> {
  // waitMs 0 = wait until admitted. Re-issued every few minutes so no HTTP
  // client's header timeout (undici's is 300 s) cuts a long wait short.
  for (;;) {
    let res: Response;
    try {
      res = await fetch(`${MANAGER_URL}/resources/leases/acquire`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workload, owner, lane: "background", waitMs: 240_000, ttlMs: LOCAL_TIMEOUT_MS + 5 * 60_000 }),
        signal,
      });
    } catch (err) {
      if (signal.aborted) throw new Error("Cancelled");
      throw new Error(`Resource manager unavailable: ${err instanceof Error ? err.message : err}`);
    }
    const body = (await res.json().catch(() => ({}))) as { lease?: { id: string }; code?: string; error?: string };
    if (res.ok && body.lease) return body.lease;
    if (body.code === "resource-timeout") continue; // still blocked; ask again
    if (signal.aborted) throw new Error("Cancelled");
    throw new Error(body.error ?? `Resource manager returned ${res.status}`);
  }
}

async function releaseLease(id: string) {
  try {
    await fetch(`${MANAGER_URL}/resources/leases/${encodeURIComponent(id)}/release`, { method: "POST", signal: AbortSignal.timeout(5000) });
  } catch (err) {
    console.warn(`[video] failed to release lease ${id}:`, err);
  }
}

// ── Veo (Gemini API) ──────────────────────────────────────────────────────────

const GEMINI = "https://generativelanguage.googleapis.com/v1beta";
const VEO_MODEL: Record<string, string> = {
  "veo-3.1-fast": "veo-3.1-fast-generate-preview",
  "veo-3.1-lite": "veo-3.1-lite-generate-preview",
};

async function veoGenerate(job: VideoJob, spec: VideoModelSpec, onStage: (s: VideoStage) => void): Promise<Buffer> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set on this machine");
  const headers = { "x-goog-api-key": key, "Content-Type": "application/json" };
  const instance: Record<string, unknown> = { prompt: job.prompt };
  if (job.mode === "i2v") {
    const file = resolveVideoPath(job.sourceImage!);
    if (!file) throw new Error("Source image missing");
    const ext = path.extname(file).slice(1).toLowerCase();
    instance.image = { bytesBase64Encoded: (await fs.readFile(file)).toString("base64"), mimeType: ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/png" };
  }
  const start = await fetch(`${GEMINI}/models/${VEO_MODEL[spec.id]}:predictLongRunning`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      instances: [instance],
      parameters: { aspectRatio: "16:9", resolution: "720p", durationSeconds: job.seconds, ...(job.seed != null ? { seed: job.seed } : {}) },
    }),
  });
  const op = (await start.json().catch(() => ({}))) as { name?: string; error?: { message?: string } };
  if (!start.ok || !op.name) throw new Error(`Veo refused the request: ${op.error?.message ?? `HTTP ${start.status}`}`);
  job.remoteId = op.name;
  onStage("rendering in cloud");
  const deadline = Date.now() + CLOUD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 8000));
    const s = (await fetch(`${GEMINI}/${op.name}`, { headers }).then((r) => r.json())) as {
      done?: boolean;
      error?: { message?: string };
      response?: { generateVideoResponse?: { generatedSamples?: { video?: { uri?: string } }[]; raiMediaFilteredReasons?: string[] } };
    };
    if (s.error) throw new Error(`Veo: ${s.error.message}`);
    if (!s.done) continue;
    const gvr = s.response?.generateVideoResponse;
    const uri = gvr?.generatedSamples?.[0]?.video?.uri;
    if (!uri) throw new Error(`Veo returned no video${gvr?.raiMediaFilteredReasons?.length ? `: ${gvr.raiMediaFilteredReasons.join("; ")}` : ""}`);
    onStage("downloading");
    const file = await fetch(uri, { headers: { "x-goog-api-key": key } });
    if (!file.ok) throw new Error(`Could not download the Veo video: HTTP ${file.status}`);
    return Buffer.from(await file.arrayBuffer());
  }
  throw new Error("Veo did not finish within 15 minutes");
}

// ── singleton (survives HMR, retires the old worker) ──────────────────────────

const QUEUE_VERSION = 4;
const g = globalThis as typeof globalThis & { __videoQueue?: VideoQueue; __videoQueueV?: number };
if (!g.__videoQueue || g.__videoQueueV !== QUEUE_VERSION) {
  g.__videoQueue?.shutdown();
  g.__videoQueue = new VideoQueue();
  g.__videoQueueV = QUEUE_VERSION;
}
export const videoQueue = g.__videoQueue;
