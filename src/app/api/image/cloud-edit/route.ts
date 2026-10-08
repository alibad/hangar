import { NextRequest, NextResponse } from "next/server";
import { withTraffic, TARGET_HEADER } from "@/lib/with-traffic";
import { safeFolder } from "@/lib/save-image";
import { getCatalogue, routerUrl } from "@/lib/providers";
import { isImageModelId } from "@/lib/image-models";
import { runCloudImage } from "@/lib/cloud-image-run";

// Hosted image edits: up to the model's limit of reference images (16 for GPT
// image models, 14 for Gemini 3) plus an optional mask, sent multipart to the
// AI Router's /v1/images/edits with X-Source kept, saved like a generation.
//
// A separate route from /api/image/edit on purpose: that one leases GPU memory
// for ComfyUI workflows; a hosted edit holds no local resource at all.
//
// Body: { model, prompt, images: dataURL[], mask?: dataURL, cloud?: {...},
//         folder?, source? }
export const maxDuration = 900;

export const POST = withTraffic(async (req: NextRequest) => {
  const reply = (body: object, status = 200) => {
    const res = NextResponse.json(body, { status });
    res.headers.set(TARGET_HEADER, "ai-router");
    return res;
  };
  const raw = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  const prompt = String(raw.prompt ?? "").trim();
  if (!model) return reply({ error: "model is required" }, 400);
  if (!prompt) return reply({ error: "Describe the edit" }, 400);
  if (isImageModelId(model)) return reply({ error: `${model} is a local model; use /api/image/edit or /api/qwen/edit` }, 400);
  const folder = safeFolder(raw.folder == null ? "" : String(raw.folder));
  if (folder === null) return reply({ error: "Invalid destination gallery" }, 400);

  let entry: { local: boolean; target: string } | undefined;
  try {
    entry = (await getCatalogue()).models.find((m) => m.id === model);
  } catch { /* the registry still resolves by alias */ }
  if (entry?.local) return reply({ error: `${model} is served locally; hosted edits are for cloud models` }, 400);

  try {
    const r = await runCloudImage({
      kind: "edit",
      alias: model,
      target: entry?.target,
      prompt,
      cloud: raw.cloud as Record<string, unknown> | undefined,
      images: raw.images,
      mask: raw.mask,
      folder,
      seed: Number.isFinite(raw.seed as number) ? Math.floor(raw.seed as number) : Math.floor(Math.random() * 2_147_483_647),
      source: raw.source,
      signal: req.signal,
      baseUrl: routerUrl(),
    });
    return reply(r.body, r.status);
  } catch (error) {
    return reply({ error: error instanceof Error ? error.message : String(error) }, 502);
  }
});
