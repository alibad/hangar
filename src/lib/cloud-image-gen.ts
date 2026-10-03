// Hosted image models, called through the AI Router.
//
// The router (LiteLLM, config/ai-router.yaml) is the only place vendor ids and
// keys live, so every hosted image call goes through it — generations as JSON
// to /v1/images/generations, edits as multipart to /v1/images/edits. This
// module owns the wire format both ways: building the request from the
// validated parameter set (src/lib/cloud-image-models.ts), and turning the
// router's reply into image buffers, usage, cost and a readable error.
//
// What the router actually forwards was measured, not assumed — a throwaway
// LiteLLM 1.94.0 proxy pointed at an echo server, see docs/cloud-image-params.md:
//
//   • Generations: `background`, `moderation`, `output_format` and
//     `output_compression` sent at the TOP LEVEL are silently dropped (they are
//     in the gpt-image config's supported list but not in the image path's
//     default-param list, so they are neither mapped nor passed through). Sent
//     inside `extra_body`, they arrive at OpenAI intact. So they go in
//     extra_body, which also keeps working if the router is ever patched.
//   • Edits: `background`, `input_fidelity`, `quality`, `size`, `n`, several
//     `image[]` files and a `mask` are forwarded; `moderation`,
//     `output_format` and `output_compression` are dropped, and extra_body is
//     ignored on that path. They are still sent (a patched router forwards them),
//     and when the bytes come back in the wrong format the console transcodes
//     them itself and records that it did (see `transcoded`).
//   • Gemini: the router maps `n` to candidateCount and passes `imageConfig`
//     ({aspectRatio, imageSize}) through verbatim; nothing else reaches Google.

import { nodePostFull, type NodeResponse } from "@/lib/qwen-http";
import { sniffImageFormat, imageMime, type ImageFormat } from "@/lib/save-image";
import type { CloudImageParams, CloudImageSpec } from "@/lib/cloud-image-models";

/** X-Source for Activity. Callers pass a more specific one where they have it. */
export const DEFAULT_CLOUD_IMAGE_SOURCE = "console/image-studio";

export type CloudImageUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  inputTextTokens?: number;
  inputImageTokens?: number;
  outputImageTokens?: number;
};

export type CloudImageResult = {
  images: Buffer[];
  /** The router's own price for the whole call (x-litellm-response-cost), when it sent one. */
  costUsd: number | null;
  usage: CloudImageUsage | null;
  /** What the provider says it made: OpenAI echoes background/output_format/quality/size. */
  response: { background?: string; output_format?: string; quality?: string; size?: string };
  revisedPrompts: (string | null)[];
  /** Formats the console had to transcode to because the router dropped output_format. */
  transcoded: boolean;
  /** The exact body sent (images elided), for the sidecar. */
  sent: Record<string, unknown>;
};

/**
 * A failed hosted call, with a message written for a person.
 *
 * `kind: "safety"` is the one worth singling out: OpenAI's refusal reads as a
 * generic 400 from the router, and "Bad request" sends you hunting for a
 * malformed parameter when the actual problem is the prompt's wording.
 */
export class CloudImageError extends Error {
  // Plain fields, not constructor parameter properties: the node test runner
  // loads this file with type stripping, which cannot desugar those.
  readonly status: number;
  readonly kind: "safety" | "invalid" | "upstream" | "empty";
  readonly detail?: string;
  constructor(message: string, status: number, kind: CloudImageError["kind"], detail?: string) {
    super(message);
    this.name = "CloudImageError";
    this.status = status;
    this.kind = kind;
    this.detail = detail;
  }
}

export const SAFETY_MESSAGE =
  "The provider's safety system declined this request. If it's for a game, story or other fiction, say so in the prompt — " +
  "e.g. \"stylised fantasy game art of …\" or \"an illustrated scene from a fictional story …\" — and avoid real people's names, then try again.";

// ── request builders ────────────────────────────────────────────────────────

