import { NextRequest, NextResponse } from "next/server";
import { withTraffic } from "@/lib/with-traffic";
import { generateAndSave } from "@/lib/image-gen";

// Model-agnostic generate for the Image studio. Pass `model` to pick a backend
// ("qwen-image" or "flux-schnell"); it defaults to Qwen-Image.
export const maxDuration = 800;

async function handlePOST(req: NextRequest) {
  const result = await generateAndSave(await req.json());
  return NextResponse.json(result.body, result.ok ? undefined : { status: result.status });
}

export const POST = withTraffic(handlePOST);
