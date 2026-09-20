import { NextRequest, NextResponse } from "next/server";
import { resolveCallTarget, type CallTarget } from "@/lib/providers";
import { getServiceHeaders } from "@/lib/services";

export const maxDuration = 1800;

/** Local text-to-video/image-to-video endpoint. Returns MP4 bytes directly. */
export async function POST(req: NextRequest) {
  let target: CallTarget | null = null;
  try {
    const body = await req.json();
    if (!String(body.prompt ?? "").trim()) {
      return NextResponse.json({ error: "prompt is required" }, { status: 400 });
    }
    target = await resolveCallTarget("video");
    const res = await fetch(`${target.baseUrl}/video`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(target.via === "service" ? getServiceHeaders(target.serviceId!) : {}),
      },
      body: JSON.stringify({ ...body, model: target.model }),
      signal: AbortSignal.timeout(30 * 60_000),
    });
    if (!res.ok) {
      return NextResponse.json({ error: `Video generation failed (${res.status})`, detail: (await res.text()).slice(0, 500) }, { status: res.status });
    }
    return new NextResponse(await res.arrayBuffer(), {
      headers: {
        "Content-Type": res.headers.get("content-type") ?? "video/mp4",
        "X-Video-Model": target.alias,
        "X-Video-Via": target.via,
        ...(target.degraded ? { "X-Video-Degraded": target.degraded } : {}),
      },
    });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : String(error),
      model: target?.alias,
      serviceId: target?.serviceId,
    }, { status: 502 });
  }
}
