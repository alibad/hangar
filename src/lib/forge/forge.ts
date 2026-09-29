import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { getDb } from "../db";
import { generateAndSave } from "../image-gen";
import { freeComfyIfIdle, videoQueue, videoRoot } from "../video-jobs";
import { listenAll, SEARXNG_URL, type SignalSource } from "./sources";
import { writeBrief, type AgentTrace, type ChannelSpec, type ReviewMemory } from "./agent";
import { nextWindowStart, shortlist, windowMinutesLeft } from "./rules";

export { nextWindowStart, windowMinutesLeft } from "./rules";

/**
 * The Video Forge: a loop that listens to what is trending, has a local model
 * research one topic and write a brief, then renders the brief into a short
 * clip during a nightly GPU window and puts it up for review.
 *
 *   by day     listen → brief            vllm-small (already resident), free sources
 *   at night   still → clip → review     Z-Image Turbo, then Wan 2.2 5B through the
 *                                        Video Lab's queue, one lease per job
 *
 * Why a window: vllm-small (quote-forge's resident text model) holds ~17.5 GB of
 * the 32 GB card, and a video model needs ~16 GB plus tens of GB of RAM. The
 * owner decided (2026-09-30) that the forge may pause vllm-small from 01:00 to
 * 07:00, render, and start it again — and that it restarts it even if the
 * console restarts mid-window, which is why `pausedVllmSmall` is persisted.
 *
 * Nothing is published anywhere. A finished clip waits for approve / reject,
 * and those verdicts (with the reason) are fed to the next brief — the
 * "listening to the owner" half of the loop.
 *
 * Runs inside the console process like the batch and video queues: a
 * globalThis singleton, retired and replaced when FORGE_VERSION changes so hot
 * reload never leaves two loops ticking.
 */

const MANAGER_URL = process.env.MANAGER_URL ?? "http://localhost:8099";
const CLAIM_FILE = process.env.GPU_CLAIM_FILE ?? "C:\\Users\\Admin\\Code\\AI\\logs\\gpu-claim.txt";
const CLAIM_TAG = "Video Forge";
const TICK_MS = 60_000;

export type ForgeStatus =
  | "brief" // written, waiting for tonight's window
  | "still" // making the first frame
  | "rendering" // in the video queue
  | "review" // done, waiting for the owner
  | "approved"
  | "rejected"
  | "skipped" // the listen found nothing it could make
  | "failed";

export type ForgeItem = {
  id: string;
  createdAt: string;
  status: ForgeStatus;
  channel: string;
  topic: string;
  whyNow: string;
  heard: string;
  sources: { title?: string; url: string }[];
  stillPrompt: string;
  motionPrompt: string;
  /** Candidates the listen started from, and what was filtered out before the model saw them. */
  listen: { heardCount: number; shortlisted: number; dropped: { title: string; why: string }[]; problems: string[] };
  agent: AgentTrace;
  still?: { file: string; latencyMs: number; model: string };
  video?: { jobId: string; model: string; seconds: number; tier: string; output?: string; latencyMs?: number; peakVramGb?: number };
  review?: { verdict: "approved" | "rejected"; reason?: string; at: string };
  error?: string;
  timeline: { at: string; what: string }[];
};

export type ForgeSettings = {
  enabled: boolean;
  channel: ChannelSpec & { geo: string; sources: SignalSource[] };
  /** Minutes between listens, outside the window. */
  listenEveryMin: number;
  /** Stop listening when this many briefs are already waiting. */
  maxWaiting: number;
  /** Local time, "HH:MM". */
  window: { start: string; end: string };
  /** Pause vllm-small for the window (the owner's standing OK) and start it again after. */
  pauseVllmSmall: boolean;
  videoModel: string;
  tier: "low" | "high";
  seconds: number;
  stillModel: string;
  /** Minutes a render is assumed to take before any has been measured. */
  assumeRenderMin: number;
};

