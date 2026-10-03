import { NextRequest, NextResponse } from "next/server";
import { generateComfyImage } from "@/lib/flux";
import { safeFolder, saveImage } from "@/lib/save-image";
import { mirrorImageHistory } from "@/lib/image-history";
import { withTraffic, TARGET_HEADER } from "@/lib/with-traffic";
import { ResourceLeaseError, withResourceLease, workloadForImageModel } from "@/lib/resource-manager";
import { IMAGE_MODELS, getImageModel, isImageModelId } from "@/lib/image-models";

export const maxDuration = 900;
export const POST = withTraffic(async (req: NextRequest) => {
  const reply = (body: object, status = 200) => {
    const response = NextResponse.json(body, { status });
    response.headers.set(TARGET_HEADER, "comfyui");
    return response;
  };
  try {
    const raw = await req.json();
    const folder = safeFolder(raw.folder == null ? "" : String(raw.folder));
    // Every ComfyUI model that edits through reference images: FLUX.2 Klein,
    // Qwen-Image 2.1 and HiDream-O1 (full). Qwen-Image's own edit checkpoint
    // stays on /api/qwen/edit.
    const model = isImageModelId(raw.model) ? getImageModel(raw.model) : null;
    if (!model || model.serviceId !== "comfyui" || !model.supportsEdit) {
      return reply({ error: `Select a ComfyUI model that edits: ${IMAGE_MODELS.filter((m) => m.serviceId === "comfyui" && m.supportsEdit).map((m) => m.name).join(", ")}` }, 400);
    }
    const workload = workloadForImageModel(model.id);
    if (!workload) return reply({ error: `${model.name} has no resource workload declared in config/resource-policy.json` }, 500);
    if (folder === null || !String(raw.prompt || "").trim() || !Array.isArray(raw.images) || !raw.images.length || raw.images.length > 4 || raw.images.some((image: unknown) => typeof image !== "string")) return reply({ error: "Choose 1–4 images, an edit instruction, and a valid gallery" }, 400);
    const params = { prompt: String(raw.prompt).trim(), width: Math.max(256, Math.min(2048, Number(raw.width) || 1024)), height: Math.max(256, Math.min(2048, Number(raw.height) || 1024)), seed: Number.isFinite(raw.seed) ? Math.floor(raw.seed) : Math.floor(Math.random() * 2147483647), steps: model.steps[0] };
    const started = Date.now();
    const png = await withResourceLease(workload, { owner: `console:image:${String(raw.requestId || "edit").slice(0,100)}`, signal: req.signal }, () => generateComfyImage(model.id, params, req.signal, raw.images));
    const latency = Date.now() - started;
    const meta = { ...params, kind: "edit", model: model.id, inputCount: raw.images.length, folder, latency };
    const saved = await saveImage(png, meta);
    await mirrorImageHistory(png, { ...meta, ms: latency });
    return reply({ status: "success", image: `data:image/png;base64,${png.toString("base64")}`, seed: params.seed, latency, model: model.id, saved: saved?.file ?? null, savedPath: saved?.path ?? null });
  } catch (error) {
    return reply({ error: error instanceof Error ? error.message : String(error) }, error instanceof ResourceLeaseError ? error.status : 502);
  }
});
