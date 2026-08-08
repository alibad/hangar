import { readFile, stat } from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import { SERVICE_REGISTRY } from "@/lib/services";

const execFileP = promisify(execFile);

// ── Traffic visibility across the whole BeTenshi stack ───────────────────────
//
// Two sources feed the "Requests" view:
//
//  1. LIVE ring — structured events POSTed to /api/traffic by (a) the console's
//     own middleware for every /api/* hit, and (b) any backend service that
//     opts into request logging (see AGENTS.md). These carry a real timestamp
//     and, for instrumented services, latency.
//
//  2. LOG tail — the uvicorn access log every FastAPI service already writes
//     (AI/logs/<id>.log). Zero-touch, so it covers services that aren't
//     instrumented yet — including ones we can't add code to. No latency, and
//     time is approximated from the file's mtime.
//
// AUTO-WIRING: the log source list is derived from SERVICE_REGISTRY, so adding a
// service there (which you do anyway) + logging to AI/logs/<id>.log is enough to
// make it show up here. Nothing else to touch. See AI/AGENTS.md.

export type TrafficEvent = {
  ts: number | null; // epoch ms; null when unknown (approximated for logs)
  service: string; // service id, or "console"
  method: string;
  path: string;
  status: number | null;
  ms: number | null; // latency; only instrumented sources provide it
  ip: string | null;
  source: "live" | "log";
  /**
   * Which model served the call, and what it cost. Only the AI Router reports
   * these — a single service id ("ai-router") would otherwise collapse GPT,
   * Claude, Gemini and the local models into one indistinguishable row, and
   * spend would be invisible.
   */
  model?: string | null;
  costUsd?: number | null;
  /**
   * Provenance for a billable call: who asked, what they asked for, what it
   * consumed. A row reading only "POST /v1/chat/completions · $0.003" is a
   * charge with no explanation — you can't tell a generator from a runaway loop.
   */
  caller?: string | null;
  prompt?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  error?: string | null;
  /**
   * Set when this event is the DOWNSTREAM half of a call another service in the
   * stack already logged — value is the id of the service that fronted it
   * ("ai-router"). Both ends instrument themselves, so one Qwen image arrived as
   * two near-identical rows and the feed couldn't answer "how many images was
   * that?". The fronting row wins because it carries strictly more (model alias,
   * caller, cost); this half is folded away but kept inspectable.
   */
  /**
   * The service this call was DISPATCHED TO, when the row is a console route
   * that proxies somewhere.
   *
   * `service` names whoever logged the row, which for every console API route is
   * "console" — so a table of them said "console" 56 times and never once said
   * whether the work went to Qwen, to ComfyUI, or off-box to a cloud provider.
   * That is the question the Requests view exists to answer.
   */
  target?: string | null;
  hop?: string | null;
  /**
   * Correlates the "started" event with the "finished" one, so a call can appear
   * the moment it begins instead of materialising minutes later. Without this the
   * feed only ever showed completed work: a 9-minute image generation was
   * invisible for 9 minutes, which reads exactly like nothing is happening.
   */
  rid?: string | null;
  /** Still running — no status or latency yet. Cleared by the finishing event. */
  pending?: boolean;
  /**
   * What the call actually produced. Recorded by the producer at the time, NOT
   * re-fetched: the detail panel's old preview re-requested the URL, which it
   * (correctly) refused to do for a POST — and for an image generation would
   * have meant burning another four minutes of GPU to look at the answer.
   */
  artifact?: { kind: "image"; rel: string } | null;
};

/**
 * How long a row may claim to be running before we call it lost.
 *
 * Reporting is fire-and-forget by design — a dropped event must never slow or
 * fail an inference call — so a busy console (a dev-server recompile is enough)
 * can miss the finishing half of a pair. Observed exactly that: two generations
 * stuck on "running" whose work had long since succeeded. Left alone the row
 * lies indefinitely, which is worse than the missing row we had before.
 *
 * Well past the longest real generation seen here (~17 min), so this only ever
 * catches genuinely lost events, never a slow one.
 */
