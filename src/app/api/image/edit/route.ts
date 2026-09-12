import { NextRequest, NextResponse } from "next/server";
import { generateComfyImage } from "@/lib/flux";
import { safeFolder, saveImage } from "@/lib/save-image";
import { mirrorImageHistory } from "@/lib/image-history";
import { withTraffic, TARGET_HEADER } from "@/lib/with-traffic";
import { ResourceLeaseError, withResourceLease } from "@/lib/resource-manager";

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
    if (raw.model !== "flux2-klein-4b") return reply({ error: "Select FLUX.2 Klein for this edit endpoint" }, 400);
    if (folder === null || !String(raw.prompt || "").trim() || !Array.isArray(raw.images) || !raw.images.length || raw.images.length > 4 || raw.images.some((image: unknown) => typeof image !== "string")) return reply({ error: "Choose 1–4 images, an edit instruction, and a valid gallery" }, 400);
    const params = { prompt: String(raw.prompt).trim(), width: Math.max(256, Math.min(2048, Number(raw.width) || 1024)), height: Math.max(256, Math.min(2048, Number(raw.height) || 1024)), seed: Number.isFinite(raw.seed) ? Math.floor(raw.seed) : Math.floor(Math.random() * 2147483647), steps: 4 };
    const started = Date.now();
    const png = await withResourceLease("flux2-klein-generate", { owner: `console:image:${String(raw.requestId || "edit").slice(0,100)}`, signal: req.signal }, () => generateComfyImage(raw.model, params, req.signal, raw.images));
    const latency = Date.now() - started;
    const meta = { ...params, kind: "edit", model: raw.model, inputCount: raw.images.length, folder, latency };
    const saved = await saveImage(png, meta);
    await mirrorImageHistory(png, { ...meta, ms: latency });
    return reply({ status: "success", image: `data:image/png;base64,${png.toString("base64")}`, seed: params.seed, latency, model: raw.model, saved: saved?.file ?? null });
  } catch (error) {
    return reply({ error: error instanceof Error ? error.message : String(error) }, error instanceof ResourceLeaseError ? error.status : 502);
  }
});
