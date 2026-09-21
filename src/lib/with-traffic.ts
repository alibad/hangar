import type { NextRequest } from "next/server";
import { record } from "./traffic";
import { recordTrafficEvent } from "./traffic-store";

// Wrap a console route handler so its response STATUS + latency land in the
// traffic ring. The edge middleware can't see the response, so routes we care
// about (currently the qwen generate/edit proxies) self-report here instead.
// Any path wrapped with this MUST be added to the skip list in middleware.ts so
// it isn't also logged (status-less) by the middleware.
/**
 * Header a handler sets to say where it actually sent the work.
 *
 * A response header rather than an argument because the target is only known
 * INSIDE the handler — /api/image/generate dispatches to Qwen, ComfyUI or the
 * router depending on the `model` in the body it just parsed. Stripped before
 * the response leaves, so it never reaches the browser.
 */
export const TARGET_HEADER = "x-hangar-target";

/**
 * What a call actually did, beyond its status code.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * Until 2026-09-21 these fields were populated by exactly one thing: LiteLLM's
 * callback in the AI Router. So on a machine with a router the feed could tell
 * you which model answered, what it was asked and what it said — and on a
 * machine without one (every Mac here) those columns were permanently null.
 * The audit's chat row read `target: ollama, 200, 6996 ms` and nothing else,
 * though the route had the model, the prompt, the answer and the token counts
 * in hand as it returned them to the browser.
 *
 * The detail panel then compounded it: with nothing stored, its only trick was
 * to re-fetch the URL, which it correctly refuses to do for a POST. So every
 * image and every chat said "Not previewed — re-sending a POST could repeat the
 * action", and the feed could not answer the one question it exists for.
 */
export type CallDetail = {
  model?: string | null;
  prompt?: string | null;
  response?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costUsd?: number | null;
  /** What the call produced, as a path inside the image store. */
  artifact?: { kind: "image"; rel: string } | null;
  error?: string | null;
};

/**
 * Keyed by the request object rather than passed through the handler's return.
 *
 * A handler's job is to produce a Response; threading a second value out of it
 * would change every signature and every call site. A WeakMap keyed on the
 * request that is already in scope costs the handler one line and nobody else
 * anything, and the entry is collected with the request.
 */
const DETAIL = new WeakMap<object, CallDetail>();

/**
 * Called by a route handler to say what its call did. Merges, so a handler can
 * describe the request early and the response later.
 */
export function describeCall(req: NextRequest, detail: CallDetail): void {
  DETAIL.set(req, { ...DETAIL.get(req), ...detail });
}

export function withTraffic<Args extends unknown[]>(
  handler: (req: NextRequest, ...args: Args) => Promise<Response>,
): (req: NextRequest, ...args: Args) => Promise<Response> {
  return async (req: NextRequest, ...args: Args) => {
    const t0 = Date.now();
    const res = await handler(req, ...args);
    const servicePath = /^\/api\/services\/([^/]+)/.exec(req.nextUrl.pathname);
    const target = res.headers.get(TARGET_HEADER) ?? servicePath?.[1] ?? null;
    if (target) res.headers.delete(TARGET_HEADER);
    try {
      const ip =
        req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
        req.headers.get("x-real-ip") ||
        null;
      const detail = DETAIL.get(req) ?? {};
      const event = {
        ts: Date.now(),
        service: "console" as const,
        method: req.method,
        path: req.nextUrl.pathname + req.nextUrl.search,
        status: res.status,
        ms: Date.now() - t0,
        ip,
        source: "live" as const,
        target,
        // Callers outside the console (quote-forge, scripts) identify themselves
        // with X-Source. Without it the `from` column can only say "localhost",
        // which is true of literally every request on this box.
        caller: req.headers.get("x-source"),
        ...detail,
      };
      record(event);
      // Durable copy. Deliberately not awaited: the ring is the live feed and
      // must stay fast, and a DuckDB hiccup must never fail the response.
      void recordTrafficEvent(event).catch(() => {});
    } catch {
      /* logging must never break the response */
    }
    return res;
  };
}
