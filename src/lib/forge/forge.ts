import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { getDb } from "../db";
import { generateAndSave } from "../image-gen";
import { freeComfyIfIdle, videoQueue, videoRoot } from "../video-jobs";
import { listenAll, SEARXNG_URL, type SignalSource } from "./sources";
import { writeBrief, writeSecondShot, type AgentTrace, type ChannelSpec, type ReviewMemory } from "./agent";
import { nextWindowStart, shortlist, STILL_SUFFIX, windowMinutesLeft } from "./rules";
import { FORMATS, pickFormat, pickLook, pickSeed, shotStillPrompt, storyHasHumans, STORY_AVOID, STORY_MODEL, STORY_STILL_SUFFIX, writeStory, type Story } from "./story";
import { pickStack, QUALITY_VIDEO, VIDEO_OPTIONS } from "./stack";
import { generateWithReferences, isHostedImageModel } from "@/lib/image-refs";
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
/**
 * The local vision model that looks at every still and clip (Ollama, unloaded
 * after every look). The `checkModel` setting overrides it — Gemma 4 31B, the
 * writer, sees images too: a stronger judge of who is in a shot, at 19 GB a
 * load instead of 6.
 */
const VISION_MODEL = process.env.FORGE_VISION_MODEL ?? "qwen3-vl:8b";
/** The local picture model a frame falls back to: fast, 11 GB, Apache-2.0. */
const FALLBACK_STILL = "z-image-turbo";

/**
 * Does this still show people, writing or a logo? Null when the vision model
 * is not available — the check is skipped, never counted as a failure.
 */
async function checkStill(
  file: string,
  expect?: { name: string; look: string }[],
  model = VISION_MODEL,
): Promise<{ people: boolean; text: boolean; logo: boolean; border?: boolean; notes: string; present?: boolean[] } | null> {
  try {
    const image = (await fs.readFile(file)).toString("base64");
    const cast = expect?.length ? expect : null;
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
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
            border: { type: "boolean" },
            notes: { type: "string" },
            ...(cast ? { present: { type: "array", items: { type: "boolean" } } } : {}),
          },
          required: ["people", "text", "logo", "border", "notes", ...(cast ? ["present"] : [])],
        },
        messages: [
          {
            role: "user",
            content:
              'This image is the first frame of a calm, cinematic video clip. Answer in JSON: "people": true if ANY person, face, hand, body or human silhouette is visible, even small or far away; "text": true if any letters, words, numbers or signage are visible (real or garbled); "logo": true if any brand logo or app icon is visible; "border": true if a decorative border, ornamental frame or plain margin is painted around the picture instead of the scene running to the edges; "notes": what it shows, in a few words.' +
              (cast
                ? ` "present": one true/false per subject below, in order — true if that subject is clearly visible in the image (in the image's own style; a painted or paper frog still counts as a frog):\n${cast.map((c, i) => `${i + 1}. ${c.look}`).join("\n")}`
                : ""),
            images: [image],
          },
        ],
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { message?: { content?: string } };
    const j = JSON.parse(body.message?.content ?? "{}") as { people?: boolean; text?: boolean; logo?: boolean; border?: boolean; notes?: string; present?: unknown[] };
    const present = cast ? cast.map((_, i) => (Array.isArray(j.present) ? j.present[i] !== false : true)) : undefined;
    return { people: !!j.people, text: !!j.text, logo: !!j.logo, border: !!j.border, notes: String(j.notes ?? "").slice(0, 120), ...(present ? { present } : {}) };
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
async function checkClip(file: string, seconds: number, model = VISION_MODEL): Promise<ClipCheck | null> {
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
        model,
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
      model,
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
  story?: {
    id: string;
    index: number;
    count: number;
    title: string;
    narration: string;
    /** Who must be in the picture (continuity), and whether the story has any person in it. */
    cast?: { name: string; look: string; sheet?: string }[];
    humans?: boolean;
    /** The model this story's first frames are drawn with (fixed when it was written, so one film keeps one look). */
    pictures?: string;
  };
  /**
   * A bake-off shot: a finished story's shot, from the same first frame,
   * animated by another stack — so films differ only in what is being tested.
   */
  variant?: { bakeoffId: string; key: string; label: string; storyId: string; index: number };
  /** Per-shot render settings (bake-offs); otherwise the forge's own. */
  render?: { videoModel: string; tier: "low" | "high"; seconds?: number; steps?: number };
  /** When the shot's clip started waiting for memory (bake-offs give up on a model that never fits). */
  waitingSince?: string;
  timeline: { at: string; what: string }[];
};

