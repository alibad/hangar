import { NextRequest, NextResponse } from "next/server";
import os from "os";
import { withTraffic, TARGET_HEADER } from "@/lib/with-traffic";
import { generateAndSave } from "@/lib/image-gen";
import { getFootprintsByService } from "@/lib/providers";
import { IMAGE_MODELS, isImageModelId } from "@/lib/image-models";
import { RAM_SAFETY_GB } from "@/lib/ram-budget";

// Model-agnostic generate for the Image studio. Pass `model` to pick a backend
// ("qwen-image" or "flux-schnell"); it defaults to Qwen-Image.
export const maxDuration = 800;

/**
 * Refuse a generation that host RAM cannot survive.
 *
 * Guarded HERE rather than in the compare view because every image path lands on
 * this route — the studio's Generate button, the compare fan-out, the batch
 * queue. The failure it prevents is real and already happened: Qwen-Image keeps
 * ~28 GB of fp8 weights in system RAM, a FLUX run wants a similar amount, and
 * asking for the second while the first is loaded killed the Qwen service with a
 * MemoryError mid-shard-load. Cheaper to say no.
 *
 * Only ever blocks on a SOURCED number: a model with no `ramGb` in
 * model-meta.json is waved through rather than guessed at.
 */
function ramRefusal(modelId: string | undefined): string | null {
  if (!modelId || !isImageModelId(modelId)) return null; // cloud: costs money, not RAM
  const serviceId = IMAGE_MODELS.find((m) => m.id === modelId)?.serviceId;
  if (!serviceId) return null;

  const needGb = getFootprintsByService()[serviceId]?.footprint?.ramGb;
  if (typeof needGb !== "number" || needGb <= 0) return null;

  const freeGb = Math.round((os.freemem() / 1024 ** 3) * 10) / 10;
  if (freeGb - RAM_SAFETY_GB >= needGb) return null;

  return (
    `Not enough host RAM for ${modelId}: it needs ~${needGb} GB and only ${freeGb} GB is free. ` +
    `Another model is probably still loaded — stop it first. ` +
    `(Qwen-Image and FLUX each hold ~28 GB of weights in system RAM and do not fit together.)`
  );
}

async function handlePOST(req: NextRequest) {
  const raw = await req.json();

  const refusal = ramRefusal(typeof raw?.model === "string" ? raw.model : undefined);
  if (refusal && raw?.force !== true) {
    // Refused before dispatch, so there is no target — the row reads as console
    // declining the work, which is exactly what happened.
    return NextResponse.json({ error: refusal, ramBlocked: true }, { status: 409 });
  }

  const result = await generateAndSave(raw);
  const res = NextResponse.json(result.body, result.ok ? undefined : { status: result.status });
  res.headers.set(TARGET_HEADER, result.target);
  return res;
}

export const POST = withTraffic(handlePOST);
