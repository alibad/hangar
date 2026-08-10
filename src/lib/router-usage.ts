/**
 * Durable record of every call the AI Router served.
 *
 * The router already measures the right things — `config/router_callback.py`
 * reports model, tokens, cost and latency for local *and* cloud calls. But the
 * only thing downstream of it was a 2000-event in-memory ring, so the numbers
 * were gone on restart and nothing could answer "how much work did this box do
 * last week". This persists them into the duckdb the console already owns.
 *
 * Local vs cloud comes from the router's own naming convention: aliases served
 * off this box are prefixed `local-` and carry a localhost `api_base` in
 * config/ai-router.yaml (local-coder, local-small, local-whisper, local-kokoro,
 * local-qwen-image). Cloud aliases are the bare vendor name.
 */
import { getDb, type Db } from "@/lib/db";
import type { TrafficEvent } from "@/lib/traffic";

export const isLocalModel = (model: string | null | undefined): boolean =>
  typeof model === "string" && model.startsWith("local-");

let ensured: Promise<Db> | null = null;

async function db(): Promise<Db> {
  if (!ensured) {
    ensured = (async () => {
      const handle = await getDb();
      await handle.run(`CREATE TABLE IF NOT EXISTS router_calls (
        key TEXT PRIMARY KEY,
        ts BIGINT NOT NULL,
        model TEXT NOT NULL,
        is_local BOOLEAN NOT NULL,
        caller TEXT,
        path TEXT,
        status INTEGER,
        ms INTEGER,
        tokens_in BIGINT,
        tokens_out BIGINT,
        cost_usd DOUBLE,
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

/**
 * Persist one router call. Fire-and-forget: a logging write must never delay or
 * fail the traffic ingest that carries it.
 */
export async function recordRouterCall(ev: TrafficEvent): Promise<void> {
  // Only calls the router actually priced. `hop` marks the downstream half of a
  // call the router already logged — persisting it would double every row.
  if (!ev.model || ev.hop) return;

  const ts = ev.ts ?? Date.now();
  // rid is the router's own request id; fall back to a content key so a missing
  // rid can't turn retries into duplicate rows.
  const key = ev.rid
    ? `rid:${ev.rid}`
    : `syn:${ts}:${ev.model}:${ev.tokensIn ?? ""}:${ev.tokensOut ?? ""}`;

  const handle = await db();
  await handle.run(
    `INSERT INTO router_calls VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
    [
      key,
      ts,
      ev.model,
      isLocalModel(ev.model),
      ev.caller ?? null,
      ev.path ?? null,
      ev.status ?? null,
      ev.ms ?? null,
      ev.tokensIn ?? null,
      ev.tokensOut ?? null,
      ev.costUsd ?? null,
      ev.error ?? null,
    ],
  );
}

export type Granularity = "hour" | "day" | "week" | "month" | "quarter" | "year";
export const GRANULARITIES: Granularity[] = ["hour", "day", "week", "month", "quarter", "year"];

// duckdb strftime formats per bucket. Week uses ISO year-week so it lines up
// with the Claude view's ISO weeks rather than drifting by a day.
const FORMATS: Record<Granularity, string> = {
  hour: "%Y-%m-%dT%H",
  day: "%Y-%m-%d",
  week: "%G-W%V",
  month: "%Y-%m",
  quarter: "%Y",
  year: "%Y",
};

export type RouterBucket = {
  period: string;
  label: string;
  calls: number;
  localCalls: number;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  localCost: number;
  avgMs: number | null;
  errors: number;
};

export type RouterSnapshot = {
  generatedAt: string;
  granularities: Record<Granularity, RouterBucket[]>;
  models: Array<{
    model: string;
    isLocal: boolean;
    calls: number;
    tokensIn: number;
    tokensOut: number;
    cost: number;
    avgMs: number | null;
    errors: number;
  }>;
  callers: Array<{ caller: string; calls: number; cost: number; tokensOut: number }>;
  totals: {
    calls: number;
    localCalls: number;
    tokensIn: number;
    tokensOut: number;
    cost: number;
    localTokensOut: number;
    errors: number;
  };
  span: { earliest: number | null; latest: number | null };
};

const n = (v: unknown): number => (v == null ? 0 : Number(v));

function labelFor(gran: Granularity, period: string, row: Record<string, unknown>): string {
  if (gran === "hour") return `${period.slice(5, 10)} ${period.slice(11)}:00`;
  if (gran === "day") return period.slice(5);
  if (gran === "quarter") return `${period} Q${n(row.q)}`;
  return period;
}

export async function buildRouterSnapshot(): Promise<RouterSnapshot> {
  const handle = await db();

  const granularities = {} as Record<Granularity, RouterBucket[]>;
  for (const gran of GRANULARITIES) {
    // Quarter has no strftime token, so bucket by year plus an explicit quarter
    // column and fold them into one period key below.
    const quarterCol = gran === "quarter" ? `, CAST(FLOOR((EXTRACT(month FROM t) - 1) / 3) + 1 AS INTEGER) AS q` : "";
    const groupExtra = gran === "quarter" ? ", q" : "";
    const rows = await handle.all<Record<string, unknown>>(
      `WITH c AS (SELECT *, to_timestamp(ts / 1000) AS t FROM router_calls)
       SELECT strftime(t, '${FORMATS[gran]}') AS period${quarterCol},
              COUNT(*) AS calls,
              SUM(CASE WHEN is_local THEN 1 ELSE 0 END) AS local_calls,
              SUM(COALESCE(tokens_in, 0)) AS tokens_in,
              SUM(COALESCE(tokens_out, 0)) AS tokens_out,
              SUM(COALESCE(cost_usd, 0)) AS cost,
              SUM(CASE WHEN is_local THEN COALESCE(cost_usd, 0) ELSE 0 END) AS local_cost,
              AVG(ms) AS avg_ms,
              SUM(CASE WHEN error IS NOT NULL OR (status IS NOT NULL AND status >= 400) THEN 1 ELSE 0 END) AS errors
       FROM c GROUP BY period${groupExtra} ORDER BY period${groupExtra}`,
    );
    granularities[gran] = rows.map((r) => {
      const period = gran === "quarter" ? `${String(r.period)}-Q${n(r.q)}` : String(r.period);
      return {
        period,
        label: labelFor(gran, String(r.period), r),
        calls: n(r.calls),
        localCalls: n(r.local_calls),
        tokensIn: n(r.tokens_in),
        tokensOut: n(r.tokens_out),
        cost: n(r.cost),
        localCost: n(r.local_cost),
        avgMs: r.avg_ms == null ? null : Math.round(n(r.avg_ms)),
        errors: n(r.errors),
      };
    });
  }

  const modelRows = await handle.all<Record<string, unknown>>(
    `SELECT model, ANY_VALUE(is_local) AS is_local, COUNT(*) AS calls,
            SUM(COALESCE(tokens_in,0)) AS tokens_in, SUM(COALESCE(tokens_out,0)) AS tokens_out,
            SUM(COALESCE(cost_usd,0)) AS cost, AVG(ms) AS avg_ms,
            SUM(CASE WHEN error IS NOT NULL OR (status IS NOT NULL AND status >= 400) THEN 1 ELSE 0 END) AS errors
     FROM router_calls GROUP BY model ORDER BY calls DESC`,
  );

  const callerRows = await handle.all<Record<string, unknown>>(
    `SELECT COALESCE(caller, '(unknown)') AS caller, COUNT(*) AS calls,
            SUM(COALESCE(cost_usd,0)) AS cost, SUM(COALESCE(tokens_out,0)) AS tokens_out
     FROM router_calls GROUP BY caller ORDER BY calls DESC LIMIT 12`,
  );

  const totalRow = await handle.get<Record<string, unknown>>(
    `SELECT COUNT(*) AS calls, SUM(CASE WHEN is_local THEN 1 ELSE 0 END) AS local_calls,
            SUM(COALESCE(tokens_in,0)) AS tokens_in, SUM(COALESCE(tokens_out,0)) AS tokens_out,
            SUM(COALESCE(cost_usd,0)) AS cost,
            SUM(CASE WHEN is_local THEN COALESCE(tokens_out,0) ELSE 0 END) AS local_tokens_out,
            SUM(CASE WHEN error IS NOT NULL OR (status IS NOT NULL AND status >= 400) THEN 1 ELSE 0 END) AS errors,
            MIN(ts) AS earliest, MAX(ts) AS latest
     FROM router_calls`,
  );

  return {
    generatedAt: new Date().toISOString(),
    granularities,
    models: modelRows.map((r) => ({
      model: String(r.model),
      isLocal: Boolean(r.is_local),
      calls: n(r.calls),
      tokensIn: n(r.tokens_in),
      tokensOut: n(r.tokens_out),
      cost: n(r.cost),
      avgMs: r.avg_ms == null ? null : Math.round(n(r.avg_ms)),
      errors: n(r.errors),
    })),
    callers: callerRows.map((r) => ({
      caller: String(r.caller),
      calls: n(r.calls),
      cost: n(r.cost),
      tokensOut: n(r.tokens_out),
    })),
    totals: {
      calls: n(totalRow?.calls),
      localCalls: n(totalRow?.local_calls),
      tokensIn: n(totalRow?.tokens_in),
      tokensOut: n(totalRow?.tokens_out),
      cost: n(totalRow?.cost),
      localTokensOut: n(totalRow?.local_tokens_out),
      errors: n(totalRow?.errors),
    },
    span: {
      earliest: totalRow?.earliest == null ? null : n(totalRow.earliest),
      latest: totalRow?.latest == null ? null : n(totalRow.latest),
    },
  };
}