/** The JSON body for /v1/images/generations. Pure, so it is unit-tested as-is. */
export function buildGenerationBody(spec: CloudImageSpec, alias: string, prompt: string, p: CloudImageParams): Record<string, unknown> {
  if (spec.family === "gemini") {
    const imageConfig: Record<string, string> = {};
    if (p.aspect_ratio) imageConfig.aspectRatio = p.aspect_ratio;
    if (p.image_size) imageConfig.imageSize = p.image_size;
    return {
      model: alias,
      prompt,
      ...(p.n > 1 ? { n: p.n } : {}),
      ...(Object.keys(imageConfig).length ? { imageConfig } : {}),
      // LiteLLM turns this into tools: [{ googleSearch: {} }] (probed).
      ...(p.web_search ? { web_search_options: {} } : {}),
    };
  }
  const extra: Record<string, unknown> = {};
  if (p.background) extra.background = p.background;
  if (p.moderation) extra.moderation = p.moderation;
  if (p.output_format) extra.output_format = p.output_format;
  if (p.output_compression != null) extra.output_compression = p.output_compression;
  return {
    model: alias,
    prompt,
    n: p.n,
    ...(p.quality ? { quality: p.quality } : {}),
    ...(p.size ? { size: p.size } : {}),
    // See the header: top-level copies of these are dropped by LiteLLM 1.94.0.
    ...(Object.keys(extra).length ? { extra_body: extra } : {}),
  };
}

export type EditInput = { bytes: Buffer; mime: string; name?: string };

/**
 * The multipart body for /v1/images/edits.
 *
 * Built by hand rather than with FormData + fetch: fetch runs on undici, whose
 * headersTimeout kills a long call at 300s (see qwen-http.ts), and a high-
 * quality multi-reference edit can take that long. Field names are OpenAI's:
 * `image[]` once per reference, `mask` once.
 */
export function buildEditForm(
  spec: CloudImageSpec,
  alias: string,
  prompt: string,
  p: CloudImageParams,
  images: EditInput[],
  mask?: EditInput | null,
  boundary = `----betenshi${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`,
): { body: Buffer; contentType: string; fields: Record<string, string>; files: { field: string; name: string; mime: string; bytes: number }[] } {
  const fields: Record<string, string> = { model: alias, prompt };
  if (spec.family === "gemini") {
    const imageConfig: Record<string, string> = {};
    if (p.aspect_ratio) imageConfig.aspectRatio = p.aspect_ratio;
    if (p.image_size) imageConfig.imageSize = p.image_size;
    if (Object.keys(imageConfig).length) fields.imageConfig = JSON.stringify(imageConfig);
  } else {
    fields.n = String(p.n);
    if (p.quality) fields.quality = p.quality;
    if (p.size) fields.size = p.size;
    if (p.background) fields.background = p.background;
    if (p.input_fidelity) fields.input_fidelity = p.input_fidelity;
    // Dropped by LiteLLM 1.94.0 on this path (see header); sent so a patched
    // router forwards them without a console change.
    if (p.moderation) fields.moderation = p.moderation;
    if (p.output_format) fields.output_format = p.output_format;
    if (p.output_compression != null) fields.output_compression = String(p.output_compression);
  }

  const parts: Buffer[] = [];
  const files: { field: string; name: string; mime: string; bytes: number }[] = [];
  const crlf = "\r\n";
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}${crlf}Content-Disposition: form-data; name="${name}"${crlf}${crlf}${value}${crlf}`, "utf8"));
  }
  const addFile = (field: string, f: EditInput, fallback: string) => {
    const ext = f.mime === "image/jpeg" ? "jpg" : f.mime === "image/webp" ? "webp" : "png";
    const name = (f.name || `${fallback}.${ext}`).replace(/["\r\n]/g, "_");
    parts.push(Buffer.from(`--${boundary}${crlf}Content-Disposition: form-data; name="${field}"; filename="${name}"${crlf}Content-Type: ${f.mime}${crlf}${crlf}`, "utf8"));
    parts.push(f.bytes);
    parts.push(Buffer.from(crlf, "utf8"));
    files.push({ field, name, mime: f.mime, bytes: f.bytes.length });
  };
  images.forEach((img, i) => addFile("image[]", img, `reference-${i + 1}`));
  // Gemini has no mask; the router would drop it, so don't upload it.
  if (mask && spec.family !== "gemini") addFile("mask", mask, "mask");
  parts.push(Buffer.from(`--${boundary}--${crlf}`, "utf8"));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}`, fields, files };
}

