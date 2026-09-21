/**
 * Durable request history.
 *
 * ── WHY ─────────────────────────────────────────────────────────────────────
 * The Requests feed was an in-process ring (`globalThis.__hangarTraffic`, 2000
 * events). Restart the console and every row is gone. The 2026-09-21 audit
 * opened Requests on a machine that had generated images the previous evening
 * and was told "No requests captured" — which reads as "this box does nothing"
 * rather than "the console was restarted since".
 *
 * Only ROUTER calls were ever persisted, into `router_calls`. That table is
 * about spend: it requires a model and it skips anything the router did not
 * price. A Mac has no router, so on this machine nothing was persisted at all,
 * and the Usage tab correctly but uselessly reported "No router calls
 * recorded yet" forever.
 *
 * This is the other half: every meaningful call, router or not, with what it
 * asked for and what it produced.
 *
 * ── WHAT IS AND IS NOT KEPT ─────────────────────────────────────────────────
 * Noise (health probes, progress ticks, gallery thumbnails) is never written —
 * it is the majority of traffic by count and none of it by interest, and the
 * ring already separates it. Prompts and responses ARE written, clipped, because
 * a request feed that cannot show you what a call said cannot answer the only
 * question people bring to it. They live in the same local DuckDB file as
 * everything else on this box and never leave it.
 */

import { getDb, type Db } from "./db";
import { isNoise, type TrafficEvent } from "./traffic";

/** Matches the ring's clip, so a row reads identically from either source. */
const TEXT_MAX = 8000;

/**
 * How much history to keep.
 *
 * Time-bounded rather than row-bounded: "the last fortnight" is a sentence a
 * person can reason about, where "the last 2000 events" silently means four
 * hours on a busy day and three weeks on a quiet one.
 */
const RETAIN_DAYS = 14;

let ensured: Promise<Db> | null = null;

async function db(): Promise<Db> {
  if (!ensured) {
    ensured = (async () => {
      const handle = await getDb();
      await handle.run(`CREATE TABLE IF NOT EXISTS traffic_events (
        key TEXT PRIMARY KEY,
        ts BIGINT NOT NULL,
        service TEXT NOT NULL,
        target TEXT,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        status INTEGER,
        ms INTEGER,
        model TEXT,
        caller TEXT,
        prompt TEXT,
        response TEXT,
        tokens_in BIGINT,
        tokens_out BIGINT,
        cost_usd DOUBLE,
        artifact_rel TEXT,
        error TEXT
      )`);
      return handle;
    })().catch((err) => {
      ensured = null; // let a later request retry rather than wedging forever
      throw err;
    });
  }
  return ensured;
}

/** Stable id for one call, so the started/finished pair collapses to one row. */
function keyFor(ev: TrafficEvent, ts: number): string {
  return ev.rid ? `rid:${ev.rid}` : `syn:${ts}:${ev.method}:${ev.path}`.slice(0, 200);
}

/**
 * Persist one event. Fire-and-forget at every call site: a history write must
 * never slow down or fail the request it describes.
 *
 * Upserts rather than inserts, because a call arrives twice — once `pending`
 * when it starts and once complete. The second carries the status, latency and
 * artifact, so it must overwrite rather than be dropped by ON CONFLICT.
 */
export async function recordTrafficEvent(ev: TrafficEvent): Promise<void> {
  // Downstream halves duplicate a row the fronting service already logged.
  if (ev.hop) return;
  if (isNoise(ev)) return;
  // Log-tailed rows are reconstructed from access logs and carry no latency,
  // status or body. They are already derivable from the files they came from.
  if (ev.source === "log") return;

  const ts = ev.ts ?? Date.now();
  const handle = await db();
  const clip = (v: string | null | undefined) => (v == null ? null : String(v).slice(0, TEXT_MAX));

  await handle.run(
    `INSERT INTO traffic_events VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (key) DO UPDATE SET
       status = COALESCE(excluded.status, traffic_events.status),
       ms = COALESCE(excluded.ms, traffic_events.ms),
       model = COALESCE(excluded.model, traffic_events.model),
       response = COALESCE(excluded.response, traffic_events.response),
       tokens_in = COALESCE(excluded.tokens_in, traffic_events.tokens_in),
       tokens_out = COALESCE(excluded.tokens_out, traffic_events.tokens_out),
       cost_usd = COALESCE(excluded.cost_usd, traffic_events.cost_usd),
       artifact_rel = COALESCE(excluded.artifact_rel, traffic_events.artifact_rel),
       error = COALESCE(excluded.error, traffic_events.error)`,
    [
      keyFor(ev, ts),
      ts,
      ev.service,
      ev.target ?? null,
      ev.method,
      ev.path,
      ev.status ?? null,
      ev.ms ?? null,
      ev.model ?? null,
      ev.caller ?? null,
      clip(ev.prompt),
      clip(ev.response),
      ev.tokensIn ?? null,
      ev.tokensOut ?? null,
      ev.costUsd ?? null,
      ev.artifact?.rel ?? null,
      ev.error ? String(ev.error).slice(0, 400) : null,
    ],
  );
}

/**
 * Recent history, newest first — what the feed shows before anything new has
 * happened in this process.
 */
export async function readStoredTraffic(limit = 500): Promise<TrafficEvent[]> {
  const handle = await db();
  const rows = await handle.all<{
    ts: bigint | number; service: string; target: string | null; method: string; path: string;
    status: number | null; ms: number | null; model: string | null; caller: string | null;
    prompt: string | null; response: string | null; tokens_in: bigint | number | null;
    tokens_out: bigint | number | null; cost_usd: number | null; artifact_rel: string | null; error: string | null;
  }>(`SELECT * FROM traffic_events ORDER BY ts DESC LIMIT ${Math.max(1, Math.min(5000, limit))}`);

  const num = (v: bigint | number | null) => (v == null ? null : Number(v));
  return rows.map((r) => ({
    ts: Number(r.ts),
    service: r.service,
    target: r.target,
    method: r.method,
    path: r.path,
    status: r.status,
    ms: r.ms,
    ip: null,
    // "stored" would be a third source the UI has to learn about. These rows
    // were live when they were written, and are the same shape; the only
    // difference that matters is that they survived a restart.
    source: "live" as const,
    model: r.model,
    caller: r.caller,
    prompt: r.prompt,
    response: r.response,
    tokensIn: num(r.tokens_in),
    tokensOut: num(r.tokens_out),
    costUsd: r.cost_usd,
    artifact: r.artifact_rel ? ({ kind: "image" as const, rel: r.artifact_rel }) : null,
    error: r.error,
  }));
}

/** Drop rows past the retention window. Called opportunistically on read. */
export async function pruneTraffic(): Promise<void> {
  const handle = await db();
  await handle.run(`DELETE FROM traffic_events WHERE ts < ?`, [Date.now() - RETAIN_DAYS * 86_400_000]);
}
