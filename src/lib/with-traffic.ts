import type { NextRequest } from "next/server";
import { record } from "./traffic";

// Wrap a console route handler so its response STATUS + latency land in the
// traffic ring. The edge middleware can't see the response, so routes we care
// about (currently the qwen generate/edit proxies) self-report here instead.
// Any path wrapped with this MUST be added to the skip list in middleware.ts so
// it isn't also logged (status-less) by the middleware.
export function withTraffic(
  handler: (req: NextRequest) => Promise<Response>,
): (req: NextRequest) => Promise<Response> {
  return async (req: NextRequest) => {
    const t0 = Date.now();
    const res = await handler(req);
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
      });
    } catch {
      /* logging must never break the response */
    }
    return res;
  };
}
