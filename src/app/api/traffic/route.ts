import { NextRequest, NextResponse } from "next/server";
import { record, readTraffic, type TrafficEvent } from "@/lib/traffic";

// GET  — the merged feed (live ring + parsed access logs), newest first.
export async function GET() {
  const { events, services } = await readTraffic();
  return NextResponse.json({ events, services, count: events.length });
}

// POST — ingest one request event. Called by the console's own middleware and by
// any backend service that opts into request logging (see AI/AGENTS.md).
export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    const ev: TrafficEvent = {
      ts: typeof b.ts === "number" ? b.ts : Date.now(),
      service: String(b.service || "unknown").slice(0, 40),
      method: String(b.method || "GET").toUpperCase().slice(0, 10),
      path: String(b.path || "/").slice(0, 300),
      status: b.status == null ? null : Number(b.status),
      ms: b.ms == null ? null : Number(b.ms),
      ip: b.ip ? String(b.ip).slice(0, 60) : null,
      source: "live",
    };
    record(ev);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
}
