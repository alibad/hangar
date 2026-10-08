// One hosted image run, end to end: validate → call the router → save every
// image with its full parameter set → reply in the studio's response shape.
//
// Shared by generate (via generateAndSave, so /api/image/generate, Compare and
// the Lab all get it) and the hosted edit route. The saved sidecar is the
// record of what was asked, what was sent, what came back and what it cost;
// the DuckDB row stays the gallery's index and its schema is unchanged.

import { randomUUID } from "node:crypto";
import { saveImage, sniffImageFormat, imageMime } from "@/lib/save-image";
import {
  CloudImageError,
  DEFAULT_CLOUD_IMAGE_SOURCE,
  decodeDataUrl,
  editCloudImages,
  generateCloudImages,
  type CloudImageResult,
  type EditInput,
} from "@/lib/cloud-image-gen";
import {
  estimateCloudImageCost,
  resolveCloudImageSpec,
  validateCloudImageParams,
  type CloudImageInput,
  type CloudImageKind,
} from "@/lib/cloud-image-models";

export type CloudRunInput = {
  kind: CloudImageKind;
  /** Router alias. */
  alias: string;
  /** Catalogue vendor id ("openai/gpt-image-2"), when known. */
  target?: string | null;
  prompt: string;
  /** The requested parameter set (see CloudImageParams). */
  cloud?: Record<string, unknown> | null;
  /** Legacy pixel size, used only when cloud.size is absent. */
  width?: unknown;
  height?: unknown;
  /** Edit references and mask, as data URLs. */
  images?: unknown;
  mask?: unknown;
  folder: string;
  seed: number;
  source?: unknown;
  signal?: AbortSignal;
  /** Router base URL. */
  baseUrl: string;
};

export type CloudRunResult = { ok: boolean; status: number; body: Record<string, unknown> };

/** Callers may tag their own X-Source, but only inside the console's namespace. */
export function cloudSource(source: unknown): string {
  return typeof source === "string" && /^console(\/[A-Za-z0-9._-]{1,60}){0,3}$/.test(source) ? source : DEFAULT_CLOUD_IMAGE_SOURCE;
}

async function dimensions(buf: Buffer): Promise<{ width: number | null; height: number | null }> {
  try {
    const sharp = (await import("sharp")).default;
    const m = await sharp(buf).metadata();
    return { width: m.width ?? null, height: m.height ?? null };
  } catch {
    return { width: null, height: null };
  }
}

export async function runCloudImage(input: CloudRunInput): Promise<CloudRunResult> {
  const started = Date.now();
  const spec = resolveCloudImageSpec(input.alias, input.target);
  const requested: CloudImageInput = { ...(input.cloud && typeof input.cloud === "object" ? input.cloud : {}) };
  if (requested.size == null) { requested.width = input.width; requested.height = input.height; }

  let refs: EditInput[] = [];
  let mask: EditInput | null = null;
  if (input.kind === "edit") {
    const list = Array.isArray(input.images) ? input.images : [];
    if (list.some((x) => typeof x !== "string")) return { ok: false, status: 400, body: { error: "images must be data URLs" } };
    refs = list.map((x) => decodeDataUrl(x as string)).filter((x): x is EditInput => !!x);
    if (refs.length !== list.length) return { ok: false, status: 400, body: { error: "Reference images must be PNG, JPEG or WebP." } };
    if (typeof input.mask === "string" && input.mask) {
      mask = decodeDataUrl(input.mask);
      if (!mask || mask.mime !== "image/png") return { ok: false, status: 400, body: { error: "The mask must be a PNG with an alpha channel (transparent where the edit goes)." } };
    }
  }

  const v = validateCloudImageParams(spec, requested, { kind: input.kind, imageCount: refs.length, hasMask: !!mask });
  if (!v.ok) return { ok: false, status: 400, body: { error: v.errors.join(" "), errors: v.errors, warnings: v.warnings } };
  const params = v.params;
  const source = cloudSource(input.source);
  const estimate = estimateCloudImageCost(spec, params, { kind: input.kind, imageCount: refs.length, promptChars: input.prompt.length });

  let result: CloudImageResult;
  try {
    const common = { alias: input.alias, spec, prompt: input.prompt, params, source, signal: input.signal, baseUrl: input.baseUrl };
    result = input.kind === "edit"
      ? await editCloudImages({ ...common, images: refs, mask: spec.edit?.mask ? mask : null })
      : await generateCloudImages(common);
  } catch (err) {
    if (err instanceof CloudImageError) {
      return { ok: false, status: err.status, body: { error: err.message, kind: err.kind, detail: err.detail, warnings: v.warnings } };
    }
    throw err;
  }

  const latency = Date.now() - started;
  const group = randomUUID();
  const count = result.images.length;
  const costSource = result.costUsd != null ? "router" : "estimate";
  const costTotal = result.costUsd ?? estimate.usd;
  const outputs: Record<string, unknown>[] = [];
  for (let i = 0; i < count; i++) {
    const buf = result.images[i];
    const { width, height } = await dimensions(buf);
    const format = sniffImageFormat(buf) ?? "png";
    const cloudMeta = {
      alias: input.alias,
      vendor: spec.id,
      family: spec.family,
      params,
      requested: input.cloud ?? null,
      warnings: v.warnings,
      index: i + 1,
      count,
      group,
      costUsd: costTotal / count,
      costUsdTotal: costTotal,
      costSource,
      estimateUsd: estimate.usd,
      usage: result.usage,
      response: result.response,
      revisedPrompt: result.revisedPrompts[i] ?? null,
      transcoded: result.transcoded,
      source,
      sent: result.sent,
      ...(input.kind === "edit" ? { referenceCount: refs.length, mask: !!mask && !!spec.edit?.mask } : {}),
    };
    const saved = await saveImage(buf, {
      kind: input.kind,
      model: input.alias,
      prompt: input.prompt,
      negative_prompt: "",
      seed: input.seed,
      width: width ?? undefined,
      height: height ?? undefined,
      latency,
      folder: input.folder,
      ...(input.kind === "edit" ? { inputCount: refs.length } : {}),
      cloud: cloudMeta,
    });
    outputs.push({
      image: `data:${imageMime(format)};base64,${buf.toString("base64")}`,
      saved: saved?.file ?? null,
      savedPath: saved?.path ?? null,
      width,
      height,
      format,
      bytes: buf.length,
    });
  }

  const first = outputs[0];
  return {
    ok: true,
    status: 200,
    body: {
      status: "success",
      // The single-image fields every existing caller reads…
      image: first.image,
      saved: first.saved,
      savedPath: first.savedPath,
      bytes: first.bytes,
      width: first.width,
      height: first.height,
      // …and the rest of a multi-image result.
      images: outputs,
      latency,
      model: input.alias,
      prompt: input.prompt,
      seed: input.seed,
      cloud: {
        params,
        warnings: v.warnings,
        costUsd: costTotal,
        costSource,
        estimateUsd: estimate.usd,
        usage: result.usage,
        response: result.response,
        transcoded: result.transcoded,
        source,
      },
    },
  };
}