/** Decode a `data:image/...;base64,` URL (what the studio holds) into bytes + mime. */
export function decodeDataUrl(url: string): EditInput | null {
  const m = /^data:([a-z0-9.+/-]+);base64,([\s\S]+)$/i.exec(url.trim());
  if (!m) return null;
  const bytes = Buffer.from(m[2], "base64");
  const sniffed = sniffImageFormat(bytes);
  if (!sniffed) return null; // only PNG, JPEG and WebP are accepted upstream
  return { bytes, mime: imageMime(sniffed) };
}

// ── response parsing ────────────────────────────────────────────────────────

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Read token usage from either OpenAI's image shape or LiteLLM's chat-like one. */
export function readUsage(u: unknown): CloudImageUsage | null {
  if (!u || typeof u !== "object") return null;
  const r = u as Record<string, unknown>;
  const inDetails = (r.input_tokens_details ?? r.prompt_tokens_details) as Record<string, unknown> | undefined;
  const outDetails = (r.output_tokens_details ?? r.completion_tokens_details) as Record<string, unknown> | undefined;
  const usage: CloudImageUsage = {
    inputTokens: num(r.input_tokens) ?? num(r.prompt_tokens),
    outputTokens: num(r.output_tokens) ?? num(r.completion_tokens),
    totalTokens: num(r.total_tokens),
    inputTextTokens: num(inDetails?.text_tokens),
    inputImageTokens: num(inDetails?.image_tokens),
    outputImageTokens: num(outDetails?.image_tokens),
  };
  return Object.values(usage).some((v) => v !== undefined) ? usage : null;
}

/** Whether an error body is a provider safety refusal rather than a bad parameter. */
export function isSafetyRefusal(text: string): boolean {
  return /moderation_blocked|safety[_ ]system|content_policy_violation|safety_violations|rejected by the safety|IMAGE_SAFETY|PROHIBITED_CONTENT|blocked by .*safety/i.test(text);
}

/** Turn a non-200 router reply into a CloudImageError a person can act on. */
export function routerError(res: NodeResponse): CloudImageError {
  const raw = res.body.toString("utf8");
  let message = raw;
  try {
    const j = JSON.parse(raw);
    const m = j?.error?.message ?? j?.detail ?? j?.message;
    if (typeof m === "string" && m) message = m;
  } catch { /* not JSON — keep the text */ }
  if (isSafetyRefusal(raw)) return new CloudImageError(SAFETY_MESSAGE, 400, "safety", message.slice(0, 2000));
  if (res.status === 429 && /free_tier|limit: 0/i.test(raw)) {
    // Measured 2026-10-03: every Gemini image alias answers this, because the
    // key's free tier has an image quota of zero. Retrying cannot fix it.
    return new CloudImageError(
      "The provider refused on quota: this API key is on the free tier, whose image-generation quota is 0. Enable billing for the key (for Gemini: ai.dev → billing), then retry.",
      429,
      "upstream",
      message.slice(0, 2000),
    );
  }
  // litellm prefixes "litellm.BadRequestError: OpenAIException - "; the useful
  // part is what OpenAI said, so strip the wrapper.
  const clean = message.replace(/^litellm\.\w+:\s*/i, "").replace(/^\w+Exception\s*-\s*/i, "").trim();
  const status = res.status >= 400 && res.status < 600 ? res.status : 502;
  return new CloudImageError(`AI Router ${res.status}: ${clean.slice(0, 600)}`, status, status === 400 ? "invalid" : "upstream", message.slice(0, 2000));
}

/**
 * Parse a 200 from the router: decode every image, read usage, cost and what
 * the provider says it produced, and transcode when the bytes are not in the
 * format that was asked for (the edit path drops output_format — see header).
 */
