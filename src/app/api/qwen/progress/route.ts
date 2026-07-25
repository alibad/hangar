import { NextResponse } from "next/server";
import { getServiceUrl, getServiceHeaders } from "@/lib/services";

// Live denoising progress from the Qwen server so the UI can show "step 12/24"
// instead of a frozen bar. Cheap, polled ~1/s during a generation.
export async function GET() {
  try {
    const base = getServiceUrl("qwen");
    const res = await fetch(`${base}/progress`, {
      headers: getServiceHeaders("qwen"),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return NextResponse.json({ running: false });
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ running: false, unreachable: true });
  }
}
