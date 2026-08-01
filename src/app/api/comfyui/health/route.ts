import { NextResponse } from "next/server";
import { getServiceUrl } from "@/lib/services";

// Health of ComfyUI (:8188), which backs the FLUX.1-schnell option in the Image
// studio. /system_stats is the registry's health path for this service and is
// the cheapest endpoint that proves the server is actually serving.
export async function GET() {
  const start = Date.now();
  try {
    const base = getServiceUrl("comfyui");
    const res = await fetch(`${base}/system_stats`, { signal: AbortSignal.timeout(8000) });
    const latency = Date.now() - start;
    if (!res.ok) {
      return NextResponse.json({ up: false, latency, statusCode: res.status });
    }
    const data = await res.json().catch(() => ({}));
    return NextResponse.json({
      up: true,
      latency,
      statusCode: res.status,
      device: data?.devices?.[0]?.name ?? null,
    });
  } catch (err) {
    return NextResponse.json({
      up: false,
      latency: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
