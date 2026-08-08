import { nodePost } from "@/lib/qwen-http";
import { saveImage } from "@/lib/save-image";
import { getServiceUrl } from "@/lib/services";
import { getDb } from "@/lib/db";
import { generateFlux } from "@/lib/flux";
import { getImageModel, type ImageModelId } from "@/lib/image-models";
import { withResourceLease, workloadForImageModel } from "@/lib/resource-manager";

export type JobStatus = "queued" | "running" | "paused" | "done" | "failed" | "cancelled";

export type BatchJob = {
  id: string;
  status: JobStatus;
  idea: string;
  prompts: string[];
  params: {
    negative: string; width: number; height: number; steps: number; cfg: number;
    /** Which backend runs this job. Absent on jobs queued before FLUX existed. */
    model?: ImageModelId;
  };
  completed: number;
  failed: number;
  total: number;
  currentIndex?: number;
  createdAt: string;
  startedAt?: string;
  doneAt?: string;
  lastError?: string;
};

type DbJobRow = {
  id: string; status: string; idea: string; prompts: string; params: string;
  completed: number; failed: number; total: number; current_index: number | null;
  created_at: string; started_at: string | null; done_at: string | null; last_error: string | null;
};

function rowToJob(row: DbJobRow): BatchJob {
  return {
    id: row.id,
    status: row.status as JobStatus,
    idea: row.idea,
    prompts: JSON.parse(row.prompts),
    params: JSON.parse(row.params),
    completed: row.completed,
    failed: row.failed,
    total: row.total,
    currentIndex: row.current_index ?? undefined,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    doneAt: row.done_at ?? undefined,
    lastError: row.last_error ?? undefined,
  };
}

const IMAGE_TIMEOUT_MS = 10 * 60 * 1000; // 10 min per image
/** Consecutive failures inside one job that mean "the backend died", not "this prompt is bad" */
const CONSECUTIVE_FAIL_LIMIT = 3;
/** How often to re-probe the backend while the queue is parked waiting for it */
const RETRY_INTERVAL_MS = 30_000;
const HEALTH_TIMEOUT_MS = 4_000;

/**
 * The service a job's model runs on, and how to health-check it.
 *
 * Jobs saved before the models merged carry no `model`, so they default to
 * Qwen-Image — which is what they were queued against.
 */
function jobBackend(job: BatchJob) {
  const model = getImageModel(job.params.model);
  const base = getServiceUrl(model.serviceId);
  return {
    model,
    base,
    // ComfyUI has no /health; /system_stats is its registry health path.
    healthUrl: model.serviceId === "comfyui" ? `${base}/system_stats` : `${base}/health`,
    label: model.serviceId === "comfyui" ? "ComfyUI (:8188)" : "Qwen image service (:8021)",
  };
}

