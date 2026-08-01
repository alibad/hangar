import { NextResponse } from "next/server";
import { getServiceUrl, getServiceHeaders } from "@/lib/services";

// Health/readiness for the SAM 3D Body server, for the tab's status header.
export async function GET() {
  const start = Date.now();
  try {
    const base = getServiceUrl("sam3d");
    const res = await fetch(`${base}/health`, {
      headers: getServiceHeaders("sam3d"),
      signal: AbortSignal.timeout(4000),
    });
    const data = await res.json();
    return NextResponse.json({ up: true, latency: Date.now() - start, ...data });
  } catch (e) {
    return NextResponse.json({ up: false, latency: Date.now() - start, error: e instanceof Error ? e.message : String(e) });
  }
}
