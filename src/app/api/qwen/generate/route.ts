import { NextRequest, NextResponse } from "next/server";
import { withTraffic, TARGET_HEADER } from "@/lib/with-traffic";
import { generateAndSave } from "@/lib/image-gen";

// Qwen-Image text→image. Kept as a stable endpoint for callers outside the
// console (quote-forge, scripts) — the model is pinned here, so posting a
// `model` field can't redirect this route at another backend. The console's own
// studio uses /api/image/generate, which honours the picker.
export const maxDuration = 800;

async function handlePOST(req: NextRequest) {
  const result = await generateAndSave(await req.json(), "qwen-image");
  const res = NextResponse.json(result.body, result.ok ? undefined : { status: result.status });
  res.headers.set(TARGET_HEADER, result.target);
  return res;
}

export const POST = withTraffic(handlePOST);
