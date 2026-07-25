import { NextResponse } from "next/server";
import { getServiceUrl, getServiceHeaders } from "@/lib/services";

// Health of the local Qwen-Image server (:8021). Forwards whatever the server
// reports (model, loaded, mode, and — on newer servers — edit availability),
// plus a measured round-trip latency so the UI can show responsiveness.
export async function GET() {
  const start = Date.now();
  try {
    const base = getServiceUrl("qwen");
    const res = await fetch(`${base}/health`, {
      headers: getServiceHeaders("qwen"),
      signal: AbortSignal.timeout(8000),
    });
    const latency = Date.now() - start;
    if (!res.ok) {
      return NextResponse.json({ up: false, latency, statusCode: res.status });
    }
    const data = await res.json();
    return NextResponse.json({ up: true, latency, statusCode: res.status, ...data });
  } catch (err) {
    return NextResponse.json({
      up: false,
      latency: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
