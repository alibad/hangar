import { NextResponse, type NextRequest } from "next/server";

// Record every hit to the console's OWN API surface into the traffic ring
// (source "console"). Fire-and-forget so it never adds latency to the request,
// and skip /api/traffic itself to avoid a feedback loop.
export function middleware(req: NextRequest) {
  const { pathname, origin } = req.nextUrl;
  if (!pathname.startsWith("/api/traffic")) {
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      req.headers.get("x-real-ip") ||
      null;
    fetch(new URL("/api/traffic", origin), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ts: Date.now(), service: "console", method: req.method, path: pathname, ip }),
    }).catch(() => {
      /* best-effort: visibility must never break a request */
    });
  }
  return NextResponse.next();
}

export const config = { matcher: "/api/:path*" };
