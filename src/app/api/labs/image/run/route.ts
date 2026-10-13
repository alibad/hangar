import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { generateAndSave } from "@/lib/image-gen";
import { localImageModelFor } from "@/lib/image-models";
import { outputDir } from "@/lib/save-image";
import { getCatalogue } from "@/lib/providers";
import { measureRun, recordLabRun } from "@/lib/lab-runs";
import type { LabRunResult } from "@/lib/lab-types";

export const dynamic = "force-dynamic";
/** Qwen-Image cold off disk is ~5 minutes; a cloud model can be slow too. */
export const maxDuration = 900;

export type ImageLabOutput = {
  /** Served by the gallery's own file route, so it survives a reload. */
  url: string;
  savedPath: string;
  width: number;
  height: number;
  seed: number;
  steps?: number;
};

/**
 * Run one image model once, measured and recorded.
 *
 * The call is generateAndSave(), the Image Studio's own path: the same
 * resource lease, the same gallery, the same Activity mirror. The Lab adds
 * only the measurement and the runs record.
 *
 * The Lab's model ids come from two places and are mapped back to what
 * generateAndSave() understands: the router alias of the Qwen service
 * ("local-qwen-image" → "qwen-image"), ComfyUI's served names from the host
 * profile (already the local ids), and cloud aliases, which go through the
 * router unchanged (localImageModelFor).
 */

/** The router's own price for a hosted call (x-litellm-response-cost), when it sent one. */
function routerCost(body: Record<string, unknown> | null): number | null {
  const cloud = body?.cloud as { costUsd?: unknown; costSource?: unknown } | undefined;
  return cloud?.costSource === "router" && typeof cloud.costUsd === "number" ? cloud.costUsd : null;
}

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  const model = typeof b?.model === "string" ? b.model.trim() : "";
  const prompt = typeof b?.prompt === "string" ? b.prompt.trim() : "";
  if (!model) return NextResponse.json({ error: "model is required" }, { status: 400 });
  if (!prompt) return NextResponse.json({ error: "prompt is required" }, { status: 400 });
  const seed = Number.isInteger(b?.seed) ? (b.seed as number) : Math.floor(Math.random() * 2_147_483_647);
  const size = [512, 768, 1024, 1536, 2048].includes(Number(b?.size)) ? Number(b.size) : 1024;
  const compareGroup = typeof b?.compareGroup === "string" ? b.compareGroup : null;

  const localId = localImageModelFor(model);
  const local = !!localId;
  const target = localId ?? model;

  let costPerImage: number | undefined;
  if (!local) {
    try {
      costPerImage = (await getCatalogue()).models.find((m) => m.id === model)?.costPerImage;
    } catch {
      /* no price is "not known", never "free" */
    }
  }

  const measured = await measureRun(
    async () => {
      const r = await generateAndSave(
        {
          model: target, prompt, seed, width: size, height: size, folder: "Compare", requestId: `lab:image:${target}`,
          // Hosted models: the comparison's shared parameters (validated per
          // model — Gemini drops quality), attributed to Compare in Activity.
          ...(local ? {} : { cloud: b?.cloud && typeof b.cloud === "object" ? b.cloud : undefined, source: "console/compare" }),
        },
        undefined,
        req.signal,
      );
      if (!r.ok) throw Object.assign(new Error(String(r.body.error ?? "generation failed")), { gen: r });
      return r.body;
    },
    { local },
  );

  const m = measured.measurement;
  const failed = !measured.ok ? (measured.error as Error & { gen?: { body: { resourceBlocked?: boolean } } }) : null;
  const body = measured.ok ? measured.result : null;
  const abs = typeof body?.savedPath === "string" ? body.savedPath : null;
  const rel = abs ? path.relative(outputDir(), abs).replace(/\\/g, "/") : null;
  // generateAndSave() fills diffusion knobs from a local default even for a
  // hosted model, which has no denoising loop; only report steps where they ran.
  const steps = local && body ? Number(body.steps) || null : null;

  const run = await recordLabRun({
    lab: "image",
    capability: "image",
    model,
    local,
    compareGroup,
    inputSummary: prompt.replace(/\s+/g, " "),
    params: { size, ...(steps ? { steps } : {}) },
    seed,
    status: body ? "ok" : "error",
    error: failed ? failed.message : null,
    latencyMs: m.latencyMs,
    peakVramGb: m.peakVramGb,
    baselineVramGb: m.baselineVramGb,
    vramNote: m.vramNote,
    // The router's published per-image price where it has one. A missing price
    // stays null ("not metered here"), never 0.
    costUsd: local ? null : routerCost(body) ?? costPerImage ?? null,
    outputPath: abs,
    outputSummary: rel,
  });

  const result: LabRunResult<ImageLabOutput> = {
    ok: !!body && !!rel,
    model,
    local,
    error: failed?.message,
    resourceBlocked: failed?.gen?.body.resourceBlocked,
    output: body && rel
      ? { url: `/api/qwen/images/file?rel=${encodeURIComponent(rel)}`, savedPath: rel, width: Number(body.width) || size, height: Number(body.height) || size, seed, steps: steps ?? undefined }
      : undefined,
    runId: run?.id ?? null,
    latencyMs: m.latencyMs,
    peakVramGb: m.peakVramGb,
    baselineVramGb: m.baselineVramGb,
    vramNote: m.vramNote,
    costUsd: local ? null : routerCost(body) ?? costPerImage ?? null,
  };
  return NextResponse.json(result);
}
