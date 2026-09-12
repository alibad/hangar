import { NextResponse, type NextRequest } from "next/server";

// The dashboard polls these constantly to refresh itself — that's the console
// observing itself, not real traffic, and it would otherwise flood the feed and
// crowd out real requests. Skip them at ingest (GET only). Keep this in sync with
// the same list in lib/traffic.ts (edge middleware can't import that Node module).
const DASHBOARD_POLLS = new Set([
  "/api/health", "/api/gpu", "/api/metrics", "/api/services", "/api/resources", "/api/routing", "/api/llm",
  "/api/qwen/health", "/api/qwen/progress", "/api/qwen/archive", "/api/qwen/images", "/api/qwen/prompts",
  "/api/sam3d/health", "/api/sam3/health", "/api/providers",
  // Static model metadata the studio and compare view each read on mount. Two
  // components + a dev remount meant four identical status-less rows every time
  // the page reloaded, which is what buried the real traffic.
  "/api/footprints", "/api/model-meta",
]);

/**
 * Which service a console route ultimately talks to, from its path alone.
 *
 * Only for routes the middleware logs — the ones that proxy with a real status
 * (image generate/edit) report their own target via a response header, because
 * theirs depends on the requested model rather than the URL.
 *
 * Deliberately only the mapping that is TRUE. A blanket `/api/qwen/*` → "qwen"
 * is wrong for most of them: archive, folders, images, jobs, prompts and stack
 * are console-side file and DB work that never touches :8021, and labelling them
 * as calls to the service would invent traffic that never happened. A missing
 * target is a blank cell; a wrong one is a lie you'd act on.
 */
function targetFromPath(pathname: string): string | null {
  const svc = /^\/api\/services\/([^/]+)/.exec(pathname); // start/stop/restart acts on that service
  return svc ? svc[1] : null;
}

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
    pathname === "/api/image/generate" ||
    pathname === "/api/image/edit" ||
    (req.method === "GET" && DASHBOARD_POLLS.has(pathname));
  if (!skip) {
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      req.headers.get("x-real-ip") ||
      null;
    fetch(new URL("/api/traffic", origin), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ts: Date.now(), service: "console", method: req.method,
        path: pathname + search, ip, target: targetFromPath(pathname),
        caller: req.headers.get("x-source"),
      }),
    }).catch(() => {
      /* best-effort: visibility must never break a request */
    });
  }
  return NextResponse.next();
}

export const config = { matcher: "/api/:path*" };