const STALE_PENDING_MS = 30 * 60 * 1000;

/** Turn an abandoned in-flight row into an honest one. */
function resolveStalePending(e: TrafficEvent, now: number): TrafficEvent {
  if (!e.pending || !e.ts || now - e.ts < STALE_PENDING_MS) return e;
  return {
    ...e,
    pending: false,
    error:
      e.error ??
      "No completion was recorded — the reporting call was dropped. The request itself may well have succeeded.",
  };
}

const LOG_DIR = process.env.AI_LOGS_DIR || path.join(process.cwd(), "..", "logs");
const RING_MAX = 2000;
const POLL_RING_MAX = 300;
const LOG_TAIL_BYTES = 48 * 1024; // parse only the tail of (potentially huge) logs
const LOG_LINES_PER_SERVICE = 200;

/**
 * Background chatter — everything the machine does on its own rather than
 * something a person or a job actually asked for. Two kinds:
 *
 *  1. POLLING: health probes, status endpoints, progress ticks.
 *  2. ASSETS: gallery thumbnails. Not polling, but opening the Activity grid
 *     fires one request per tile, which buries real traffic just as effectively.
 *
 * Matched on PATH ONLY, so it holds for any service — the Qwen studio polls
 * `/progress` once a second during a generation and those arrive tagged
 * `service: "qwen"`, not "console", so a console-scoped rule never caught them.
 *
 * GET-only by construction: a POST is always someone doing something.
 */
const NOISE_PATHS = [
  // polling
  /^\/health(\/|$)/,          // incl. litellm /health/liveliness|readiness
  /^\/healthz$/,
  /^\/-\/healthy$/,
  /^\/progress$/,
  /^\/gpu$/,                  // whisper/tts expose their own GPU-status probe
  /^\/metrics$/,
  /^\/models$/,
  /^\/v1\/models$/,
  /^\/system_stats$/,
  /^\/services$/,
  /^\/api\/(health|gpu|metrics|services|resources|routing|llm|providers|traffic)$/,
  // Static metadata read on mount by both the studio and the compare view.
  /^\/api\/(footprints|model-meta)$/,
  /^\/api\/qwen\/(health|progress|archive|images|jobs|jobs\/status)$/,
  /^\/api\/(sam3d|sam3)\/health$/,
  // assets — one request per gallery tile
  /^\/api\/qwen\/archive\/file$/,
  /^\/api\/qwen\/images\/file$/,
];

/** Is this event background chatter rather than real work? */
export function isNoise(ev: { method: string; path: string }): boolean {
  if (ev.method !== "GET") return false;
  const p = ev.path.split("?")[0]; // query carries the asset id, not the identity
  return NOISE_PATHS.some((re) => re.test(p));
}

// Persist across dev HMR reloads (module re-eval) so live events survive.
const g = globalThis as unknown as {
  __betenshiTraffic?: TrafficEvent[];
  __betenshiNoise?: TrafficEvent[];
  __betenshiHops?: TrafficEvent[];
};
g.__betenshiTraffic ??= [];
g.__betenshiNoise ??= [];
g.__betenshiHops ??= [];
const ring = g.__betenshiTraffic;
/**
 * Noise gets its OWN small ring. Sharing the main one meant a 70-second image
 * generation — one `/progress` tick per second — or a single scroll through the
 * gallery could evict real requests from a 2000-event buffer. Keeping them apart
 * means the feed you care about has a fixed capacity that chatter can never
 * consume, while recent noise stays inspectable on demand.
 */
const noiseRing = g.__betenshiNoise;
/**
 * Downstream halves of router calls. Their own ring for the same reason noise
 * has one: they arrive 1:1 with real calls, so leaving them in the main ring
 * would halve its effective capacity to hold nothing new.
 */
const hopRing = g.__betenshiHops;

