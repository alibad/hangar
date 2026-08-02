import type { NextRequest } from "next/server";
import { record } from "./traffic";

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
export const TARGET_HEADER = "x-betenshi-target";

export function withTraffic(
  handler: (req: NextRequest) => Promise<Response>,
): (req: NextRequest) => Promise<Response> {
  return async (req: NextRequest) => {
    const t0 = Date.now();
    const res = await handler(req);
    const target = res.headers.get(TARGET_HEADER);
    if (target) res.headers.delete(TARGET_HEADER);
    try {
      const ip =
        req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
        req.headers.get("x-real-ip") ||
        null;
      record({
        ts: Date.now(),
        service: "console",
        method: req.method,
        path: req.nextUrl.pathname + req.nextUrl.search,
        status: res.status,
        ms: Date.now() - t0,
        ip,
        source: "live",
        target,
        // Callers outside the console (quote-forge, scripts) identify themselves
        // with X-Source. Without it the `from` column can only say "localhost",
        // which is true of literally every request on this box.
        caller: req.headers.get("x-source"),
      });
    } catch {
      /* logging must never break the response */
    }
    return res;
  };
}