export async function parseImageResponse(
  res: NodeResponse,
  want: { format?: ImageFormat; compression?: number },
): Promise<Omit<CloudImageResult, "sent">> {
  if (res.status !== 200) throw routerError(res);
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(res.body.toString("utf8"));
  } catch {
    throw new CloudImageError("AI Router returned something that isn't JSON", 502, "upstream");
  }
  const data = Array.isArray(json.data) ? (json.data as Record<string, unknown>[]) : [];
  let images: Buffer[] = [];
  for (const d of data) {
    if (typeof d.b64_json !== "string" || !d.b64_json) continue;
    const b: Buffer = Buffer.from(d.b64_json, "base64");
    if (b.length) images.push(b);
  }
  if (!images.length) {
    // Gemini answers a blocked prompt with no image part at all, which LiteLLM
    // passes on as an empty data array — not an error status.
    throw new CloudImageError(
      "The model returned no image. Gemini does this when its safety filter blocks a prompt — " + SAFETY_MESSAGE.split(". ").slice(1).join(". "),
      502,
      "empty",
    );
  }

  let transcoded = false;
  if (want.format) {
    const needs = images.some((b) => sniffImageFormat(b) !== want.format);
    if (needs) {
      const sharp = (await import("sharp")).default;
      const q = want.compression != null ? Math.max(1, Math.min(100, 100 - want.compression)) : undefined;
      images = await Promise.all(
        images.map(async (b): Promise<Buffer> => {
          if (sniffImageFormat(b) === want.format) return b;
          const img = sharp(b);
          if (want.format === "jpeg") return img.flatten({ background: "#ffffff" }).jpeg(q ? { quality: q } : {}).toBuffer();
          if (want.format === "webp") return img.webp(q ? { quality: q } : {}).toBuffer();
          return img.png().toBuffer();
        }),
      );
      transcoded = true;
    }
  }

  const header = res.headers["x-litellm-response-cost"];
  const cost = Number(Array.isArray(header) ? header[0] : header);
  return {
    images,
    costUsd: Number.isFinite(cost) && header != null && header !== "" ? cost : null,
    usage: readUsage(json.usage),
    response: {
      ...(typeof json.background === "string" ? { background: json.background } : {}),
      ...(typeof json.output_format === "string" ? { output_format: json.output_format } : {}),
      ...(typeof json.quality === "string" ? { quality: json.quality } : {}),
      ...(typeof json.size === "string" ? { size: json.size } : {}),
    },
    revisedPrompts: data.map((d) => (typeof d.revised_prompt === "string" ? d.revised_prompt : null)),
    transcoded,
  };
}

// ── calls ───────────────────────────────────────────────────────────────────

type CallOpts = {
  alias: string;
  spec: CloudImageSpec;
  prompt: string;
  params: CloudImageParams;
  /** X-Source, so Activity attributes the spend. */
  source?: string;
  signal?: AbortSignal;
  /** Router base URL; tests point this at a mock. */
  baseUrl: string;
};

export async function generateCloudImages(o: CallOpts): Promise<CloudImageResult> {
  const sent = buildGenerationBody(o.spec, o.alias, o.prompt, o.params);
  const res = await nodePostFull(
    `${o.baseUrl}/v1/images/generations`,
    JSON.stringify(sent),
    { "Content-Type": "application/json", "X-Source": o.source || DEFAULT_CLOUD_IMAGE_SOURCE },
    o.signal,
    "AI Router",
  );
  const parsed = await parseImageResponse(res, { format: o.params.output_format, compression: o.params.output_compression });
  return { ...parsed, sent };
}

export async function editCloudImages(o: CallOpts & { images: EditInput[]; mask?: EditInput | null }): Promise<CloudImageResult> {
  const form = buildEditForm(o.spec, o.alias, o.prompt, o.params, o.images, o.mask);
  const res = await nodePostFull(
    `${o.baseUrl}/v1/images/edits`,
    form.body,
    { "Content-Type": form.contentType, "X-Source": o.source || DEFAULT_CLOUD_IMAGE_SOURCE },
    o.signal,
    "AI Router",
  );
  const parsed = await parseImageResponse(res, { format: o.params.output_format, compression: o.params.output_compression });
  return { ...parsed, sent: { ...form.fields, files: form.files } };
}