/**
 * Which bucket an event belongs in.
 *
 * A hop that is STILL RUNNING stays in the main feed. LiteLLM's async image path
 * never fires a pre-call hook — verified in `llms/openai/openai.py`, where
 * `aimage_generation` calls `post_call` only — so the router cannot announce an
 * image generation until it has already finished. While one is in flight the
 * downstream row is the ONLY evidence the work is happening, and folding it away
 * is what made a busy GPU look like an idle box. Once it completes the router's
 * richer row supersedes it and this one folds. Either way: one row at a time.
 */
function targetRing(ev: TrafficEvent): TrafficEvent[] {
  if (isNoise(ev)) return noiseRing; // a health probe via the router is still noise
  if (ev.hop && !ev.pending) return hopRing;
  return ring;
}

function push(target: TrafficEvent[], ev: TrafficEvent): void {
  target.push(ev);
  const max = target === ring ? RING_MAX : POLL_RING_MAX;
  if (target.length > max) target.splice(0, target.length - max);
}

/**
 * How far apart the two halves of one call may be and still be the same call.
 * They are emitted within milliseconds of each other; this is slack, not a guess.
 */
const HOP_PAIR_WINDOW_MS = 10_000;

/**
 * Move a finished hop's artifact up onto the row that will actually be shown.
 *
 * Only the downstream service knows what it produced (Qwen writes the PNG); only
 * the upstream row is visible (it carries model, caller and cost). Without this
 * the generated image is attached to the one row the feed hides — so opening the
 * visible row still answered "no response recorded".
 *
 * The two events share no id: LiteLLM offers no way to inject a per-call header
 * from static config, so there is nothing deterministic to join on. Matching on
 * service + path + a 10s window is safe HERE specifically because generation is
 * serialised on one GPU — two image calls cannot complete concurrently — and the
 * hop always completes just before the router row it belongs to.
 */
function pairs(a: TrafficEvent, b: TrafficEvent): boolean {
  return (
    a.path === b.path &&
    !!a.ts &&
    !!b.ts &&
    Math.abs(a.ts - b.ts) <= HOP_PAIR_WINDOW_MS
  );
}

/** Upstream row arrived last: take the artifact off the hop already recorded. */
function adoptHopArtifact(ev: TrafficEvent): TrafficEvent {
  if (ev.artifact || ev.pending || !ev.ts) return ev;
  for (let i = hopRing.length - 1; i >= 0; i--) {
    const h = hopRing[i];
    if (h.artifact && h.hop === ev.service && pairs(h, ev)) return { ...ev, artifact: h.artifact };
  }
  return ev;
}

/**
 * Hop arrived last: push its artifact onto the upstream row already sitting in
 * the feed.
 *
 * Both directions are needed because the two events race. Qwen posts its
 * completion from a daemon thread while uvicorn is still handing the response
 * back to the router, so which one reaches the console first is not decided by
 * anything we control — and in practice the router consistently won, leaving
 * every visible row without its image.
 */
function backfillUpstream(hopEv: TrafficEvent): void {
  if (!hopEv.artifact || hopEv.pending) return;
  for (let i = ring.length - 1; i >= 0; i--) {
    const up = ring[i];
    if (!up.artifact && up.service === hopEv.hop && pairs(up, hopEv)) {
      ring[i] = { ...up, artifact: hopEv.artifact };
      return;
    }
  }
}

/**
 * Fold a later event into the row that already exists for its rid.
 *
 * Producers are fire-and-forget — the Qwen service posts each event from its own
 * daemon thread — so events for one call can arrive OUT OF ORDER and can be
 * PARTIAL: a handler enriching a running row sends little more than the prompt.
 * A blind spread broke on both counts. Nulls would erase a status that had
 * already landed, and a late "still running" event would drag a finished row
 * back to running and leave it there.
 *
 * So: only fields the newer event actually carries win, and a row that has
 * settled never reopens.
 */
