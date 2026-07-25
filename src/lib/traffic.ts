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
};

const LOG_DIR = process.env.AI_LOGS_DIR || path.join(process.cwd(), "..", "logs");
const RING_MAX = 2000;
const LOG_TAIL_BYTES = 48 * 1024; // parse only the tail of (potentially huge) logs
const LOG_LINES_PER_SERVICE = 200;

// Persist the ring across dev HMR reloads (module re-eval) so live events survive.
const g = globalThis as unknown as { __betenshiTraffic?: TrafficEvent[] };
g.__betenshiTraffic ??= [];
const ring = g.__betenshiTraffic;

export function record(ev: TrafficEvent): void {
  ring.push(ev);
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
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
// `docker logs` instead. `-t` prefixes an RFC3339 timestamp we parse for real
// event times. Extend the map as more containers appear.
const DOCKER_CONTAINERS: Record<string, string> = { vllm: "vllm" };
const UVICORN_TS = /^(\S+)\s+INFO:\s+(\S+?):\d+\s+-\s+"(\w+)\s+(\S+)\s+HTTP\/[\d.]+"\s+(\d{3})/;

async function parseDockerLog(id: string, container: string): Promise<TrafficEvent[]> {
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
    return []; // docker missing / container not running — best-effort
  }
}

// Read everything: the live ring, plus access logs (file or docker) for every
// registered service that ISN'T already reporting live events. That dedup means
// an instrumented, running service supersedes its own access-log tail.
export async function readTraffic(): Promise<{ events: TrafficEvent[]; services: string[] }> {
  const liveServices = new Set(ring.filter((e) => e.source === "live").map((e) => e.service));
  const ids = SERVICE_REGISTRY.map((s) => s.id).filter((id) => !liveServices.has(id));

  const fileEvents = (await Promise.all(ids.map(parseServiceLog))).flat();
  const dockerEvents = (
    await Promise.all(ids.filter((id) => DOCKER_CONTAINERS[id]).map((id) => parseDockerLog(id, DOCKER_CONTAINERS[id])))
  ).flat();

  const all = [...ring, ...fileEvents, ...dockerEvents];
  // Newest first. Events with a real/approx ts sort by it; unknowns sink last.
  all.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));

  const services = [...new Set(all.map((e) => e.service))].sort();
  return { events: all.slice(0, RING_MAX), services };
}
