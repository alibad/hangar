import { NextResponse } from "next/server";

import { buildUsageSnapshot, type UsageSnapshot } from "@/lib/claude-usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE_MS = 20_000;

let cache: { at: number; data: UsageSnapshot } | null = null;
let inflight: Promise<UsageSnapshot> | null = null;

export async function GET(request: Request) {
  const force = new URL(request.url).searchParams.has("refresh");

  if (!force && cache && Date.now() - cache.at < CACHE_MS) {
    return NextResponse.json(cache.data, { headers: { "cache-control": "no-store" } });
  }
  if (inflight) {
    return NextResponse.json(await inflight, { headers: { "cache-control": "no-store" } });
  }

  inflight = buildUsageSnapshot()
    .then((data) => {
      cache = { at: Date.now(), data };
      return data;
    })
    .finally(() => {
      inflight = null;
    });

  try {
    return NextResponse.json(await inflight, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    // Serve stale data rather than blanking the panel on a transient read error.
    if (cache) return NextResponse.json(cache.data, { headers: { "cache-control": "no-store" } });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