function mergeById(prev: TrafficEvent, ev: TrafficEvent): TrafficEvent {
  const out = { ...prev } as Record<string, unknown>;
  for (const [k, v] of Object.entries(ev)) {
    if (v === null || v === undefined) continue; // absent, not "cleared"
    out[k] = v;
  }
  const merged = out as unknown as TrafficEvent;
  merged.ts = prev.ts ?? ev.ts; // keep its place in the feed
  merged.pending = prev.pending === false ? false : (ev.pending ?? false);
  return merged;
}

export function record(rawEv: TrafficEvent): void {
  const ev = rawEv.hop ? rawEv : adoptHopArtifact(rawEv);
  if (ev.hop) backfillUpstream(ev);
  const target = targetRing(ev);

  // A finishing event REPLACES its own in-flight row rather than adding a second
  // one — otherwise every call shows up twice, the bug just removed for hops.
  // Search EVERY ring, not just the destination: a running hop lives in the main
  // feed and moves to the hop ring when it completes, so looking only in the
  // destination would miss it and strand the original row on "running" forever.
  // The original timestamp is kept so a row doesn't jump position on completion.
  if (ev.rid) {
    for (const r of [ring, hopRing, noiseRing]) {
      const i = r.findIndex((e) => e.rid === ev.rid);
      if (i === -1) continue;
      const merged = mergeById(r[i], ev);
      r.splice(i, 1);
      push(target, merged);
      return;
    }
  }

  push(target, ev);
}

// uvicorn access line: `INFO:     127.0.0.1:52341 - "POST /path HTTP/1.1" 200 OK`
const UVICORN = /^INFO:\s+(\S+?):\d+\s+-\s+"(\w+)\s+(\S+)\s+HTTP\/[\d.]+"\s+(\d{3})/;

async function readTail(file: string, bytes: number): Promise<string | null> {
  try {
    const s = await stat(file);
    const start = Math.max(0, s.size - bytes);
    // Read the whole file only when it's small; otherwise slice the tail.
    const buf = await readFile(file);
    return buf.subarray(start).toString("utf8");
  } catch {
    return null;
  }
}

async function parseServiceLog(id: string): Promise<TrafficEvent[]> {
  const text = await readTail(path.join(LOG_DIR, `${id}.log`), LOG_TAIL_BYTES);
  if (!text) return [];
  let approxTs: number | null = null;
  try {
    approxTs = (await stat(path.join(LOG_DIR, `${id}.log`))).mtimeMs;
  } catch {
    /* ignore */
  }
  const events: TrafficEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = UVICORN.exec(line);
    if (!m) continue;
    events.push({
      ts: approxTs,
      service: id,
      method: m[2],
      path: m[3],
      status: Number(m[4]),
      ms: null,
      ip: m[1],
      source: "log",
    });
  }
  // Newest last in the file → keep the most recent slice.
  return events.slice(-LOG_LINES_PER_SERVICE);
}

// Containerized services have no AI/logs file — read their request lines from
// `docker logs` instead. A service maps to SEVERAL candidate container names,
// because vLLM's container gets renamed across compose revisions (currently
// vllm-coder / vllm-server) — the first candidate that yields request lines wins.
// `-t` prefixes an RFC3339 timestamp we parse for real event times.
const DOCKER_CONTAINERS: Record<string, string[]> = {
  vllm: ["vllm-server", "vllm-coder", "vllm"],
};
const UVICORN_TS = /^(\S+)\s+INFO:\s+(\S+?):\d+\s+-\s+"(\w+)\s+(\S+)\s+HTTP\/[\d.]+"\s+(\d{3})/;

