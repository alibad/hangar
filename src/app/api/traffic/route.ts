import { NextRequest, NextResponse } from "next/server";
import { record, readTraffic, type TrafficEvent } from "@/lib/traffic";

// GET — the merged feed (live ring + parsed access logs), newest first.
// Background noise (polling + gallery asset loads) is returned SEPARATELY and
// never mixed in: at one /progress tick per second, plus a request per gallery
// thumbnail, it would bury the requests that actually matter.
export async function GET() {
  const { events, noise, noiseCount, hops, hopCount, services } = await readTraffic();
  return NextResponse.json({ events, noise, noiseCount, hops, hopCount, services, count: events.length });
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
      model: b.model ? String(b.model).slice(0, 80) : null,
      costUsd: b.costUsd == null ? null : Number(b.costUsd),
      caller: b.caller ? String(b.caller).slice(0, 120) : null,
      prompt: b.prompt ? String(b.prompt).slice(0, 400) : null,
      tokensIn: b.tokensIn == null ? null : Number(b.tokensIn),
      tokensOut: b.tokensOut == null ? null : Number(b.tokensOut),
      error: b.error ? String(b.error).slice(0, 400) : null,
      hop: b.hop ? String(b.hop).slice(0, 40) : null,
      rid: b.rid ? String(b.rid).slice(0, 80) : null,
      pending: b.pending === true,
      // Only the shapes the UI can render — an unknown `kind` would just be a
      // broken tile. Producers add a kind here and in the detail panel together.
      artifact:
        b.artifact && b.artifact.kind === "image" && typeof b.artifact.rel === "string"
          ? { kind: "image" as const, rel: b.artifact.rel.slice(0, 300) }
          : null,
    };
    record(ev);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
}