export const DEFAULT_SETTINGS: ForgeSettings = {
  enabled: true,
  channel: {
    id: "trending",
    label: "Whatever is trending",
    description: "short, beautiful clips about what people are searching for and reading today — the place, the season, the phenomenon, never the people.",
    geo: "US",
    sources: ["google-trends", "wikipedia", "hacker-news"],
  },
  listenEveryMin: 180,
  maxWaiting: 6,
  window: { start: "01:00", end: "07:00" },
  pauseVllmSmall: true,
  videoModel: "wan2.2-ti2v-5b",
  tier: "low",
  seconds: 5,
  stillModel: "z-image-turbo",
  assumeRenderMin: 15,
};

export type ForgeRuntime = {
  lastListenAt?: string;
  lastListenOutcome?: string;
  /** Set when WE stopped vllm-small, so only we start it again. Persisted. */
  pausedVllmSmall?: boolean;
  /** What the window is doing right now, in words. */
  now?: string;
  claimHeld?: boolean;
  waitingFor?: string;
  listening?: boolean;
};

// ── persistence ────────────────────────────────────────────────────────────────

let ready: Promise<void> | null = null;
let writes: Promise<unknown> = Promise.resolve();

async function db() {
  const d = await getDb();
  if (!ready) {
    ready = (async () => {
      await d.run(`CREATE TABLE IF NOT EXISTS forge_items (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL)`);
      await d.run(`CREATE TABLE IF NOT EXISTS forge_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    })().catch((e) => {
      ready = null;
      throw e;
    });
  }
  await ready;
  return d;
}

/** DuckDB has one connection; every write goes through this chain (see video-jobs.ts). */
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

async function saveItem(item: ForgeItem) {
  const d = await db();
  await serial(() =>
    retrying(() =>
      d.run(`INSERT OR REPLACE INTO forge_items (id, created_at, status, data) VALUES (?, ?, ?, ?)`, [item.id, item.createdAt, item.status, JSON.stringify(item)]),
    ),
  );
}

export async function listItems(limit = 60): Promise<ForgeItem[]> {
  const d = await db();
  const rows = await d.all<{ data: string }>(`SELECT data FROM forge_items ORDER BY created_at DESC LIMIT ?`, [limit]);
  return rows.map((r) => JSON.parse(r.data) as ForgeItem);
}

async function itemsWithStatus(...status: ForgeStatus[]): Promise<ForgeItem[]> {
  const d = await db();
  const rows = await d.all<{ data: string }>(
    `SELECT data FROM forge_items WHERE status IN (${status.map(() => "?").join(",")}) ORDER BY created_at ASC`,
    status,
  );
  return rows.map((r) => JSON.parse(r.data) as ForgeItem);
}

export async function getItem(id: string): Promise<ForgeItem | undefined> {
  const d = await db();
  const rows = await d.all<{ data: string }>(`SELECT data FROM forge_items WHERE id = ?`, [id]);
  return rows[0] ? (JSON.parse(rows[0].data) as ForgeItem) : undefined;
}

async function readState<T>(key: string, fallback: T): Promise<T> {
  const d = await db();
  const rows = await d.all<{ value: string }>(`SELECT value FROM forge_state WHERE key = ?`, [key]);
  return rows[0] ? (JSON.parse(rows[0].value) as T) : fallback;
}
async function writeState(key: string, value: unknown) {
  const d = await db();
  await serial(() => retrying(() => d.run(`INSERT OR REPLACE INTO forge_state (key, value) VALUES (?, ?)`, [key, JSON.stringify(value)])));
}

export async function getSettings(): Promise<ForgeSettings> {
  const saved = await readState<Partial<ForgeSettings>>("settings", {});
  return { ...DEFAULT_SETTINGS, ...saved, channel: { ...DEFAULT_SETTINGS.channel, ...(saved.channel ?? {}) }, window: { ...DEFAULT_SETTINGS.window, ...(saved.window ?? {}) } };
}

export async function updateSettings(patch: Partial<ForgeSettings>): Promise<ForgeSettings> {
  const cur = await getSettings();
  const next = { ...cur, ...patch, channel: { ...cur.channel, ...(patch.channel ?? {}) }, window: { ...cur.window, ...(patch.window ?? {}) } };
  await writeState("settings", next);
  forge.kick();
  return next;
}

// ── the box: claim file, vllm-small ────────────────────────────────────────────

async function readClaim(): Promise<string> {
  try {
    return (await fs.readFile(CLAIM_FILE, "utf8")).trim();
  } catch {
    return "";
  }
}

/** The shared GPU claim protocol: write only into an empty file, then re-read to confirm. */
async function takeClaim(note: string): Promise<{ ok: true } | { ok: false; holder: string }> {
  const cur = await readClaim();
  if (cur && !cur.startsWith(CLAIM_TAG)) return { ok: false, holder: cur };
  if (!cur) {
    await fs.mkdir(path.dirname(CLAIM_FILE), { recursive: true });
    await fs.writeFile(CLAIM_FILE, `${CLAIM_TAG} ${new Date().toISOString()} ${note}\n`);
    await new Promise((r) => setTimeout(r, 1500));
    const again = await readClaim();
    if (!again.startsWith(CLAIM_TAG)) return { ok: false, holder: again };
  }
  return { ok: true };
}

async function dropClaim() {
  if ((await readClaim()).startsWith(CLAIM_TAG)) await fs.writeFile(CLAIM_FILE, "");
}

type ManagedService = { id: string; status?: string; healthy?: boolean };

async function serviceStatus(id: string): Promise<ManagedService | null> {
  try {
    const res = await fetch(`${MANAGER_URL}/services`, { signal: AbortSignal.timeout(8000) });
    const list = (await res.json()) as ManagedService[] | { services?: ManagedService[] };
    const arr = Array.isArray(list) ? list : list.services ?? [];
    return arr.find((s) => s.id === id) ?? null;
  } catch {
    return null;
  }
}

async function manager(action: "start" | "stop", id: string): Promise<string | null> {
  try {
    const res = await fetch(`${MANAGER_URL}/services/${id}/${action}`, { method: "POST", signal: AbortSignal.timeout(120_000) });
    if (res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return body.error ?? `HTTP ${res.status}`;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

async function smallModelUp(): Promise<boolean> {
  try {
    const res = await fetch("http://127.0.0.1:8006/health", { signal: AbortSignal.timeout(4000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureSearch(): Promise<string | null> {
  try {
    const res = await fetch(`${SEARXNG_URL}/healthz`, { signal: AbortSignal.timeout(4000) });
    if (res.ok) return null;
  } catch {
    // try to start it
  }
  const err = await manager("start", "searxng");
  return err ? `search engine down (${err}); using Wikipedia search instead` : null;
}

// ── the loop ───────────────────────────────────────────────────────────────────

const stamp = () => new Date().toISOString();
const note = (item: ForgeItem, what: string) => item.timeline.push({ at: stamp(), what });

class Forge {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private stopped = false;
  runtime: ForgeRuntime = {};

  constructor() {
    this.schedule(5_000);
  }

  shutdown() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  kick() {
    this.schedule(200);
  }

  private schedule(ms: number) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  private async tick() {
    if (this.busy) return this.schedule(TICK_MS);
    this.busy = true;
    try {
      const persisted = await readState<ForgeRuntime>("runtime", {});
      this.runtime = { ...persisted, ...this.runtime, pausedVllmSmall: persisted.pausedVllmSmall };
      const s = await getSettings();
      const left = windowMinutesLeft(s.window);
      if (process.env.FORGE_DISABLED) this.runtime.now = "Disabled on this console (FORGE_DISABLED).";
      else if (s.enabled && left != null) await this.windowTick(s, left);
      else {
        // Outside the window nothing new starts, but a clip already in the video
        // queue is followed to the end — and vllm-small is only started again
        // once it is, because the coordinator would refuse it mid-render anyway.
        for (const item of await itemsWithStatus("still", "rendering")) {
          if (item.status === "still") {
            item.status = "brief";
            note(item, "Window closed before the first frame was made; back to tonight's list");
            await saveItem(item);
          } else await this.advance(item, s);
        }
        if (!(await itemsWithStatus("rendering")).length) await this.leaveWindow("window closed");
        if (s.enabled) await this.maybeListen(s);
        else this.runtime.now = "Paused — not listening or rendering.";
      }
    } catch (err) {
      this.runtime.now = `Error: ${err instanceof Error ? err.message : err}`;
      console.error("[forge] tick failed:", err);
    } finally {
      this.busy = false;
      await writeState("runtime", this.runtime).catch(() => undefined);
      this.schedule(TICK_MS);
    }
  }

  // ── listening ──

  private async maybeListen(s: ForgeSettings) {
    const waiting = (await itemsWithStatus("brief")).length;
    const next = new Date(nextWindowStart(s.window)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const last = this.runtime.lastListenAt ? Date.parse(this.runtime.lastListenAt) : 0;
    const due = Date.now() - last >= s.listenEveryMin * 60_000;
    if (waiting >= s.maxWaiting) {
      this.runtime.now = `${waiting} briefs are waiting for tonight's window (${next}); not listening until some are made.`;
      return;
    }
    if (!due) {
      const at = new Date(last + s.listenEveryMin * 60_000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      this.runtime.now = `Next listen at ${at}. ${waiting} brief${waiting === 1 ? "" : "s"} waiting for ${next}.`;
      return;
    }
    if (!(await smallModelUp())) {
      this.runtime.now = "Waiting for vllm-small (the local model that writes briefs) to be running.";
      return;
    }
    await this.listen(s);
  }

  /** One listen: hear, shortlist, research, brief. Also the "Listen now" button. */
  async listen(s?: ForgeSettings): Promise<ForgeItem> {
    s ??= await getSettings();
    if (this.runtime.listening) throw new Error("Already listening");
    this.runtime.listening = true;
    this.runtime.now = "Listening: reading Google Trends, Wikipedia and Hacker News…";
    try {
      const searchNote = await ensureSearch();
      const heard = await listenAll({ geo: s.channel.geo, sources: s.channel.sources });
      const recent = (await listItems(120)).filter((i) => i.status !== "failed" && Date.parse(i.createdAt) > Date.now() - 21 * 86_400_000);
      const recentTopics = recent.flatMap((i) => [i.topic, i.heard.replace(/ \([^)]*\)$/, "")]).filter(Boolean);
      const reviews: ReviewMemory[] = recent.filter((i) => i.review).map((i) => ({ topic: i.topic, verdict: i.review!.verdict, reason: i.review!.reason }));
      const { candidates, dropped } = shortlist(heard.signals, recentTopics);
      this.runtime.now = `Researching: ${candidates.length} candidates shortlisted from ${heard.signals.length} signals; the local model is choosing one…`;
      const outcome = await writeBrief({ channel: s.channel, candidates, recent: [...new Set(recentTopics)], reviews });
      const base = {
        id: randomUUID().slice(0, 12),
        createdAt: stamp(),
        channel: s.channel.id,
        listen: { heardCount: heard.signals.length, shortlisted: candidates.length, dropped: dropped.slice(0, 30), problems: [...heard.problems, ...(searchNote ? [searchNote] : [])] },
        agent: outcome.trace,
        sources: [],
        stillPrompt: "",
        motionPrompt: "",
        whyNow: "",
        heard: "",
        timeline: [] as { at: string; what: string }[],
      };
      let item: ForgeItem;
      if (outcome.kind === "brief") {
        item = { ...base, ...outcome.brief, status: "brief" };
        note(item, `Brief written by ${outcome.trace.model} in ${(outcome.trace.latencyMs / 1000).toFixed(0)} s`);
      } else if (outcome.kind === "skip") {
        item = { ...base, status: "skipped", topic: "(nothing made)", error: outcome.reason };
        note(item, `Skipped: ${outcome.reason}`);
      } else {
        item = { ...base, status: "failed", topic: "(listen failed)", error: outcome.error };
        note(item, `Failed: ${outcome.error}`);
      }
      await saveItem(item);
      this.runtime.lastListenAt = stamp();
      this.runtime.lastListenOutcome = item.status === "brief" ? `Picked "${item.topic}"` : item.error;
      this.runtime.now = item.status === "brief" ? `Wrote a brief: "${item.topic}". It will be made in tonight's window.` : `Listened, made nothing: ${item.error}`;
      return item;
    } finally {
      this.runtime.listening = false;
    }
  }

  // ── the nightly window ──

  private async windowTick(s: ForgeSettings, minutesLeft: number) {
    // A clip that is already in the video queue finishes whatever the clock says.
    const inFlight = await itemsWithStatus("still", "rendering");
    for (const item of inFlight) await this.advance(item, s);
    if ((await itemsWithStatus("still", "rendering")).length) return;

    let pending = await itemsWithStatus("brief");
    if (!pending.length && !this.runtime.pausedVllmSmall && (await smallModelUp())) {
      // Nothing written by day (a fresh install, or every brief was removed):
      // listen once now, while the brief writer is still up, then render it.
      const last = this.runtime.lastListenAt ? Date.parse(this.runtime.lastListenAt) : 0;
      if (Date.now() - last >= s.listenEveryMin * 60_000) {
        await this.listen(s);
        pending = await itemsWithStatus("brief");
      }
    }
    if (!pending.length) {
      await this.leaveWindow("nothing left to render");
      this.runtime.now = "Window open, nothing to render. vllm-small is running.";
      return;
    }
    const perClip = await this.expectedRenderMin(s);
    if (minutesLeft < perClip + 5) {
      await this.leaveWindow("not enough time left for another clip");
      this.runtime.now = `${pending.length} brief(s) left for tomorrow night — a clip takes ~${Math.round(perClip)} min and the window closes in ${minutesLeft} min.`;
      return;
    }

    const claim = await takeClaim(`nightly window ${s.window.start}-${s.window.end}, ${pending.length} clip(s); vllm-small paused, restarted by ${s.window.end}`);
    if (!claim.ok) {
      this.runtime.waitingFor = claim.holder;
      this.runtime.now = `Waiting for the GPU: another session holds it (${claim.holder.slice(0, 120)}).`;
      return;
    }
    this.runtime.claimHeld = true;
    this.runtime.waitingFor = undefined;

    if (s.pauseVllmSmall && !this.runtime.pausedVllmSmall) {
      const svc = await serviceStatus("vllm-small");
      if (svc && svc.status === "running") {
        this.runtime.now = "Pausing vllm-small for the window…";
        this.runtime.pausedVllmSmall = true;
        await writeState("runtime", this.runtime);
        const err = await manager("stop", "vllm-small");
        if (err) {
          this.runtime.pausedVllmSmall = false;
          this.runtime.now = `Could not pause vllm-small: ${err}`;
          return;
        }
      }
    }
    await this.advance(pending[0], s);
  }

  private async expectedRenderMin(s: ForgeSettings): Promise<number> {
    const done = (await listItems(60)).filter((i) => i.video?.latencyMs && i.video.model === s.videoModel && i.video.tier === s.tier);
    if (!done.length) return s.assumeRenderMin;
    const ms = done.slice(0, 5).map((i) => i.video!.latencyMs! + (i.still?.latencyMs ?? 0));
    return Math.max(...ms) / 60_000;
  }

  /** Move one item one step: brief → still → rendering → review. */
  private async advance(item: ForgeItem, s: ForgeSettings) {
    if (item.status === "brief" || item.status === "still") {
      item.status = "still";
      note(item, `Making the first frame with ${s.stillModel}`);
      await saveItem(item);
      this.runtime.now = `Making the first frame of "${item.topic}"…`;
      const res = await generateAndSave({ prompt: item.stillPrompt, model: s.stillModel, width: 1280, height: 720, folder: "forge" });
      const savedPath = res.ok ? (res.body.savedPath as string | null) : null;
      if (!res.ok || !savedPath) {
        const why = String(res.body.error ?? "no image saved");
        if (res.body.resourceBlocked) {
          // Not a failure: something else holds the card. Stay in "still" and retry next tick.
          this.runtime.now = `First frame of "${item.topic}" is waiting for memory: ${why}`;
          return;
        }
        item.status = "failed";
        item.error = `Still failed: ${why}`;
        note(item, item.error);
        await saveItem(item);
        return;
      }
      const dir = path.join(videoRoot(), "sources");
      await fs.mkdir(dir, { recursive: true });
      const file = `forge-${item.id}${path.extname(savedPath) || ".png"}`;
      await fs.copyFile(savedPath, path.join(dir, file));
      item.still = { file: `sources/${file}`, latencyMs: Number(res.body.latency ?? 0), model: s.stillModel };
      await freeComfyIfIdle();
      const job = await videoQueue.add({
        model: s.videoModel,
        mode: "i2v",
        prompt: item.motionPrompt,
        seconds: s.seconds,
        tier: s.tier,
        sourceImage: item.still.file,
        origin: "forge",
      });
      item.video = { jobId: job.id, model: s.videoModel, seconds: s.seconds, tier: s.tier };
      item.status = "rendering";
      note(item, `Queued the clip (${s.videoModel}, ${s.seconds} s, ${s.tier})`);
      await saveItem(item);
    }
    if (item.status === "rendering" && item.video) {
      const job = await videoQueue.get(item.video.jobId);
      if (!job) {
        item.status = "failed";
        item.error = "The video job disappeared from the queue";
      } else if (job.status === "done") {
        item.status = "review";
        item.video = { ...item.video, output: job.output, latencyMs: job.latencyMs ?? undefined, peakVramGb: job.peakVramGb ?? undefined };
        note(item, `Clip done in ${Math.round((job.latencyMs ?? 0) / 1000)} s — waiting for review`);
      } else if (job.status === "failed" || job.status === "cancelled") {
        item.status = "failed";
        item.error = `Video ${job.status}: ${job.error ?? ""}`.trim();
        note(item, item.error);
      } else {
        const step = job.stepsTotal ? `, step ${job.stepsDone ?? 0}/${job.stepsTotal}` : "";
        const eta = job.etaSec != null ? `, ~${Math.max(1, Math.round(job.etaSec / 60))} min left` : "";
        this.runtime.now = `Rendering "${item.topic}" (${job.stage}${step}${eta}).${job.block ? ` Waiting: ${job.block.message}` : ""}`;
        return;
      }
      await saveItem(item);
    }
  }

  /** Give the box back: start vllm-small if WE stopped it, and drop our claim. */
  private async leaveWindow(why: string) {
    if (this.runtime.pausedVllmSmall) {
      this.runtime.now = `Starting vllm-small again (${why})…`;
      const err = await manager("start", "vllm-small");
      if (err) {
        this.runtime.now = `Could not restart vllm-small: ${err} — will retry.`;
        return;
      }
      this.runtime.pausedVllmSmall = false;
      await writeState("runtime", this.runtime);
    }
    if (this.runtime.claimHeld || (await readClaim()).startsWith(CLAIM_TAG)) {
      await dropClaim();
      this.runtime.claimHeld = false;
    }
  }

  async review(id: string, verdict: "approved" | "rejected", reason?: string): Promise<ForgeItem> {
    const item = await getItem(id);
    if (!item) throw new Error("No such item");
    if (!["review", "approved", "rejected"].includes(item.status)) throw new Error(`Only a finished clip can be reviewed (this one is ${item.status})`);
    item.status = verdict;
    item.review = { verdict, reason: reason?.trim() || undefined, at: stamp() };
    note(item, `${verdict === "approved" ? "Approved" : "Rejected"}${item.review.reason ? `: ${item.review.reason}` : ""}`);
    await saveItem(item);
    return item;
  }

  async discard(id: string): Promise<boolean> {
    const item = await getItem(id);
    if (!item) return false;
    if (item.status === "rendering" && item.video) await videoQueue.cancel(item.video.jobId);
    const d = await db();
    await serial(() => retrying(() => d.run(`DELETE FROM forge_items WHERE id = ?`, [id])));
    return true;
  }
}

// Replaced whenever this module is evaluated afresh (a hot reload creates a new
// class): an instance kept across reloads keeps the OLD code's closures, which
// is how the first edits to the brief writer silently did nothing. Only the
// timer is stopped; a step already in flight finishes and saves.
const g = globalThis as typeof globalThis & { __forge?: Forge; __forgeClass?: typeof Forge };
if (!g.__forge || g.__forgeClass !== Forge) {
  g.__forge?.shutdown();
  g.__forge = new Forge();
  g.__forgeClass = Forge;
}
export const forge = g.__forge;
