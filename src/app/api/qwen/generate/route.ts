import { NextRequest, NextResponse } from "next/server";
import { withTraffic, TARGET_HEADER, describeCall } from "@/lib/with-traffic";
import { generateAndSave } from "@/lib/image-gen";

// Qwen-Image text→image. Kept as a stable endpoint for callers outside the
// console (quote-forge, scripts) — the model is pinned here, so posting a
// `model` field can't redirect this route at another backend. The console's own
// studio uses /api/image/generate, which honours the picker.
export const maxDuration = 800;

async function handlePOST(req: NextRequest) {
  const raw = await req.json();
  const result = await generateAndSave(raw, "qwen-image");
  describeCall(req, {
    model: String(result.body.model ?? "qwen-image"),
    prompt: String(raw.prompt ?? ""),
    artifact: result.ok && result.body.archived ? { kind: "image", rel: String(result.body.archived) } : null,
    error: result.ok ? null : String(result.body.error ?? ""),
  });
  const res = NextResponse.json(result.body, result.ok ? undefined : { status: result.status });
  res.headers.set(TARGET_HEADER, result.target);
  return res;
}

export const POST = withTraffic(handlePOST);
