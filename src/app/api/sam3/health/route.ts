import { NextResponse } from "next/server";
import { getServiceUrl, getServiceHeaders } from "@/lib/services";

// Health/readiness for the SAM 3 concept-segmentation server, for the tab header.
export async function GET() {
  const start = Date.now();
  try {
    const base = getServiceUrl("sam3");
    const res = await fetch(`${base}/health`, {
      headers: getServiceHeaders("sam3"),
      signal: AbortSignal.timeout(4000),
    });
    const data = await res.json();
    return NextResponse.json({ up: true, latency: Date.now() - start, ...data });
  } catch (e) {
    return NextResponse.json({ up: false, latency: Date.now() - start, error: e instanceof Error ? e.message : String(e) });
  }
}
