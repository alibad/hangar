import { NextRequest, NextResponse } from "next/server";
import { getServiceUrl } from "@/lib/services";
import { IMAGE_MODELS } from "@/lib/image-models";

export const dynamic = "force-dynamic";

/**
 * Release ComfyUI's weights WITHOUT stopping ComfyUI.
 *
 * The same shape as `POST /api/ollama/unload`, and for the same reason: four
 * image models (FLUX.2 Klein, HiDream-O1, Z-Image Turbo, FLUX.1 schnell) share
 * the single `comfyui` service, so the service-level Stop is the wrong verb for
 * all four. Pressing it to free the card also tears down the process the other
 * three need, and the next run pays a cold start that was never necessary —
 * ComfyUI idles at well under a gigabyte once its weights are released.
 *
 * A model and a service are different things here. Stopping the runtime is still
 * available on the Run setup row, where it means what it says.
 *
 * Unlike Ollama, ComfyUI has no per-model unload: `/free` releases whatever
 * checkpoint is currently resident. That is not a limitation in practice,
 * because ComfyUI holds one checkpoint at a time — running a second evicts the
 * first. So `model` here is accepted for symmetry and for the message, not to
 * select among several resident models.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const requested: unknown = body?.model;

  // Resolve through the registry rather than trusting the body, so this cannot
  // be pointed at a model that does not live on this service.
  let label = "ComfyUI";
  if (typeof requested === "string" && requested.trim()) {
    const entry = IMAGE_MODELS.find((m) => m.id === requested);
    if (!entry) {
      return NextResponse.json({ error: `Unknown model "${requested}".` }, { status: 400 });
    }
    if (entry.serviceId !== "comfyui") {
      return NextResponse.json(
        { error: `"${entry.name}" does not run on ComfyUI — stop its own service instead.` },
        { status: 400 },
      );
    }
    label = entry.name;
  }

  const base = getServiceUrl("comfyui");
  try {
    const res = await fetch(`${base}/free`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // unload_models drops the checkpoint; free_memory also returns the
      // allocator's cached blocks, which is the part nvidia-smi actually shows.
      body: JSON.stringify({ unload_models: true, free_memory: true }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      return NextResponse.json(
        { error: `ComfyUI returned ${res.status} from /free.` },
        { status: 502 },
      );
    }
  } catch (err) {
    // Already gone is success, not an error: the button's purpose is the end
    // state, and a stopped ComfyUI is holding nothing.
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `ComfyUI is not reachable (${message}).` },
      { status: 503 },
    );
  }

  return NextResponse.json({ ok: true, model: label, released: true });
}
