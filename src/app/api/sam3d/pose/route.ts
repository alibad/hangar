import { NextRequest, NextResponse } from "next/server";
import { getServiceUrl, getServiceHeaders } from "@/lib/services";
import { ResourceLeaseError, withResourceLease } from "@/lib/resource-manager";

export const maxDuration = 120;

// Proxy a multipart pose request to the SAM 3D Body server (:8009/pose).
export async function POST(req: NextRequest) {
  try {
    const inForm = await req.formData();
    const image = inForm.get("image");
    if (!(image instanceof Blob)) {
      return NextResponse.json({ ok: false, error: "an image file is required" }, { status: 400 });
    }
    const out = new FormData();
    out.append("image", image, (image as File).name || "upload.png");
    for (const k of ["bbox", "mediapipe", "include_mesh", "include_rig"]) {
      const v = inForm.get(k);
      if (v != null) out.append(k, String(v));
    }

    const base = getServiceUrl("sam3d");
    let res: Response;
    try {
      // No Content-Type header — let fetch set the multipart boundary.
      res = await withResourceLease(
        "sam3d-pose",
        { owner: "console:sam3d-pose", lane: "interactive", signal: req.signal },
        () => fetch(`${base}/pose`, { method: "POST", headers: getServiceHeaders("sam3d"), body: out, signal: req.signal }),
      );
    } catch (err) {
      if (err instanceof ResourceLeaseError) {
        return NextResponse.json(
          { ok: false, error: err.message, code: err.code, resourceBlocked: true, details: err.details },
          { status: err.status },
        );
      }
      return NextResponse.json(
        { ok: false, error: `SAM3D unreachable: ${err instanceof Error ? err.message : String(err)}` },
        { status: 502 },
      );
    }

    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = { ok: false, error: text.slice(0, 300) || `SAM3D returned ${res.status}` };
    }
    return NextResponse.json(data, { status: res.ok ? 200 : res.status });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
