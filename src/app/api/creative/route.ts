import { NextRequest, NextResponse } from "next/server";
import { generateAndSave } from "@/lib/image-gen";

/**
 * DEPRECATED — kept only so callers outside this repo don't break.
 *
 * This used to be the Creative tab's own FLUX endpoint: it posted a workflow to
 * ComfyUI and returned a ComfyUI filename, which the tab then displayed by
 * proxying /view. Nothing it produced reached the gallery, the image index, or
 * the Activity feed. The tab is now part of the Image studio and FLUX runs
 * through /api/image/generate, which persists like every other model.
 *
 * So this forwards, pinned to FLUX, and returns the shared response shape. The
 * old `{ image: { filename, subfolder, type } }` object is gone — an image is a
 * data URL here, and it's already saved on disk. New code should call
 * /api/image/generate directly.
 */
export const maxDuration = 800;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const result = await generateAndSave(body, "flux-schnell");
  return NextResponse.json(
    { ...result.body, deprecated: "Use /api/image/generate with model=flux-schnell." },
    result.ok ? undefined : { status: result.status },
  );
}

/**
 * The old GET served an image back out of ComfyUI's output folder by filename.
 * Generated images live in this app's own store now, so that lookup has no
 * meaning — point callers at the endpoint that can actually find them.
 */
export function GET() {
  return NextResponse.json(
    {
      error: "Gone. Images are saved locally now — list them via /api/qwen/images and fetch with /api/qwen/images/file?rel=…",
    },
    { status: 410 },
  );
}