async function parseDockerContainer(id: string, container: string): Promise<TrafficEvent[]> {
  try {
    const { stdout, stderr } = await execFileP("docker", ["logs", "-t", "--tail", "400", container], {
      timeout: 4000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    const events: TrafficEvent[] = [];
    for (const line of `${stdout}\n${stderr}`.split(/\r?\n/)) {
      const m = UVICORN_TS.exec(line);
      if (!m) continue;
      const t = Date.parse(m[1]);
      events.push({
        ts: Number.isNaN(t) ? null : t,
        service: id, method: m[3], path: m[4], status: Number(m[5]), ms: null, ip: m[2], source: "log",
      });
    }
    return events.slice(-LOG_LINES_PER_SERVICE);
  } catch {
    return []; // container missing / docker unavailable — best-effort
  }
}

async function parseDockerLog(id: string, containers: string[]): Promise<TrafficEvent[]> {
  for (const c of containers) {
    const ev = await parseDockerContainer(id, c);
    if (ev.length) return ev;
  }
  return [];
}

// Log-only sources that aren't full dashboard services (so they don't get a
// health-check card in the Services tab), but whose access logs we still want in
// the feed — e.g. the manager control API at AI/logs/manager.log.
const EXTRA_LOG_SERVICES = ["manager"];

// Dashboard self-polling paths — dropped from the feed (see middleware.ts). Kept
// in sync with the set there; filtered here too so any already sitting in the
// ring don't crowd out real traffic.
const DASHBOARD_POLLS = new Set([
  "/api/health", "/api/gpu", "/api/metrics", "/api/services", "/api/resources", "/api/routing", "/api/llm",
  "/api/qwen/health", "/api/qwen/progress", "/api/qwen/archive", "/api/qwen/images", "/api/qwen/prompts",
  "/api/sam3d/health", "/api/sam3/health", "/api/providers",
]);

// Read everything: the live ring, plus access logs (file or docker) for every
// registered service that ISN'T already reporting live events. That dedup means
// an instrumented, running service supersedes its own access-log tail.
export async function readTraffic(): Promise<{
  events: TrafficEvent[];
  noise: TrafficEvent[];
  noiseCount: number;
  hops: TrafficEvent[];
  hopCount: number;
  services: string[];
}> {
  const liveServices = new Set(ring.filter((e) => e.source === "live").map((e) => e.service));
  const ids = [...SERVICE_REGISTRY.map((s) => s.id), ...EXTRA_LOG_SERVICES].filter((id) => !liveServices.has(id));

  const fileEvents = (await Promise.all(ids.map(parseServiceLog))).flat();
  const dockerEvents = (
    await Promise.all(ids.filter((id) => DOCKER_CONTAINERS[id]).map((id) => parseDockerLog(id, DOCKER_CONTAINERS[id])))
  ).flat();

  const merged = [...ring, ...fileEvents, ...dockerEvents].filter(
    (e) => !(e.service === "console" && e.method === "GET" && DASHBOARD_POLLS.has(e.path)),
  );

  // Log-derived events skip record(), so they're classified here — otherwise a
  // service's own access log would re-introduce exactly the /health and
  // /progress flood the live path already keeps out.
  const real: TrafficEvent[] = [];
  const noisy: TrafficEvent[] = [...noiseRing];
  const hops: TrafficEvent[] = [...hopRing];
  // Same rule as record(): a running hop belongs in the main feed.
  for (const e of merged) (isNoise(e) ? noisy : e.hop && !e.pending ? hops : real).push(e);

  // Settling happens at read time, not on ingest: whether a pending row is stale
  // is a function of "how long ago", which only has an answer when asked.
  const now = Date.now();
  const byNewest = (a: TrafficEvent, b: TrafficEvent) => (b.ts ?? 0) - (a.ts ?? 0);
  const settle = (arr: TrafficEvent[]) =>
    arr.map((e) => resolveStalePending(e, now)).sort(byNewest);

  const realOut = settle(real);
  const noisyOut = settle(noisy);
  const hopsOut = settle(hops);

  // Service filter options come from ALL THREE, so a service that only ever
  // polls, or only ever appears downstream of the router, doesn't vanish from
  // the dropdown.
  const services = [...new Set([...realOut, ...noisyOut, ...hopsOut].map((e) => e.service))].sort();

  return {
    events: realOut.slice(0, RING_MAX),
    noise: noisyOut.slice(0, POLL_RING_MAX),
    noiseCount: noisyOut.length,
    hops: hopsOut.slice(0, POLL_RING_MAX),
    hopCount: hopsOut.length,
    services,
  };
}