/** Is the backing service actually up? Never throws. */
async function backendAlive(healthUrl: string): Promise<boolean> {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), HEALTH_TIMEOUT_MS);
    const res = await fetch(healthUrl, { signal: ac.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

class BatchQueue {
  jobs: BatchJob[] = [];
  private running = false;
  private cancelSet = new Set<string>();
  private pauseSet = new Set<string>();
  private currentAbort: AbortController | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set when a job bails because the backend went away — tells processNext to park */
  private backendDown = false;
  /** Surfaced to the UI so "why is nothing running" is answerable */
  parked: { since: string; reason: string } | null = null;
  /** Ids removed for good — blocks saveJob from writing them back */
  private deleted = new Set<string>();
  /**
   * Set by shutdown(). Aborting the in-flight request is not enough to stop a
   * loop: the abort lands in the catch, counts as a failure and the loop moves
   * to the next prompt. A retired instance then keeps generating forever while
   * pause()/cancel() on the *new* instance touch a different pauseSet and a null
   * currentAbort — which is exactly why "pause" appeared to do nothing.
   */
  private stopped = false;

  /** Abort any in-flight request — called on HMR reinit so old zombies die */
  shutdown() {
    this.stopped = true;
    this.currentAbort?.abort();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /**
   * Backend is unreachable. Leave every job exactly where it is (still `queued`,
   * cursor intact) and re-probe on a timer — a dead service must never consume
   * the queue. Before this existed, an outage burned 38 jobs in ~10 seconds and
   * marked them all `done`.
   */
  private park(reason: string) {
    this.parked = { since: new Date().toISOString(), reason };
    console.warn(`[batch] queue parked: ${reason}`);
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.tick();
    }, RETRY_INTERVAL_MS);
    this.retryTimer.unref?.();
  }

  private async saveJob(job: BatchJob) {
    // A job deleted mid-run must not be resurrected by the in-flight runJob loop,
    // which still holds a reference and upserts after every image.
    if (this.deleted.has(job.id)) return;
    const db = await getDb();
    await db.run(
      `INSERT INTO batch_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         completed = EXCLUDED.completed,
         failed = EXCLUDED.failed,
         current_index = EXCLUDED.current_index,
         started_at = EXCLUDED.started_at,
         done_at = EXCLUDED.done_at,
         last_error = EXCLUDED.last_error`,
      [
        job.id, job.status, job.idea,
        JSON.stringify(job.prompts), JSON.stringify(job.params),
        job.completed, job.failed, job.total,
        job.currentIndex ?? null,
        job.createdAt, job.startedAt || null, job.doneAt || null, job.lastError || null,
      ],
    );
  }

  async init() {
    const db = await getDb();
    const rows = await db.all<DbJobRow>("SELECT * FROM batch_jobs ORDER BY created_at");
    this.jobs = rows.map(rowToJob);
    for (const j of this.jobs) {
      if (j.status === "running") {
        // Crashed mid-run. Requeue, but KEEP currentIndex — it is the resume
        // cursor. Deleting it used to restart the job from `completed`, which
        // silently skipped or re-ran prompts whenever anything had failed.
        j.status = "queued";
        await this.saveJob(j);
      }
    }
    if (this.jobs.some((j) => j.status === "queued")) this.tick();
  }

  /**
   * External nudge — safe to call at any time, cheap when idle. The parked-retry
   * setTimeout does not reliably survive a Turbopack HMR module reload in dev, so
   * recovery must not depend on it alone; the status route calls this whenever it
   * sees a live backend with a parked queue.
   */
  kick() {
    this.tick();
  }

  list(): BatchJob[] {
    return [...this.jobs].reverse();
  }

  get(id: string): BatchJob | undefined {
    return this.jobs.find((j) => j.id === id);
  }

  async add(job: Omit<BatchJob, "id" | "status" | "completed" | "failed" | "createdAt">): Promise<BatchJob> {
    const newJob: BatchJob = {
      ...job,
      id: `j_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      status: "queued",
      completed: 0,
      failed: 0,
      currentIndex: 0,
      createdAt: new Date().toISOString(),
    };
    this.jobs.push(newJob);
    await this.saveJob(newJob);
    this.tick();
    return newJob;
  }

  reorder(id: string, dir: "up" | "down") {
    const queuedIds = this.jobs.filter((j) => j.status === "queued").map((j) => j.id);
    const idx = queuedIds.indexOf(id);
    if (idx < 0) return;
    const swapIdx = dir === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= queuedIds.length) return;
    const i1 = this.jobs.findIndex((j) => j.id === queuedIds[idx]);
    const i2 = this.jobs.findIndex((j) => j.id === queuedIds[swapIdx]);
    [this.jobs[i1], this.jobs[i2]] = [this.jobs[i2], this.jobs[i1]];
  }

  pause(id: string) {
    const j = this.jobs.find((x) => x.id === id);
    if (!j) return;
    if (j.status === "queued") {
      j.status = "paused";
      this.saveJob(j);
    } else if (j.status === "running") {
      this.pauseSet.add(id);
      this.currentAbort?.abort();
    }
  }

  resume(id: string) {
    const j = this.jobs.find((x) => x.id === id);
    if (j && (j.status === "paused" || j.status === "failed")) {
      if (j.status === "failed") {
        // Retry everything this job never produced. Without per-prompt state the
        // best available cursor is `completed`; worst case a prompt repeats.
        j.currentIndex = j.completed;
        delete j.doneAt;
        delete j.lastError;
      }
      j.status = "queued";
      this.saveJob(j);
      this.tick();
    }
  }

  /**
   * Permanently delete a job — row and all. Distinct from cancel(), which keeps
   * the row with status 'cancelled'. The ✕ in the UI used to only filter local
   * React state, so the next poll re-read the row from DuckDB and it came back.
   */
  async remove(id: string) {
    const j = this.jobs.find((x) => x.id === id);
    if (j && (j.status === "running" || j.status === "queued" || j.status === "paused")) {
      this.cancel(id); // stop the work before dropping the record
    }
    this.deleted.add(id);
    this.jobs = this.jobs.filter((x) => x.id !== id);
    const db = await getDb();
    await db.run("DELETE FROM batch_jobs WHERE id = ?", [id]);
  }

  /** Permanently delete every terminal job. Returns how many went. */
  async removeCompleted(): Promise<number> {
    const terminal = this.jobs.filter(
      (j) => j.status === "done" || j.status === "failed" || j.status === "cancelled",
    );
    const db = await getDb();
    for (const j of terminal) {
      this.deleted.add(j.id);
      await db.run("DELETE FROM batch_jobs WHERE id = ?", [j.id]);
    }
    const gone = new Set(terminal.map((j) => j.id));
    this.jobs = this.jobs.filter((j) => !gone.has(j.id));
    return terminal.length;
  }

  /** Re-queue every job that ended short. Used by the "retry all failed" action. */
  retryAllFailed(): number {
    const failed = this.jobs.filter((j) => j.status === "failed");
    for (const j of failed) this.resume(j.id);
    return failed.length;
  }

  cancel(id: string) {
    this.cancelSet.add(id);
    const j = this.jobs.find((x) => x.id === id);
    if (j && (j.status === "queued" || j.status === "paused")) {
      j.status = "cancelled";
      j.doneAt = new Date().toISOString();
      this.saveJob(j);
    } else if (j && j.status === "running") {
      this.currentAbort?.abort();
    }
  }

  pauseAll() {
    const active = this.jobs.filter((j) => j.status === "running" || j.status === "queued");
    for (const j of active) this.pause(j.id);
  }

  cancelQueued() {
    const queued = this.jobs.filter((j) => j.status === "queued");
    for (const j of queued) this.cancel(j.id);
  }

  /** Un-pause everything. Pairs with pauseAll() for the free-GPU / start-all flow. */
  resumeAll(): number {
    const paused = this.jobs.filter((j) => j.status === "paused");
    for (const j of paused) this.resume(j.id);
    return paused.length;
  }

  /** True while an image request is genuinely in flight on this instance. */
  get busy(): boolean {
    return this.currentAbort !== null;
  }

  private tick() {
    if (this.running) return;
    this.processNext().catch(console.error);
  }

  private async processNext() {
    this.running = true;
    try {
      while (true) {
        if (this.stopped) break; // retired instance — hand the queue over
        const job = this.jobs.find((j) => j.status === "queued");
        if (!job) {
          this.parked = null;
          break;
        }
        // Preflight: never start a job against a backend that isn't there.
        // Which backend that is depends on the job's model, so this is per-job.
        const backend = jobBackend(job);
        if (!(await backendAlive(backend.healthUrl))) {
          this.park(`${backend.label} unreachable — queue held, nothing consumed`);
          break;
        }
        this.parked = null;
        this.backendDown = false;
        await this.runJob(job);
        if (this.backendDown) {
          this.park(`${backend.label} went away mid-job — queue held at the cursor`);
          break;
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async runJob(job: BatchJob) {
    job.status = "running";
    job.startedAt ??= new Date().toISOString();
    await this.saveJob(job);

    const { model, base, healthUrl } = jobBackend(job);
    let consecutiveFails = 0;

    // currentIndex is the persistent resume cursor, not a display field.
    for (let i = job.currentIndex ?? 0; i < job.prompts.length; i++) {
      if (this.stopped) {
        // Leave the row exactly as it is — the live instance owns it now.
        return;
      }
      if (this.cancelSet.has(job.id)) {
        job.status = "cancelled";
        job.doneAt = new Date().toISOString();
        this.cancelSet.delete(job.id);
        await this.saveJob(job);
        return;
      }
      if (this.pauseSet.has(job.id)) {
        job.status = "paused";
        this.pauseSet.delete(job.id);
        await this.saveJob(job);
        return;
      }

      job.currentIndex = i;
      await this.saveJob(job);

      const ac = new AbortController();
      this.currentAbort = ac;
      // Distinguish "we aborted this on purpose" from "the image took 10 minutes":
      // both surface as an abort, but only the timeout is a genuine failure.
      let timedOut = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      const seed = Math.floor(Math.random() * 2_147_483_647);
      const payload = {
        prompt: job.prompts[i],
        negative_prompt: job.params.negative || " ",
        width: job.params.width,
        height: job.params.height,
        steps: job.params.steps,
        cfg: job.params.cfg,
        seed,
      };
      try {
        const generate = async () => {
          // Waiting for the shared GPU slot is not generation time. Start the
          // timeout only after admission, while this AbortController still lets
          // pause/cancel remove a queued request.
          timeoutId = setTimeout(() => { timedOut = true; ac.abort(); }, IMAGE_TIMEOUT_MS);
          // FLUX is driven through ComfyUI's graph API, which has no equivalent of
          // the Qwen server's single POST — generateFlux queues and polls instead.
          return model.id === "flux-schnell"
            ? generateFlux({
                prompt: payload.prompt,
                width: payload.width,
                height: payload.height,
                steps: payload.steps,
                seed,
              }, IMAGE_TIMEOUT_MS, ac.signal)
            : nodePost(
                `${base}/generate`,
                JSON.stringify(payload),
                {
                  "Content-Type": "application/json",
                  // Distinct from plain "console" (a single Studio generation),
                  // because the volume is not comparable: one click here queues
                  // hundreds of images. Batch ran untagged for months and became
                  // the entire "misc" bucket — 1,589 images with no way to tell
                  // what produced them.
                  "X-Source": "console-batch",
                },
                ac.signal,
              );
        };
        const workload = workloadForImageModel(model.id);
        const buf = workload
          ? await withResourceLease(
              workload,
              {
                owner: `batch:${job.id}:${i + 1}/${job.prompts.length}`,
                lane: "background",
                waitMs: 0,
                ttlMs: IMAGE_TIMEOUT_MS + 60_000,
                signal: ac.signal,
              },
              generate,
            )
          : await generate();
        if (timeoutId) clearTimeout(timeoutId);
        await saveImage(buf, { kind: "generate", model: model.id, ...payload, latency: 0 }, job.id);
        job.completed++;
        consecutiveFails = 0;
        delete job.lastError;
      } catch (err) {
        if (timeoutId) clearTimeout(timeoutId);
        if (this.stopped) {
          // The abort came from shutdown(), not from a real failure.
          this.currentAbort = null;
          return;
        }
        if (this.pauseSet.has(job.id)) {
          job.status = "paused";
          this.pauseSet.delete(job.id);
          this.currentAbort = null;
          await this.saveJob(job);
          return;
        }
        if (this.cancelSet.has(job.id)) {
          job.status = "cancelled";
          job.doneAt = new Date().toISOString();
          this.cancelSet.delete(job.id);
          this.currentAbort = null;
          await this.saveJob(job);
          return;
        }
        if (ac.signal.aborted && !timedOut) {
          // Aborted deliberately (pause/cancel that raced the in-flight request).
          // Hold the job here rather than recording a phantom failure.
          job.status = "paused";
          this.currentAbort = null;
          await this.saveJob(job);
          return;
        }
        job.failed++;
        consecutiveFails++;
        job.lastError = err instanceof Error ? err.message : String(err);

        // Several in a row usually means the service died, not that the prompts
        // are bad. Confirm with /health; if it's gone, rewind the cursor over the
        // bogus failures, hand the job back to the queue and let processNext park.
        if (consecutiveFails >= CONSECUTIVE_FAIL_LIMIT && !(await backendAlive(healthUrl))) {
          job.status = "queued";
          job.currentIndex = Math.max(0, i - consecutiveFails + 1);
          job.failed = Math.max(0, job.failed - consecutiveFails);
          this.currentAbort = null;
          this.backendDown = true;
          await this.saveJob(job);
          return;
        }
      }
      job.currentIndex = i + 1;
      this.currentAbort = null;
      await this.saveJob(job);
    }

    // Honest terminal state: anything short of every image is `failed`, not `done`.
    if (job.status === "running") {
      job.status = job.completed === job.total ? "done" : "failed";
    }
    if (!job.doneAt) job.doneAt = new Date().toISOString();
    await this.saveJob(job);
  }
}

// Bump QUEUE_VERSION whenever the BatchQueue class changes — forces HMR to
// reinit the singleton and kill any zombie runJob calls from old code.
// 7: jobs carry a model and dispatch per-backend (Qwen :8021 or ComfyUI :8188).
// 8: FLUX generations get the job's abort signal and tolerate transient polls.
// 9: local GPU work acquires a cancellable background resource lease.
const QUEUE_VERSION = 9;
const g = globalThis as typeof globalThis & { __batchQueue?: BatchQueue; __batchQueueV?: number };
if (!g.__batchQueue || g.__batchQueueV !== QUEUE_VERSION) {
  g.__batchQueue?.shutdown();
  g.__batchQueue = new BatchQueue();
  g.__batchQueueV = QUEUE_VERSION;
  g.__batchQueue.init().catch(console.error);
}
export const batchQueue = g.__batchQueue;
