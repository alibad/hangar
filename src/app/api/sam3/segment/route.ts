import { NextRequest, NextResponse } from "next/server";
import { getServiceUrl, getServiceHeaders } from "@/lib/services";

export const maxDuration = 120;

// Proxy a multipart concept-segmentation request to the SAM 3 server (:8010/segment).
export async function POST(req: NextRequest) {
  try {
    const inForm = await req.formData();
    const image = inForm.get("image");
    if (!(image instanceof Blob)) {
      return NextResponse.json({ ok: false, error: "an image file is required" }, { status: 400 });
    }
    const out = new FormData();
    out.append("image", image, (image as File).name || "upload.png");
    for (const k of ["concepts", "min_score", "overlay", "include_masks"]) {
      const v = inForm.get(k);
      if (v != null) out.append(k, String(v));
    }

    const base = getServiceUrl("sam3");
    let res: Response;
    try {
      // No Content-Type header — let fetch set the multipart boundary.
      res = await fetch(`${base}/segment`, { method: "POST", headers: getServiceHeaders("sam3"), body: out });
    } catch (err) {
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
