import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { getDb } from "../db";
import { generateAndSave } from "../image-gen";
import { freeComfyIfIdle, videoQueue, videoRoot } from "../video-jobs";
import { listenAll, SEARXNG_URL, type SignalSource } from "./sources";
import { writeBrief, writeSecondShot, type AgentTrace, type ChannelSpec, type ReviewMemory } from "./agent";
import { nextWindowStart, shortlist, STILL_SUFFIX, windowMinutesLeft } from "./rules";
import { pickSeed, shotStillPrompt, STORY_AVOID, STORY_MODEL, STORY_STILL_SUFFIX, writeStory, type Story } from "./story";
import { recordLabRun } from "../lab-runs";

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
/**
 * A short job waiting on the forge's batch writes one line here (who, when);
 * the forge yields its claim between clips while it is fresh (< 10 min).
 */
const YIELD_FILE = process.env.GPU_YIELD_FILE ?? path.join(path.dirname(CLAIM_FILE), "gpu-yield.txt");

async function readYieldRequest(): Promise<string | null> {
  try {
    const text = (await fs.readFile(YIELD_FILE, "utf8")).trim();
    if (!text) return null;
    const at = /\d{4}-\d{2}-\d{2}T[\d:.]+Z/.exec(text)?.[0];
    if (at && Date.now() - Date.parse(at) > 10 * 60_000) return null;
    return text;
  } catch {
    return null;
  }
}
const CLAIM_TAG = "Video Forge";
const TICK_MS = 60_000;
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
/** A small local vision model (Ollama, ~10 GB while loaded; unloaded after every look). */
const VISION_MODEL = process.env.FORGE_VISION_MODEL ?? "qwen3-vl:8b";

/**
 * Does this still show people, writing or a logo? Null when the vision model
 * is not available — the check is skipped, never counted as a failure.
 */
async function checkStill(file: string): Promise<{ people: boolean; text: boolean; logo: boolean; notes: string } | null> {
  try {
    const image = (await fs.readFile(file)).toString("base64");
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: VISION_MODEL,
        stream: false,
        think: false,
        keep_alive: 0,
        options: { temperature: 0 },
        format: {
          type: "object",
          properties: { people: { type: "boolean" }, text: { type: "boolean" }, logo: { type: "boolean" }, notes: { type: "string" } },
          required: ["people", "text", "logo", "notes"],
        },
        messages: [
          {
            role: "user",
            content:
              'This image is the first frame of a calm, cinematic video clip. Answer in JSON: "people": true if ANY person, face, hand, body or human silhouette is visible, even small or far away; "text": true if any letters, words, numbers or signage are visible (real or garbled); "logo": true if any brand logo or app icon is visible; "notes": what it shows, in a few words.',
            images: [image],
          },
        ],
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { message?: { content?: string } };
    const j = JSON.parse(body.message?.content ?? "{}") as { people?: boolean; text?: boolean; logo?: boolean; notes?: string };
    return { people: !!j.people, text: !!j.text, logo: !!j.logo, notes: String(j.notes ?? "").slice(0, 120) };
  } catch {
    return null;
  }
}

export type ClipCheck = { people: boolean; text: boolean; logo: boolean; artifacts: number; beauty: number; notes: string; model: string; checkedAt: string };

/**
 * The same three-frame look Montage takes (start, middle, end; the same
 * questions), so a clip graded here needs no second look there. Null when the
 * model or ffmpeg is unavailable.
 */
