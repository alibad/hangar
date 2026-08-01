import { NextResponse, type NextRequest } from "next/server";

// The dashboard polls these constantly to refresh itself — that's the console
// observing itself, not real traffic, and it would otherwise flood the feed and
// crowd out real requests. Skip them at ingest (GET only). Keep this in sync with
// the same list in lib/traffic.ts (edge middleware can't import that Node module).
const DASHBOARD_POLLS = new Set([
  "/api/health", "/api/gpu", "/api/metrics", "/api/services", "/api/routing", "/api/llm",
  "/api/qwen/health", "/api/qwen/progress", "/api/qwen/archive", "/api/qwen/images", "/api/qwen/prompts",
  "/api/sam3d/health", "/api/sam3/health", "/api/providers",
]);

// Record every hit to the console's OWN API surface into the traffic ring
// (source "console"). Fire-and-forget so it never adds latency to the request,
// and skip /api/traffic itself to avoid a feedback loop.
export function middleware(req: NextRequest) {
  const { pathname, origin, search } = req.nextUrl;
  // Skip: the /api/traffic ingest channel; qwen generate/edit (they self-report a
  // real response status via withTraffic); and the dashboard's own status polling.
  const skip =
    pathname.startsWith("/api/traffic") ||
    pathname === "/api/qwen/generate" ||
    pathname === "/api/qwen/edit" ||
    (req.method === "GET" && DASHBOARD_POLLS.has(pathname));
  if (!skip) {
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      req.headers.get("x-real-ip") ||
      null;
    fetch(new URL("/api/traffic", origin), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ts: Date.now(), service: "console", method: req.method, path: pathname + search, ip }),
    }).catch(() => {
      /* best-effort: visibility must never break a request */
    });
  }
  return NextResponse.next();
}

export const config = { matcher: "/api/:path*" };