/** One screenplay, several stacks: the shots re-animated by each variant. */
export type Bakeoff = {
  id: string;
  createdAt: string;
  storyId: string;
  title: string;
  variants: { key: string; label: string; videoModel: string; tier: "low" | "high" }[];
};

/** The video models compared against the films' Wan 2.2 5B, lightest first (a model that does not fit is given up on). */
export const DEFAULT_BAKEOFF_VARIANTS: Bakeoff["variants"] = [
  { key: "hunyuan", label: "HunyuanVideo 1.5 (480p)", videoModel: "hunyuanvideo-1.5", tier: "low" },
  { key: "ltx", label: "LTX-2.5 22B (with sound)", videoModel: "ltx-2.5", tier: "high" },
  { key: "wan14b", label: "Wan 2.2 14B (4-step)", videoModel: "wan2.2-14b", tier: "high" },
  { key: "h3", label: "MiniMax H3 33B (with sound)", videoModel: "minimax-h3", tier: "low" },
];

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
  /** Video models stories rotate through (keys from stack.ts); all of them when unset. */
  storyVideoModels?: string[];
  /** The model that draws stories' first frames and character sheets (a router alias: hosted, through the console); stillModel when unset. */
  storyStillModel?: string;
  /** Every Nth story is made at full quality (Wan 2.2 14B, 20 steps) when it fits; 0 = never. */
  storyQualityEvery?: number;
  /** The vision model for still and clip checks (an Ollama tag); FORGE_VISION_MODEL / qwen3-vl:8b when unset. */
  checkModel?: string;
  /**
   * Services the owner asked to keep off while the window is open, stopped
   * again if something starts them (2026-10-02: quote-forge's Qwen image
   * server, which held 28-31 GB of RAM and starved every first frame).
   */
  keepOffInWindow?: string[];
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
  /** Last time a keep-off service was stopped again, per service. */
  keptOffAt?: Record<string, string>;
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
      await d.run(`CREATE TABLE IF NOT EXISTS forge_bakeoffs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, data TEXT NOT NULL)`);
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

async function saveBakeoff(b: Bakeoff) {
  const d = await db();
  await serial(() => retrying(() => d.run(`INSERT OR REPLACE INTO forge_bakeoffs (id, created_at, data) VALUES (?, ?, ?)`, [b.id, b.createdAt, JSON.stringify(b)])));
}