async function checkClip(file: string, seconds: number): Promise<ClipCheck | null> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const os = await import("os");
  const run = promisify(execFile);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "forge-check-"));
  try {
    const images: string[] = [];
    for (const [i, t] of [0.4, seconds / 2, Math.max(0.5, seconds - 0.35)].entries()) {
      const jpg = path.join(dir, `f${i}.jpg`);
      await run("ffmpeg", ["-v", "error", "-y", "-ss", t.toFixed(2), "-i", file, "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "4", jpg]);
      images.push((await fs.readFile(jpg)).toString("base64"));
    }
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: VISION_MODEL,
        stream: false,
        think: false,
        keep_alive: 0,
        options: { temperature: 0 },
        format: {
          type: "object",
          properties: {
            people: { type: "boolean" },
            text: { type: "boolean" },
            logo: { type: "boolean" },
            artifacts: { type: "integer" },
            beauty: { type: "integer" },
            notes: { type: "string" },
          },
          required: ["people", "text", "logo", "artifacts", "beauty", "notes"],
        },
        messages: [
          {
            role: "user",
            content: [
              "These are three frames (start, middle, end) of one 5-second AI-generated video clip meant for a calm, cinematic reel.",
              "Look carefully at every frame and answer in JSON:",
              '"people": true if ANY person, face, hand, body or human silhouette is visible in any frame, even small or in the distance;',
              '"text": true if any letters, words, numbers, signage or captions are visible (real or garbled);',
              '"logo": true if any brand logo, trademark or app icon is visible;',
              '"artifacts": 0 to 3 — how distorted it is (melting shapes, warped geometry, flicker, smeared faces): 0 none, 1 slight, 2 clear, 3 severe;',
              '"beauty": 1 to 5 — how cinematic, well-lit and pleasing it is to watch;',
              '"notes": what the clip shows, in a few words.',
            ].join("\n"),
            images,
          },
        ],
      }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { message?: { content?: string } };
    const j = JSON.parse(body.message?.content ?? "{}") as Partial<ClipCheck>;
    return {
      people: !!j.people,
      text: !!j.text,
      logo: !!j.logo,
      artifacts: Math.max(0, Math.min(3, Number(j.artifacts) || 0)),
      beauty: Math.max(1, Math.min(5, Number(j.beauty) || 1)),
      notes: String(j.notes ?? "").slice(0, 200),
      model: VISION_MODEL,
      checkedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** ComfyUI failures worth one retry: a weight-streaming read, a CUDA hiccup. */
const TRANSIENT = /read_file_slice|HostBuffer|CUDA error|out of memory|allocation/i;

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
  /** Times the clip was queued again after a transient ComfyUI failure. */
  retries?: number;
  /** Shots of one topic share a group (the first shot's id); shot 1 is the brief's own, shot 2 the other distance. */
  group?: string;
  shot?: number;
  /** The vision model's look at the finished clip (the same check Montage runs). */
  check?: ClipCheck;
  /** A shot of a story film: which story, which shot, and the line said over it. */
  story?: { id: string; index: number; count: number; title: string; narration: string };
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
  /**
   * Keep going for the whole window: write a batch of briefs while vllm-small
   * is up, pause it, render the batch back to back, start it again, repeat —
   * until the window closes or there is nothing fresh left to make.
   */
  unlimited: boolean;
  /** Briefs written per cycle in unlimited mode (one vllm-small pause each). */
  batchSize: number;
  /** Google Trends countries, rotated one per listen so a day has more than 20 topics. */
  geos: string[];
  /** A one-off window that is open until this time (ISO), on top of the nightly one. */
  extraWindowUntil?: string;
  /** Look at every still with a local vision model and draw again when it shows people, writing or a logo. */
  stillCheck: boolean;
  /** Shots written per topic: 2 = the brief's shot plus the same place from another distance. */
  shotsPerTopic: number;
  /** When trends run dry, listen to the weather right now in photogenic cities instead. */
  weatherFallback: boolean;
  /**
   * If vllm-small is started again mid-window by something else (quote-forge's
   * drip asks for it every 5 minutes) while a clip waits for memory, pause it
   * again. Off unless the owner turns it on.
   */
  reclaimVllmSmall: boolean;
  /**
   * "trending": clips about what people search for today. "stories": short
   * narrated films — a local model writes a parable, fable or original tale as
   * a shot list, and Montage cuts the finished shots into the film.
   */
  mode?: "trending" | "stories";
  /** Shots per story film (5 s each). */
  storyShots?: number;
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
  unlimited: true,
  batchSize: 8,
  geos: ["US", "GB", "CA", "AU", "IN", "IE", "NZ", "SG", "ZA", "PH"],
  reclaimVllmSmall: false,
  stillCheck: true,
  shotsPerTopic: 2,
  weatherFallback: true,
  mode: "trending",
  storyShots: 14,
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
  /** Next Google Trends country, in unlimited mode. */
  geoIndex?: number;
  /** Nothing fresh was heard; do not listen again before this (ISO). */
  quietUntil?: string;
  /** Times vllm-small was paused again mid-window after something restarted it. */
  repauses?: number;
  lastRepauseAt?: string;
};

/** Minutes left in the nightly window or the one-off extra window, whichever is open. */
export function openWindowMinutes(s: ForgeSettings, at = new Date()): number | null {
  const extra = s.extraWindowUntil ? Date.parse(s.extraWindowUntil) : NaN;
  const nightly = windowMinutesLeft(s.window, at);
  if (extra > at.getTime()) return Math.max(Math.ceil((extra - at.getTime()) / 60_000), nightly ?? 0);
  return nightly;
}

// ── persistence ────────────────────────────────────────────────────────────────

let ready: Promise<void> | null = null;
let writes: Promise<unknown> = Promise.resolve();

async function db() {
  const d = await getDb();
  if (!ready) {
    ready = (async () => {
      await d.run(`CREATE TABLE IF NOT EXISTS forge_items (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL)`);
      await d.run(`CREATE TABLE IF NOT EXISTS forge_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
      await d.run(`CREATE TABLE IF NOT EXISTS forge_stories (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, data TEXT NOT NULL)`);
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

async function saveStory(story: Story) {
  const d = await db();
  await serial(() => retrying(() => d.run(`INSERT OR REPLACE INTO forge_stories (id, created_at, data) VALUES (?, ?, ?)`, [story.id, story.createdAt, JSON.stringify(story)])));
}

export async function listStories(limit = 40): Promise<Story[]> {
  const d = await db();
  const rows = await d.all<{ data: string }>(`SELECT data FROM forge_stories ORDER BY created_at DESC LIMIT ?`, [limit]);
  return rows.map((r) => JSON.parse(r.data) as Story);
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

/**
 * ComfyUI draws the stills and the clips; nothing else starts it. On the first
 * story night it had been stopped, and every still failed with "fetch failed"
 * in a second. Start it through the manager (the coordinator still decides).
 */
async function ensureComfy(): Promise<string | null> {
  const alive = async () => {
    try {
      return (await fetch("http://127.0.0.1:8188/system_stats", { signal: AbortSignal.timeout(4000) })).ok;
    } catch {
      return false;
    }
  };
  if (await alive()) return null;
  const svc = await serviceStatus("comfyui");
  if (!svc || svc.status !== "running") {
    const err = await manager("start", "comfyui");
    if (err) return `ComfyUI is stopped and could not be started: ${err}`;
  }
  for (let i = 0; i < 45; i++) {
    if (await alive()) return null;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return "ComfyUI was started but is not answering yet";
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
  private fast = false;
  private listeningNow = false;
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
    // The lock lives on globalThis, not the instance: after a hot reload the
    // retired loop may still be finishing a step, and two loops advancing the
    // same item would queue the same clip twice.
    const lock = globalThis as typeof globalThis & { __forgeTicking?: boolean };
    if (this.busy || lock.__forgeTicking) return this.schedule(this.fast ? 4_000 : TICK_MS);
    this.busy = true;
    lock.__forgeTicking = true;
    try {
      const persisted = await readState<ForgeRuntime>("runtime", {});
      this.runtime = { ...persisted, ...this.runtime, pausedVllmSmall: persisted.pausedVllmSmall, listening: this.listeningNow };
      const s = await getSettings();
      const left = openWindowMinutes(s);
      this.fast = false;
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
            continue;
          }
          // A clip that never got the memory (on the first night quote-forge's
          // drip started vllm-small again between two jobs) would otherwise wait
          // in the coordinator's queue all day. Give up on it, keep the brief.
          const job = item.video ? await videoQueue.get(item.video.jobId) : undefined;
          if (job && (job.status === "queued" || job.status === "waiting")) {
            await videoQueue.cancel(job.id);
            item.status = "brief";
            item.video = undefined;
            note(item, `Window closed while the clip was still waiting for memory${job.block ? ` (${job.block.message})` : ""}; back to tonight's list`);
            await saveItem(item);
            continue;
          }
          await this.advance(item, s);
        }
        if (!(await itemsWithStatus("rendering")).length) await this.leaveWindow("window closed");
        if (s.enabled && s.mode === "stories") {
          const next = new Date(nextWindowStart(s.window)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
          this.runtime.now = `Stories: the next film is written and made in the next window (${next}).`;
        } else if (s.enabled) await this.maybeListen(s);
        else this.runtime.now = "Paused — not listening or rendering.";
      }
    } catch (err) {
      this.runtime.now = `Error: ${err instanceof Error ? err.message : err}`;
      console.error("[forge] tick failed:", err);
    } finally {
      this.busy = false;
      lock.__forgeTicking = false;
      await writeState("runtime", this.runtime).catch(() => undefined);
      // While a window is busy, look again every few seconds: a minute between
      // one clip ending and the next starting is a minute the card sits idle,
      // and a gap in which something else can take it.
      this.schedule(this.fast ? 4_000 : TICK_MS);
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
  async listen(s?: ForgeSettings, geo?: string, sourcesOverride?: SignalSource[]): Promise<ForgeItem> {
    s ??= await getSettings();
    geo ??= s.channel.geo;
    // The guard is this loop's own field, not the persisted runtime: a loop
    // replaced mid-listen by a hot reload left "listening: true" in saved state,
    // and its successor refused every listen after that.
    if (this.listeningNow) throw new Error("Already listening");
    this.listeningNow = true;
    this.runtime.listening = true;
    this.runtime.now = `Listening: reading Google Trends (${geo}), Wikipedia and Hacker News…`;
    try {
      const searchNote = await ensureSearch();
      // Cities shown in the last three days are not offered again by the weather fallback.
      const lately = (await listItems(500)).filter((i) => Date.parse(i.createdAt) > Date.now() - 3 * 86_400_000).map((i) => i.topic);
      const heard = await listenAll({ geo, sources: sourcesOverride ?? s.channel.sources, avoid: lately });
      const recent = (await listItems(500)).filter((i) => i.status !== "failed" && Date.parse(i.createdAt) > Date.now() - 21 * 86_400_000);
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
        note(item, `Brief written by ${outcome.trace.model} in ${(outcome.trace.latencyMs / 1000).toFixed(0)} s, from Google Trends ${geo}`);
      } else if (outcome.kind === "skip") {
        item = { ...base, status: "skipped", topic: "(nothing made)", error: outcome.reason };
        note(item, `Skipped: ${outcome.reason}`);
      } else {
        item = { ...base, status: "failed", topic: "(listen failed)", error: outcome.error };
        note(item, `Failed: ${outcome.error}`);
      }
      if (outcome.kind === "brief" && s.shotsPerTopic >= 2) {
        this.runtime.now = `Writing a second shot of "${item.topic}"…`;
        const second = await writeSecondShot({ brief: outcome.brief });
        if ("error" in second) {
          note(item, `No second shot: ${second.error}`);
        } else {
          item.group = item.id;
          item.shot = 1;
          const twin: ForgeItem = {
            ...item,
            id: randomUUID().slice(0, 12),
            createdAt: new Date(Date.parse(item.createdAt) + 1).toISOString(),
            stillPrompt: second.stillPrompt,
            motionPrompt: second.motionPrompt,
            shot: 2,
            timeline: [{ at: stamp(), what: `Second shot of "${item.topic}" (the same place from another distance)` }],
          };
          note(item, "Wrote a second shot of the same topic");
          await saveItem(twin);
        }
      }
      await saveItem(item);
      this.runtime.lastListenAt = stamp();
      this.runtime.lastListenOutcome = item.status === "brief" ? `Picked "${item.topic}"` : item.error;
      this.runtime.now = item.status === "brief" ? `Wrote a brief: "${item.topic}". It will be made in the next window.` : `Listened, made nothing: ${item.error}`;
      return item;
    } finally {
      this.listeningNow = false;
      this.runtime.listening = false;
    }
  }

  // ── the nightly window ──

  private async windowTick(s: ForgeSettings, minutesLeft: number) {
    // A clip that is already in the video queue finishes whatever the clock says.
    this.fast = true;
    const inFlight = await itemsWithStatus("still", "rendering");
    for (const item of inFlight) await this.advance(item, s);
    if ((await itemsWithStatus("still", "rendering")).length) return;

    let pending = await itemsWithStatus("brief");
    if (s.mode === "stories") {
      if (!pending.length) {
        if (!(await this.writeNextStory(s, minutesLeft))) return;
        pending = await itemsWithStatus("brief");
        if (!pending.length) return;
      }
    } else if (s.unlimited && !this.runtime.pausedVllmSmall && pending.length < s.batchSize) {
      const quiet = this.runtime.quietUntil ? Date.parse(this.runtime.quietUntil) : 0;
      if (Date.now() >= quiet) {
        if (!(await smallModelUp())) {
          this.runtime.now = pending.length
            ? `Waiting for vllm-small to finish loading before writing more briefs (${pending.length} ready).`
            : "Waiting for vllm-small, the brief writer, to finish loading.";
          if (!pending.length) return;
        } else {
          // Write a batch while the writer is up; one vllm-small pause then covers all of it.
          let misses = 0;
          let weatherMisses = 0;
          const geos = s.geos.length ? s.geos : [s.channel.geo];
          while (pending.length < s.batchSize && weatherMisses < 2) {
            const geo = geos[(this.runtime.geoIndex ?? 0) % geos.length];
            this.runtime.geoIndex = ((this.runtime.geoIndex ?? 0) + 1) % geos.length;
            // Trends first; once they miss twice, the weather right now in a
            // photogenic city — always true, always visual, never used up.
            const fallback = misses >= 2 && s.weatherFallback;
            if (misses >= 2 && !s.weatherFallback) break;
            const item = await this.listen(s, geo, fallback ? ["weather"] : undefined);
            if (fallback && item.status !== "brief") weatherMisses++;
            // A listen can add two briefs (two shots of one topic): count what is really waiting.
            if (item.status === "brief") pending = await itemsWithStatus("brief");
            else misses++;
          }
          if (misses >= 2 && (!s.weatherFallback || weatherMisses >= 2)) {
            // Every country's list is used up for now; trends refresh through the day.
            this.runtime.quietUntil = new Date(Date.now() + 30 * 60_000).toISOString();
          }
          pending = await itemsWithStatus("brief");
        }
      }
    } else if (!s.unlimited && !pending.length && !this.runtime.pausedVllmSmall && (await smallModelUp())) {
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
      const quietAt = this.runtime.quietUntil ? Date.parse(this.runtime.quietUntil) : 0;
      const quiet = quietAt > Date.now();
      this.runtime.now = quiet
        ? `Window open, but nothing fresh to make: every country's trending list is used up. Listening again at ${new Date(quietAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. vllm-small is running.`
        : "Window open, nothing to render yet. vllm-small is running.";
      this.fast = !quiet;
      return;
    }
    const perClip = await this.expectedRenderMin(s);
    if (minutesLeft < perClip + 5) {
      await this.leaveWindow("not enough time left for another clip");
      this.runtime.now = `${pending.length} brief(s) left for tomorrow night — a clip takes ~${Math.round(perClip)} min and the window closes in ${minutesLeft} min.`;
      return;
    }

    // Between clips (nothing in flight here), give way to a short job that asked
    // for the card — Montage's music for a reel takes ~2 min; without this it
    // waited out a whole ~25-minute batch.
    const yieldTo = await readYieldRequest();
    if (yieldTo) {
      if (this.runtime.claimHeld || (await readClaim()).startsWith(CLAIM_TAG)) {
        await dropClaim();
        this.runtime.claimHeld = false;
      }
      this.runtime.now = `Giving the GPU to ${yieldTo.slice(0, 80)} for a moment; the batch continues after.`;
      return;
    }

    if (!(await this.holdCard(s, `a batch of ${pending.length} clip(s), ~${Math.ceil(pending.length * 2.7)} min`))) return;
    await this.advance(pending[0], s);
  }

  /** Take the shared claim and pause vllm-small (the owner's standing OK for the window). */
  private async holdCard(s: ForgeSettings, what: string): Promise<boolean> {
    const until = s.extraWindowUntil && Date.parse(s.extraWindowUntil) > Date.now() ? new Date(s.extraWindowUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : s.window.end;
    const claim = await takeClaim(`render window until ${until}: ${what}; vllm-small paused and started again after the window`);
    if (!claim.ok) {
      this.runtime.waitingFor = claim.holder;
      this.runtime.now = `Waiting for the GPU: another session holds it (${claim.holder.slice(0, 120)}).`;
      return false;
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
          return false;
        }
      }
    }
    return true;
  }

  /**
   * Stories mode: write the next film's shot list with the large local writer
   * and queue every shot as a brief, in order. The writer needs ~18 GB, so it
   * runs inside the GPU turn, after vllm-small is paused and ComfyUI is empty.
   */
  private async writeNextStory(s: ForgeSettings, minutesLeft: number): Promise<boolean> {
    const quiet = this.runtime.quietUntil ? Date.parse(this.runtime.quietUntil) : 0;
    if (Date.now() < quiet) {
      this.runtime.now = `The story writer failed a moment ago; trying again at ${new Date(quiet).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`;
      return false;
    }
    // A film is only worth starting if all of its shots can be made tonight;
    // half a film waits a whole day for the rest. A shot is ~2.7 min.
    const perShot = Math.max(2.4, Math.min(4, await this.expectedRenderMin(s)));
    const need = Math.round(perShot * (s.storyShots ?? 14) * 0.9);
    if (minutesLeft < need) {
      await this.leaveWindow("not enough of the window left for a whole film");
      this.runtime.now = `Not starting a new film: one needs ~${need} min and the window closes in ${minutesLeft} min. vllm-small is running again.`;
      return false;
    }
    const yieldTo = await readYieldRequest();
    if (yieldTo) {
      if (this.runtime.claimHeld || (await readClaim()).startsWith(CLAIM_TAG)) {
        await dropClaim();
        this.runtime.claimHeld = false;
      }
      this.runtime.now = `Giving the GPU to ${yieldTo.slice(0, 80)} before writing the next film.`;
      return false;
    }
    if (!(await this.holdCard(s, "writing a story film, then rendering its shots"))) return false;
    await freeComfyIfIdle();
    const recent = await listStories(60);
    const seed = pickSeed(recent.map((r) => r.seed), recent[0]?.kind);
    this.runtime.now = `Writing the next film with ${STORY_MODEL} (from the seed "${seed.id}")…`;
    await writeState("runtime", this.runtime);
    const t0 = Date.now();
    let story: Story;
    try {
      story = await writeStory({ seed, shots: s.storyShots ?? 14 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.runtime.quietUntil = new Date(Date.now() + 5 * 60_000).toISOString();
      this.runtime.now = `The story writer failed: ${msg.slice(0, 300)}`;
      void recordLabRun({ lab: "forge", capability: "text", model: STORY_MODEL, local: true, inputSummary: `Story film from the seed "${seed.id}"`, params: { seed: seed.id }, status: "error", error: msg.slice(0, 1000), latencyMs: Date.now() - t0 });
      return false;
    }
    await saveStory(story);
    void recordLabRun({
      lab: "forge",
      capability: "text",
      model: story.model,
      local: true,
      inputSummary: `Story film from the seed "${seed.id}" (${seed.kind})`,
      params: { seed: seed.id, shots: story.shots.length, look: story.look, storyId: story.id },
      status: "ok",
      latencyMs: story.latencyMs,
      outputSummary: `${story.title}: ${story.logline} Lesson: ${story.lesson}`,
    });
    const base = Date.now();
    for (const [i, shot] of story.shots.entries()) {
      const item: ForgeItem = {
        id: randomUUID().slice(0, 12),
        createdAt: new Date(base + i).toISOString(),
        status: "brief",
        channel: "stories",
        topic: `${story.title} — shot ${i + 1}`,
        whyNow: shot.narration,
        heard: `${story.kind} "${seed.id}" (story)`,
        sources: [],
        stillPrompt: shotStillPrompt(story, shot),
        motionPrompt: shot.motion,
        listen: { heardCount: 0, shortlisted: 0, dropped: [], problems: [] },
        agent: { model: story.model, turns: 1, calls: [], latencyMs: story.latencyMs, promptTokens: 0, completionTokens: 0 },
        group: story.id,
        shot: i + 1,
        story: { id: story.id, index: i, count: story.shots.length, title: story.title, narration: shot.narration },
        timeline: [{ at: stamp(), what: `Shot ${i + 1} of ${story.shots.length} of the film "${story.title}", written by ${story.model} in ${Math.round(story.latencyMs / 1000)} s` }],
      };
      await saveItem(item);
    }
    this.runtime.quietUntil = undefined;
    this.runtime.now = `Wrote "${story.title}" (${story.shots.length} shots) in ${Math.round((Date.now() - t0) / 1000)} s; rendering its shots now.`;
    return true;
  }

  private async expectedRenderMin(s: ForgeSettings): Promise<number> {
    const done = (await listItems(60)).filter((i) => i.video?.latencyMs && i.video.model === s.videoModel && i.video.tier === s.tier);
    if (!done.length) return s.assumeRenderMin;
    const ms = done.slice(0, 5).map((i) => i.video!.latencyMs! + (i.still?.latencyMs ?? 0));
    return Math.max(...ms) / 60_000;
  }

  /** Move one item one step: brief → still → rendering → review. */
  private async advance(item: ForgeItem, s: ForgeSettings) {
    if ((item.status === "brief" || item.status === "still") && !item.still) {
      const comfyProblem = await ensureComfy();
      if (comfyProblem) {
        this.runtime.now = `Waiting for ComfyUI before "${item.topic}": ${comfyProblem}`;
        return;
      }
      item.status = "still";
      note(item, `Making the first frame with ${s.stillModel}`);
      await saveItem(item);
      let savedPath: string | null = null;
      let res: Awaited<ReturnType<typeof generateAndSave>> | null = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        this.runtime.now = `Making the first frame of "${item.topic}"${attempt > 1 ? ` (try ${attempt})` : ""}…`;
        res = await generateAndSave({ prompt: `${item.stillPrompt} ${item.story ? STORY_STILL_SUFFIX : STILL_SUFFIX}`, model: s.stillModel, width: 1280, height: 720, folder: "forge" });
        savedPath = res.ok ? (res.body.savedPath as string | null) : null;
        if (!res.ok || !savedPath) break;
        if (!s.stillCheck) break;
        // The still model draws people and lettering the prompt said to leave
        // out; a clip made from such a still is turned away later anyway.
        // Look first, and draw again rather than spend ~2.5 min animating it.
        await freeComfyIfIdle();
        this.runtime.now = `Checking the first frame of "${item.topic}" with the vision model…`;
        const look = await checkStill(savedPath);
        if (!look) {
          note(item, "Vision check unavailable; the still was not checked");
          break;
        }
        // A story's characters are people on purpose; only writing and logos fail its stills.
        const bad = [look.people && !item.story && "people", look.text && "writing", look.logo && "a logo"].filter(Boolean).join(", ");
        if (!bad) {
          note(item, `First frame passed the vision check${attempt > 1 ? ` on try ${attempt}` : ""}`);
          break;
        }
        note(item, `First frame ${attempt} showed ${bad} (${look.notes}); ${attempt < 3 ? "drawing again" : "giving up"}`);
        if (attempt === 3) {
          item.status = "failed";
          item.error = `Three first frames in a row showed ${bad}; not animated`;
          await saveItem(item);
          return;
        }
      }
      if (!res || !res.ok || !savedPath) {
        const why = String(res?.body.error ?? "no image saved");
        // A dropped connection (ComfyUI restarting, a model loading) is not the prompt's fault.
        if (/fetch failed|ECONNREFUSED|ECONNRESET|socket hang up/i.test(why) && (item.retries ?? 0) < 3) {
          item.retries = (item.retries ?? 0) + 1;
          note(item, `Still failed (${why}); trying again`);
          await saveItem(item);
          return;
        }
        if (res?.body.resourceBlocked) {
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
      void recordLabRun({
        lab: "forge",
        capability: "image",
        model: s.stillModel,
        local: true,
        inputSummary: item.stillPrompt.slice(0, 300),
        params: { width: 1280, height: 720, itemId: item.id, ...(item.story ? { storyId: item.story.id, shot: item.story.index + 1 } : {}) },
        status: "ok",
        latencyMs: item.still.latencyMs,
        outputPath: item.still.file,
        outputSummary: `First frame of "${item.topic}"`,
      });
      await freeComfyIfIdle();
    }
    if ((item.status === "brief" || item.status === "still") && item.still) {
      const job = await videoQueue.add({
        model: s.videoModel,
        mode: "i2v",
        prompt: item.motionPrompt,
        seconds: s.seconds,
        tier: s.tier,
        sourceImage: item.still.file,
        origin: "forge",
        // The still has no one in it, but the first night's airport clip walked
        // a traveller into the last second. Wan 5B samples with real CFG, so a
        // negative prompt steers it; the channel never shows people or text.
        avoid: item.story ? STORY_AVOID : "people, person, human figure, pedestrians, crowd, face, hands, text, letters, words, watermark, logo",
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
        // Grade the finished clip now, inside this batch's claim: the vision
        // model is loaded between clips anyway, while Montage could only grade
        // after the whole batch had given the card back (~25 min later).
        if (s.stillCheck && job.output) {
          await freeComfyIfIdle();
          const check = await checkClip(path.join(videoRoot(), ...job.output.split("/")), item.video.seconds ?? s.seconds);
          if (check) {
            item.check = check;
            note(item, `Vision check: ${[check.people && !item.story && "people", check.text && "writing", check.logo && "a logo", check.artifacts > 1 && "artifacts"].filter(Boolean).join(", ") || "clean"}, beauty ${check.beauty}/5`);
            if (item.story && check.artifacts >= 3 && (item.retries ?? 0) < 1) {
              // A film cannot skip a shot the way a reel skips a clip: draw it again.
              item.retries = (item.retries ?? 0) + 1;
              item.status = "brief";
              item.still = undefined;
              item.video = undefined;
              note(item, `Severely distorted (${check.notes}); drawing and animating this shot once more`);
            }
          }
        }
      } else if (job.status === "failed" && TRANSIENT.test(job.error ?? "") && (item.retries ?? 0) < 1) {
        // ComfyUI's weight streamer (comfy_aimdo) failed to read a slice of the
        // model file mid-sample on 2 of the first 27 clips, each time right
        // after the batch's previous clip. Once more, with the same still.
        item.retries = (item.retries ?? 0) + 1;
        item.status = "still";
        item.video = undefined;
        note(item, `Clip failed (${job.error}); trying once more with the same first frame`);
      } else if (job.status === "failed" || job.status === "cancelled") {
        item.status = "failed";
        item.error = `Video ${job.status}: ${job.error ?? ""}`.trim();
        note(item, item.error);
      } else {
        const step = job.stepsTotal ? `, step ${job.stepsDone ?? 0}/${job.stepsTotal}` : "";
        const eta = job.etaSec != null ? `, ~${Math.max(1, Math.round(job.etaSec / 60))} min left` : "";
        const smallBack = !!job.block && this.runtime.pausedVllmSmall && (await smallModelUp());
        const reclaim = smallBack && s.reclaimVllmSmall;
        let holder = smallBack
          ? " vllm-small was started again by something else (quote-forge's drip asks for it every 5 minutes); this clip waits until the window closes, then goes back on the list."
          : "";
        if (reclaim) {
          // Inside the window the card is the forge's (the owner's standing OK).
          // quote-forge's drip asks the manager for vllm-small every 5 minutes and
          // gets it in any gap; pause it again, at most every 3 minutes.
          const last = this.runtime.lastRepauseAt ? Date.parse(this.runtime.lastRepauseAt) : 0;
          if (Date.now() - last > 3 * 60_000) {
            const err = await manager("stop", "vllm-small");
            this.runtime.lastRepauseAt = stamp();
            this.runtime.repauses = (this.runtime.repauses ?? 0) + 1;
            note(item, err ? `vllm-small came back mid-window; pausing it again failed: ${err}` : "vllm-small came back mid-window (restarted by something else); paused it again");
            await saveItem(item);
          }
          holder = " vllm-small had been started again by something else; the forge paused it again.";
        }
        this.runtime.now = `Rendering "${item.topic}" (${job.stage}${step}${eta}).${job.block ? ` Waiting for memory: ${job.block.message}.${holder}` : ""}`;
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

  /** Forget "nothing fresh until …" and look again now — trends move, and a fix may have widened what passes. */
  async wake(): Promise<void> {
    const persisted = await readState<ForgeRuntime>("runtime", {});
    this.runtime = { ...persisted, ...this.runtime, quietUntil: undefined };
    await writeState("runtime", this.runtime);
    this.kick();
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

  /** Put a story's failed shots back on the list (keeps their place in the film). */
  async requeueFailedShots(storyId?: string): Promise<number> {
    let n = 0;
    for (const item of await itemsWithStatus("failed")) {
      if (!item.story || (storyId && item.story.id !== storyId)) continue;
      item.status = "brief";
      item.still = undefined;
      item.video = undefined;
      item.error = undefined;
      item.retries = 0;
      note(item, "Put back on the list to be made again");
      await saveItem(item);
      n++;
    }
    this.kick();
    return n;
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
