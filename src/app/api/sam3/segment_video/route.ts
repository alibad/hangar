import { NextRequest, NextResponse } from "next/server";
import { getServiceUrl, getServiceHeaders } from "@/lib/services";
import { ResourceLeaseError, withResourceLease } from "@/lib/resource-manager";

export const maxDuration = 600; // video tracking runs inference over every frame

// Proxy a multipart video-tracking request to the SAM 3 server (:8010/segment_video).
export async function POST(req: NextRequest) {
  try {
    const inForm = await req.formData();
    const video = inForm.get("video");
    if (!(video instanceof Blob)) {
      return NextResponse.json({ ok: false, error: "a video file is required" }, { status: 400 });
    }
    const out = new FormData();
    out.append("video", video, (video as File).name || "upload.mp4");
    for (const k of ["concepts", "max_frames", "target_fps", "max_side", "min_score", "only_ids"]) {
      const v = inForm.get(k);
      if (v != null) out.append(k, String(v));
    }

    const base = getServiceUrl("sam3");
    let res: Response;
    try {
      res = await withResourceLease(
        "sam3-video",
        { owner: "console:sam3-video", lane: "interactive", ttlMs: 30 * 60 * 1000, signal: req.signal },
        () => fetch(`${base}/segment_video`, { method: "POST", headers: getServiceHeaders("sam3"), body: out, signal: req.signal }),
      );
    } catch (err) {
      if (err instanceof ResourceLeaseError) {
        return NextResponse.json(
          { ok: false, error: err.message, code: err.code, resourceBlocked: true, details: err.details },
          { status: err.status },
        );
      }
      return NextResponse.json(
        { ok: false, error: `SAM3 unreachable: ${err instanceof Error ? err.message : String(err)}` },
        { status: 502 },
      );
    }

    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = { ok: false, error: text.slice(0, 300) || `SAM3 returned ${res.status}` };
    }
    return NextResponse.json(data, { status: res.ok ? 200 : res.status });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
