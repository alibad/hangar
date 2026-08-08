import { NextRequest, NextResponse } from "next/server";
import { withTraffic, TARGET_HEADER } from "@/lib/with-traffic";
import { generateAndSave } from "@/lib/image-gen";

// Model-agnostic generate for the Image studio. Pass `model` to pick a backend
// ("qwen-image" or "flux-schnell"); it defaults to Qwen-Image.
export const maxDuration = 800;

async function handlePOST(req: NextRequest) {
  const raw = await req.json();

  // Local resource admission happens inside generateAndSave(), below every
  // caller (single generation, compare, legacy aliases, and the batch queue's
  // equivalent shared helper). There must not be a second RAM decision here:
  // free RAM already excludes resident weights and would double-count Qwen.
  const result = await generateAndSave(raw);
  const res = NextResponse.json(result.body, result.ok ? undefined : { status: result.status });
  res.headers.set(TARGET_HEADER, result.target);
  return res;
}

export const POST = withTraffic(handlePOST);
