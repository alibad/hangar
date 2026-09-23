import { NextRequest, NextResponse } from "next/server";
import { withTraffic, TARGET_HEADER, describeCall } from "@/lib/with-traffic";
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
  const result = await generateAndSave(raw, undefined, req.signal);

  // What the feed needs to show this row as a thing that happened rather than
  // a POST that returned 200: which model, what was asked, and the image
  // itself. The artifact is recorded BY THE PRODUCER, here, because the detail
  // panel cannot re-fetch a POST — and for an image generation, re-running it
  // to look at the answer would mean spending the GPU twice.
  describeCall(req, {
    model: String(result.body.model ?? raw.model ?? ""),
    prompt: String(raw.prompt ?? ""),
    artifact: result.ok && result.body.archived ? { kind: "image", rel: String(result.body.archived) } : null,
    error: result.ok ? null : String(result.body.error ?? ""),
  });

  const res = NextResponse.json(result.body, result.ok ? undefined : { status: result.status });
  res.headers.set(TARGET_HEADER, result.target);
  return res;
}

export const POST = withTraffic(handlePOST);