export async function listBakeoffs(limit = 20): Promise<Bakeoff[]> {
  const d = await db();
  const rows = await d.all<{ data: string }>(`SELECT data FROM forge_bakeoffs ORDER BY created_at DESC LIMIT ?`, [limit]);
  return rows.map((r) => JSON.parse(r.data) as Bakeoff);
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

/**
 * The stack keys of the video models that would fit right now (the Video Lab's
 * own fit check: measured footprints against free memory). Wan 2.2 5B is always
 * offered — it is the forge's own model and waits for room like any clip. On
 * 3 Oct, 6 GB less RAM was free than on the bake-off night and Wan 2.2 14B
 * (35 GB of RAM measured) could not start; a story would have waited 12 minutes
 * before falling back. Now such a model is simply not chosen for that story.
 */
async function videoModelsThatFit(): Promise<{ keys: string[]; skipped: string[] }> {
  const all = VIDEO_OPTIONS.map((o) => o.key);
  // The writer was asked to unload (keep_alive 0); give it a moment to leave the card.
  for (let i = 0; i < 10; i++) {
    const ps = (await fetch(`${OLLAMA_URL}/api/ps`, { signal: AbortSignal.timeout(4000) }).then((r) => r.json(), () => null)) as { models?: unknown[] } | null;
    if (!ps?.models?.length) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  try {
    const res = await fetch(`http://127.0.0.1:${process.env.PORT ?? 8003}/api/video/models`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return { keys: all, skipped: [] };
    const body = (await res.json()) as { models: { spec: { id: string }; available: boolean; installed: boolean | null; fit?: { ok: boolean; shortRamGb: number; shortVramGb: number } }[] };
    const keys: string[] = [];
    const skipped: string[] = [];
    for (const o of VIDEO_OPTIONS) {
      const m = body.models.find((x) => x.spec.id === o.videoModel);
      const fits = !!m && m.available && m.installed !== false && (m.fit?.ok ?? true);
      if (fits || o.key === "wan5b") keys.push(o.key);
      else skipped.push(`${o.label}${m?.fit ? ` (short ${[m.fit.shortRamGb ? `${m.fit.shortRamGb} GB RAM` : "", m.fit.shortVramGb ? `${m.fit.shortVramGb} GB VRAM` : ""].filter(Boolean).join(", ") || "of room"})` : " (not available)"}`);
    }
    return { keys, skipped };
  } catch {
    return { keys: all, skipped: [] };
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
    await this.keepServicesOff(s);
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

  /** Stop again, at most every 2 minutes each, the services the owner asked to keep off during the window. */
  private async keepServicesOff(s: ForgeSettings) {
    for (const id of s.keepOffInWindow ?? []) {
      const last = this.runtime.keptOffAt?.[id] ? Date.parse(this.runtime.keptOffAt[id]) : 0;
      if (Date.now() - last < 2 * 60_000) continue;
      const svc = await serviceStatus(id);
      if (!svc || (svc.status !== "running" && svc.status !== "starting")) continue;
      const err = await manager("stop", id);
      this.runtime.keptOffAt = { ...(this.runtime.keptOffAt ?? {}), [id]: stamp() };
      console.log(`[forge] ${id} was started during the window; ${err ? `stopping it failed: ${err}` : "stopped it again (the owner asked to keep it off)"}`);
    }
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
    // ~10% on top for the GPU turns Montage takes between shots for narration and score.
    const need = Math.round(perShot * (s.storyShots ?? 14) * 1.1);
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
    const format = pickFormat(recent.map((r) => r.format ?? "tale"));
    const seed = pickSeed(recent.map((r) => r.seed), recent[0]?.kind, format);
    const look = pickLook(recent.map((r) => r.look), format);
    const shots = Math.min(FORMATS[format].shots, s.storyShots ?? 14);
    this.runtime.now = `Writing the next film with ${STORY_MODEL}: ${FORMATS[format].label.toLowerCase()} from "${seed.id}"…`;
    await writeState("runtime", this.runtime);
    const t0 = Date.now();
    let story: Story;
    try {
      story = await writeStory({ seed, shots, look, format });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.runtime.quietUntil = new Date(Date.now() + 5 * 60_000).toISOString();
      this.runtime.now = `The story writer failed: ${msg.slice(0, 300)}`;
      void recordLabRun({ lab: "forge", capability: "text", model: STORY_MODEL, local: true, inputSummary: `Story film from the seed "${seed.id}"`, params: { seed: seed.id, format }, status: "error", error: msg.slice(0, 1000), latencyMs: Date.now() - t0 });
      return false;
    }
    // Only the video models that fit right now (the writer has unloaded by now).
    const room = await videoModelsThatFit();
    const allowed = s.storyVideoModels?.length ? room.keys.filter((k) => s.storyVideoModels!.includes(k)) : room.keys;
    const stacks = recent.map((r) => r.stack).filter((x): x is NonNullable<Story["stack"]> => !!x);
    const every = s.storyQualityEvery ?? 3;
    const qualityDue = every > 0 && !stacks.slice(0, every - 1).some((st) => st.video.key === QUALITY_VIDEO.key) && room.keys.includes("wan14b");
    story.stack = pickStack(story, stacks, { video: allowed.length ? allowed : ["wan5b"], quality: qualityDue });
    if (room.skipped.length) story.notes.push(`Not tried for this film, no room right now: ${room.skipped.join("; ")}`);
    if (every > 0 && !qualityDue && !room.keys.includes("wan14b") && !stacks.slice(0, every - 1).some((st) => st.video.key === QUALITY_VIDEO.key))
      story.notes.push("The full-quality slot (Wan 2.2 14B, 20 steps) is due but it does not fit right now; it waits for a film when it does");
    const pictures = s.storyStillModel || s.stillModel;
    story.stack.pictures = pictures;
    // Characters drawn once, so every shot can be drawn from them (hosted models take references).
    if (isHostedImageModel(pictures) && story.characters.length) await this.drawCharacterSheets(story, pictures);
    await saveStory(story);
    void recordLabRun({
      lab: "forge",
      capability: "text",
      model: story.model,
      local: true,
      inputSummary: `${FORMATS[format].label} from the seed "${seed.id}" (${seed.kind})`,
      params: { seed: seed.id, format, shots: story.shots.length, look: story.look, storyId: story.id, stack: story.stack, continuity: story.notes.filter((n) => n.startsWith("Continuity")) },
      status: "ok",
      latencyMs: story.latencyMs,
      outputSummary: `${story.title}: ${story.logline} Lesson: ${story.lesson}`,
    });
    const base = Date.now();
    const humans = storyHasHumans(story.characters);
    const lookOf = new Map(story.characters.map((c) => [c.name, c.look]));
    const sheetOf = new Map(story.characters.filter((c) => c.sheet).map((c) => [c.name, c.sheet!]));
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
        story: {
          id: story.id,
          index: i,
          count: story.shots.length,
          title: story.title,
          narration: shot.narration,
          cast: (shot.cast ?? []).filter((n) => lookOf.has(n)).map((n) => ({ name: n, look: lookOf.get(n)!, ...(sheetOf.has(n) ? { sheet: sheetOf.get(n) } : {}) })),
          humans,
          pictures: story.stack.pictures,
        },
        render: { videoModel: story.stack.video.videoModel, tier: story.stack.video.tier, ...(story.stack.video.steps ? { steps: story.stack.video.steps } : {}) },
        timeline: [
          {
            at: stamp(),
            what: `Shot ${i + 1} of ${story.shots.length} of the film "${story.title}" (${FORMATS[format].label.toLowerCase()}), written by ${story.model} in ${Math.round(story.latencyMs / 1000)} s; motion by ${story.stack.video.label}`,
          },
        ],
      };
      await saveItem(item);
    }
    this.runtime.quietUntil = undefined;
    this.runtime.now = `Wrote "${story.title}" — ${FORMATS[format].label.toLowerCase()}, ${story.shots.length} shots, motion by ${story.stack.video.label} — in ${Math.round((Date.now() - t0) / 1000)} s; rendering its shots now.`;
    return true;
  }

  /**
   * Each character drawn once, full figure on a plain ground in the film's look:
   * the reference every shot they are in is drawn from. Saved under the video
   * root (sources/), recorded as lab runs; a sheet that fails leaves that
   * character to be drawn from text, as before.
   */
  private async drawCharacterSheets(story: Story, model: string) {
    const dir = path.join(videoRoot(), "sources");
    await fs.mkdir(dir, { recursive: true });
    const look = story.look.replace(/\.$/, "");
    const made: string[] = [];
    for (const c of story.characters.slice(0, 4)) {
      this.runtime.now = `Drawing ${c.name} for "${story.title}" with ${model}…`;
      const prompt = `Character reference for an animated film: ${c.look}. One full figure, standing, three-quarter view, centred, the whole body visible, on a plain softly lit neutral background; nothing else in the picture. In this exact visual style: ${look}. No text, no labels, no multiple views.`;
      const r = await generateWithReferences({ model, prompt, width: 1024, height: 1024, folder: "forge", source: "console/forge-sheet" });
      void recordLabRun({
        lab: "forge",
        capability: "image",
        model,
        local: false,
        inputSummary: `Character sheet: ${c.name} for "${story.title}"`,
        params: { storyId: story.id, character: c.name, width: 1024, height: 1024 },
        status: r.ok ? "ok" : "error",
        latencyMs: r.ok ? r.latency : 0,
        ...(r.ok ? { outputPath: r.savedPath ?? undefined, outputSummary: `${c.name}: ${c.look}`.slice(0, 300) } : { error: r.error.slice(0, 1000) }),
      });
      if (!r.ok || !r.savedPath) {
        story.notes.push(`No character sheet for ${c.name}: ${r.ok ? "nothing saved" : r.error.slice(0, 160)}`);
        continue;
      }
      const file = `sheet-${story.id}-${c.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}${path.extname(r.savedPath) || ".png"}`;
      await fs.copyFile(r.savedPath, path.join(dir, file));
      c.sheet = `sources/${file}`;
      made.push(`${c.name} (${Math.round(r.latency / 1000)} s)`);
    }
    if (made.length) story.notes.push(`Character sheets by ${model}: ${made.join(", ")} — every shot they are in is drawn from them`);
    await saveStory(story);
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
      // Noted once: a still waiting for memory comes back here every few seconds.
      if (item.status !== "still") note(item, `Making the first frame with ${item.story?.pictures ?? s.stillModel}`);
      item.status = "still";
      await saveItem(item);
      let savedPath: string | null = null;
      let res: Awaited<ReturnType<typeof generateAndSave>> | null = null;
      // Continuity: a story's still is checked for the characters its shot needs,
      // and for a person in a story that has none (the first scorpion film drew
      // "two figures" as two people). The best of three tries is kept.
      const cast = item.story?.cast ?? [];
      let best: { score: number; res: Awaited<ReturnType<typeof generateAndSave>>; path: string; why: string; model: string } | null = null;
      let castNote = "";
      let usedModel = s.stillModel;
      let usedLocal = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        this.runtime.now = `Making the first frame of "${item.topic}"${attempt > 1 ? ` (try ${attempt})` : ""}…`;
        // After a try that lost someone, their looks lead the prompt.
        const lead = attempt > 1 && castNote ? `${cast.map((c) => c.look).join(" and ")}, clearly visible. ` : "";
        const noPeople = item.story && item.story.humans === false ? " No people, no humans." : "";
        const hosted = item.story?.pictures && isHostedImageModel(item.story.pictures) && !usedLocal ? item.story.pictures : null;
        if (hosted) {
          const refs = cast.filter((c) => c.sheet).map((c) => path.join(videoRoot(), ...c.sheet!.split("/")));
          const keep = refs.length ? " Keep every character exactly as in the reference images — the same face, build, hair, clothing and colours — but draw them into this scene." : "";
          const prompt = `${lead}${item.stillPrompt}${noPeople}${keep} One single wide cinematic film frame. It will be cropped to a wide 2.39:1 cinema strip, so keep every face and head in the middle band with clear space above the heads, and nothing important near the top or bottom edge; no borders, no panels, no character-sheet layout. ${STORY_STILL_SUFFIX}`;
          const r = await generateWithReferences({ model: hosted, prompt, width: 1536, height: 1024, references: refs, folder: "forge", source: "console/forge" });
          if (r.ok) {
            res = { ok: true, target: "ai-router", body: { savedPath: r.savedPath, latency: r.latency, model: hosted, references: refs.length } };
            usedModel = hosted;
            if (attempt === 1 && refs.length) note(item, `Drawing with ${hosted} from ${refs.length} character sheet${refs.length > 1 ? "s" : ""}`);
          } else {
            // OpenAI down, out of quota or refusing: this shot is drawn locally instead.
            note(item, `${hosted} failed (${r.error.slice(0, 160)}); drawing this shot with ${s.stillModel}`);
            usedLocal = true;
            usedModel = s.stillModel;
            res = await generateAndSave({ prompt: `${lead}${item.stillPrompt}${noPeople} ${STORY_STILL_SUFFIX}`, model: s.stillModel, width: 1280, height: 720, folder: "forge" });
          }
        } else {
          usedModel = s.stillModel;
          const prompt = `${lead}${item.stillPrompt}${noPeople} ${item.story ? STORY_STILL_SUFFIX : STILL_SUFFIX}`;
          res = await generateAndSave({ prompt, model: s.stillModel, width: 1280, height: 720, folder: "forge" });
          // A bigger local model (Qwen-Image-2.1 wants ~15 GB) refused for room
          // or failing: this frame is drawn by Z-Image instead of losing the shot.
          if (!res.ok && s.stillModel !== FALLBACK_STILL) {
            note(item, `${s.stillModel} could not draw (${String(res.body.error ?? res.status).slice(0, 160)}); this frame is drawn with ${FALLBACK_STILL}`);
            usedModel = FALLBACK_STILL;
            res = await generateAndSave({ prompt, model: FALLBACK_STILL, width: 1280, height: 720, folder: "forge" });
          }
        }
        savedPath = res.ok ? (res.body.savedPath as string | null) : null;
        if (!res.ok || !savedPath) break;
        if (!s.stillCheck) break;
        // The still model draws people and lettering the prompt said to leave
        // out; a clip made from such a still is turned away later anyway.
        // Look first, and draw again rather than spend ~2.5 min animating it.
        await freeComfyIfIdle();
        this.runtime.now = `Checking the first frame of "${item.topic}" with the vision model…`;
        const look = await checkStill(savedPath, item.story ? cast : undefined, s.checkModel || VISION_MODEL);
        if (!look) {
          note(item, "Vision check unavailable; the still was not checked");
          break;
        }
        // A story's characters are people on purpose, unless the story has none.
        const strayPeople = look.people && (!item.story || item.story.humans === false);
        const bad = [strayPeople && "people", look.text && "writing", look.logo && "a logo", look.border && "a painted border"].filter(Boolean).join(", ");
        const missing = cast.filter((_, i) => look.present && look.present[i] === false).map((c) => c.name);
        castNote = missing.length ? `no ${missing.join(" or ")}` : "";
        if (!bad && !castNote) {
          note(item, `First frame passed the vision check${cast.length ? ` (${cast.map((c) => c.name).join(", ")} in frame)` : ""}${attempt > 1 ? ` on try ${attempt}` : ""}`);
          best = null;
          break;
        }
        const why = [bad && `showed ${bad}`, castNote].filter(Boolean).join(", ");
        // Writing or a logo is never kept; a missing character or a stray person is, if nothing better comes.
        // A painted border would show as two strips beside the cinema frame: drawn again, kept only if nothing better comes.
        const score = (look.text || look.logo ? -10 : 0) + (look.present?.filter(Boolean).length ?? 0) - (strayPeople ? 2 : 0) - (look.border ? 3 : 0);
        if (!look.text && !look.logo && (!best || score > best.score)) best = { score, res: res!, path: savedPath, why, model: usedModel };
        note(item, `First frame ${attempt} ${why} (${look.notes}); ${attempt < 3 ? "drawing again" : best ? "keeping the closest one" : "giving up"}`);
        if (attempt === 3) {
          if (best) {
            res = best.res;
            savedPath = best.path;
            usedModel = best.model;
            note(item, `Continuity: no clean first frame in three tries; animating the closest (${best.why})`);
            break;
          }
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
          // quote-forge's drip starts vllm-small again in any gap — Montage's turn
          // between two shots is one. Same standing OK as for a waiting clip.
          await freeComfyIfIdle();
          if (s.reclaimVllmSmall && this.runtime.pausedVllmSmall && (await smallModelUp())) {
            const last = this.runtime.lastRepauseAt ? Date.parse(this.runtime.lastRepauseAt) : 0;
            if (Date.now() - last > 2 * 60_000) {
              const err = await manager("stop", "vllm-small");
              this.runtime.lastRepauseAt = stamp();
              this.runtime.repauses = (this.runtime.repauses ?? 0) + 1;
              note(item, err ? `vllm-small came back mid-window; pausing it again failed: ${err}` : "vllm-small came back mid-window (restarted by something else); paused it again");
            }
          }
          if (!item.timeline.some((t) => t.what.startsWith("Waiting for memory"))) {
            note(item, `Waiting for memory: ${why}`);
            await saveItem(item);
          }
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
      item.still = { file: `sources/${file}`, latencyMs: Number(res.body.latency ?? 0), model: usedModel };
      void recordLabRun({
        lab: "forge",
        capability: "image",
        model: usedModel,
        local: !isHostedImageModel(usedModel),
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
      const vm = item.render?.videoModel ?? s.videoModel;
      const tier = item.render?.tier ?? s.tier;
      const secs = item.render?.seconds ?? s.seconds;
      const job = await videoQueue.add({
        model: vm,
        mode: "i2v",
        prompt: item.motionPrompt,
        seconds: secs,
        tier,
        ...(item.render?.steps ? { steps: item.render.steps } : {}),
        sourceImage: item.still.file,
        origin: "forge",
        // The still has no one in it, but the first night's airport clip walked
        // a traveller into the last second. Wan 5B samples with real CFG, so a
        // negative prompt steers it; the channel never shows people or text.
        avoid: item.story || item.variant ? STORY_AVOID : "people, person, human figure, pedestrians, crowd, face, hands, text, letters, words, watermark, logo",
      });
      item.video = { jobId: job.id, model: vm, seconds: secs, tier };
      item.status = "rendering";
      note(item, `Queued the clip (${vm}${item.render?.steps ? `, ${item.render.steps} steps` : ""}, ${secs} s, ${tier})`);
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
          const check = await checkClip(path.join(videoRoot(), ...job.output.split("/")), item.video.seconds ?? s.seconds, s.checkModel || VISION_MODEL);
          if (check) {
            item.check = check;
            note(item, `Vision check: ${[check.people && !item.story && "people", check.text && "writing", check.logo && "a logo", check.artifacts > 1 && "artifacts"].filter(Boolean).join(", ") || "clean"}, beauty ${check.beauty}/5`);
            // Writing or a logo can appear while a clean first frame is animated (a
            // king walked up to a television in the first story night); like a badly
            // distorted clip, a film cannot use it and cannot skip it: draw it again.
            const stray = !!item.story && item.story.humans === false && check.people;
            if (item.story && (check.artifacts >= 3 || check.text || check.logo || stray) && (item.retries ?? 0) < 1) {
              item.retries = (item.retries ?? 0) + 1;
              item.status = "brief";
              item.still = undefined;
              item.video = undefined;
              note(item, `${check.artifacts >= 3 ? "Severely distorted" : stray ? "A person appeared in a story that has none" : "Writing or a logo appeared"} (${check.notes}); drawing and animating this shot once more`);
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
        if (item.story && item.render && item.render.videoModel !== s.videoModel && job.block) {
          item.waitingSince ??= stamp();
          if (Date.now() - Date.parse(item.waitingSince) > 12 * 60_000) {
            await videoQueue.cancel(job.id);
            const why = `${item.render.videoModel} did not get the memory it needs in 12 minutes (${job.block.message}); the rest of "${item.story.title}" is animated by ${s.videoModel}`;
            for (const other of await itemsWithStatus("brief", "still", "rendering")) {
              if (other.story?.id !== item.story.id || !other.render) continue;
              if (other.id !== item.id && other.status === "rendering" && other.video) await videoQueue.cancel(other.video.jobId);
              other.render = undefined;
              other.waitingSince = undefined;
              if (other.status === "rendering") {
                other.status = "still";
                other.video = undefined;
              }
              note(other, why);
              await saveItem(other);
            }
            const st = (await listStories(60)).find((x) => x.id === item.story!.id);
            if (st?.stack) {
              st.stack.fallback = why;
              await saveStory(st);
            }
            this.runtime.now = why;
            return;
          }
          await saveItem(item);
        } else if (item.variant && job.block) {
          item.waitingSince ??= stamp();
          if (Date.now() - Date.parse(item.waitingSince) > 12 * 60_000) {
            await videoQueue.cancel(job.id);
            const why = `${item.variant.label} did not get the memory it needs in 12 minutes (${job.block.message})`;
            for (const other of await itemsWithStatus("brief", "still", "rendering")) {
              if (other.variant?.bakeoffId !== item.variant.bakeoffId || other.variant.key !== item.variant.key) continue;
              if (other.id !== item.id && other.status === "rendering" && other.video) await videoQueue.cancel(other.video.jobId);
              other.status = "failed";
              other.error = why;
              note(other, why);
              await saveItem(other);
            }
            this.runtime.now = why;
            return;
          }
          await saveItem(item);
        } else if ((item.variant || item.story) && item.waitingSince) {
          item.waitingSince = undefined;
        }
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

  /**
   * A bake-off: every shot of a finished story, from its own first frame,
   * queued once per variant (variant after variant, so each model loads once).
   * The window renders them before writing new stories.
   */
  async createBakeoff(storyId: string, variants: Bakeoff["variants"] = DEFAULT_BAKEOFF_VARIANTS): Promise<Bakeoff> {
    const story = (await listStories(200)).find((st) => st.id === storyId);
    if (!story) throw new Error("No such story");
    const base = (await listItems(2000))
      .filter((i) => i.story?.id === storyId && i.still && i.video?.output)
      .sort((a, b) => a.story!.index - b.story!.index);
    if (base.length < story.shots.length) throw new Error(`Only ${base.length} of ${story.shots.length} shots of "${story.title}" are finished`);
    const b: Bakeoff = { id: `bake-${Date.now().toString(36)}`, createdAt: stamp(), storyId, title: story.title, variants };
    await saveBakeoff(b);
    let t = Date.now();
    for (const v of variants) {
      for (const shot of base) {
        const i = shot.story!.index;
        const item: ForgeItem = {
          id: randomUUID().slice(0, 12),
          createdAt: new Date(t++).toISOString(),
          status: "brief",
          channel: "bakeoff",
          topic: `${story.title} — ${v.label} — shot ${i + 1}`,
          whyNow: shot.story!.narration,
          heard: `bake-off "${story.title}" (${v.key})`,
          sources: [],
          stillPrompt: shot.stillPrompt,
          motionPrompt: shot.motionPrompt,
          listen: { heardCount: 0, shortlisted: 0, dropped: [], problems: [] },
          agent: shot.agent,
          still: shot.still,
          group: `${b.id}:${v.key}`,
          shot: i + 1,
          variant: { bakeoffId: b.id, key: v.key, label: v.label, storyId, index: i },
          render: { videoModel: v.videoModel, tier: v.tier },
          timeline: [{ at: stamp(), what: `Bake-off "${story.title}": shot ${i + 1}, the same first frame animated by ${v.label}` }],
        };
        await saveItem(item);
      }
    }
    this.kick();
    return b;
  }

  /** Make one finished shot again from a fresh first frame (keeps its place in the film). */
  async redoShot(id: string, why: string): Promise<ForgeItem> {
    const item = await getItem(id);
    if (!item) throw new Error("No such item");
    if (["brief", "still", "rendering"].includes(item.status)) throw new Error("It is already being made");
    item.status = "brief";
    item.still = undefined;
    item.video = undefined;
    item.check = undefined;
    item.error = undefined;
    item.retries = 1;
    note(item, `To be made again: ${why}`);
    await saveItem(item);
    this.kick();
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
