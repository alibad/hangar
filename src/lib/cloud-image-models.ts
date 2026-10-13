// What every hosted image model accepts — one source of truth.
//
// The server validates against this before a request leaves the box, and the
// Image Studio draws its controls from it, so a control exists exactly when the
// model takes the parameter AND the AI Router can deliver it. Every value here
// was read off the vendor's own docs on 2026-10-03 (links per model, and the
// full table with the router findings in docs/cloud-image-params.md). Isomorphic:
// no Node imports, because the browser bundles it too.
//
// Keyed by VENDOR model id, not router alias: aliases are renamed in
// config/ai-router.yaml ("gemini-image" is gemini-3-pro-image), and the
// catalogue already says which vendor id each alias points at.

export type OutputFormat = "png" | "jpeg" | "webp";
export type CloudImageFamily = "openai" | "gemini";
export type CloudImageKind = "generate" | "edit";

/** The parameter set the console sends, after validation. All optional except n. */
export type CloudImageParams = {
  n: number;
  quality?: string;
  moderation?: string;
  background?: string;
  output_format?: OutputFormat;
  output_compression?: number;
  /** "WxH" or "auto" (OpenAI). */
  size?: string;
  /** Edits only (gpt-image-1, gpt-image-1.5). */
  input_fidelity?: string;
  /** Gemini imageConfig. */
  aspect_ratio?: string;
  image_size?: string;
  /** Gemini Google Search grounding (web). */
  web_search?: boolean;
};

export type SizeRule =
  /** A fixed list (plus "auto"). */
  | { kind: "fixed"; sizes: string[] }
  /** Any WxH within OpenAI's flexible-size constraints, plus "auto". */
  | { kind: "flexible"; presets: string[]; multipleOf: number; maxEdge: number; minPixels: number; maxPixels: number; maxRatio: number; experimentalAbovePixels: number }
  /** Gemini: aspect ratio + resolution tier instead of pixels. */
  | { kind: "gemini"; aspectRatios: string[]; imageSizes: string[] | null };

type Choice = { values: string[]; default: string };

type OpenAIPricing = {
  kind: "openai";
  /** $ per 1M tokens. */
  textIn: number;
  imageIn: number;
  imageOut: number;
  /**
   * OpenAI's calculator grid for flexible-size models (gpt-image-2 and 2.5):
   * base tiles per quality. Absent = the fixed-size token table (LEGACY_TOKENS).
   */
  grid?: Record<string, number>;
};

/**
 * Output image tokens for the pre-gpt-image-2 models, by quality, at
 * [square, portrait, landscape] (OpenAI's guide). Measured on gpt-image-1-mini
 * 2026-10-03: low 1024x1024 = 272 tokens, medium = 1056 — exactly this table.
 * Priced as tokens × the model's image-output rate, which is also what the
 * router charges; the guide's per-image table says $0.005 for 1-mini low, which
 * neither the rate nor the bill reproduces ($0.0022).
 */
const LEGACY_TOKENS: Record<string, [number, number, number]> = {
  low: [272, 408, 400],
  medium: [1056, 1584, 1568],
  high: [4160, 6240, 6208],
};
type GeminiPricing = {
  kind: "gemini";
  /** $ per output image, by imageSize ("default" when the model has no sizes). */
  perImage: Record<string, number>;
  /** $ per input (reference) image. */
  perInputImage: number;
};

export type CloudImageSpec = {
  /** Vendor model id. */
  id: string;
  family: CloudImageFamily;
  label: string;
  /** One line: what it is for, shown under the picker. */
  blurb: string;
  docs: string[];
  status?: "stable" | "preview" | "deprecated" | "undocumented";
  statusNote?: string;
  quality?: Choice;
  moderation?: Choice;
  background?: Choice & { transparentNote?: string };
  outputFormat?: { values: OutputFormat[]; default: OutputFormat };
  /** 0–100, jpeg/webp only. */
  outputCompression?: { min: 0; max: 100; default: 100 };
  size: SizeRule & { default: string };
  n: { max: number };
  webSearch?: boolean;
  edit: null | {
    maxImages: number;
    mask: boolean;
    inputFidelity?: Choice;
    note?: string;
  };
  pricing: OpenAIPricing | GeminiPricing;
};

// ── shared OpenAI pieces ─────────────────────────────────────────────────────

const OPENAI_DOCS = "https://developers.openai.com/api/docs/guides/image-generation";
const OPENAI_REF = "https://developers.openai.com/api/reference/resources/images";
const STANDARD_SIZES = ["1024x1024", "1536x1024", "1024x1536"];
const FLEXIBLE = {
  kind: "flexible" as const,
  multipleOf: 16,
  maxEdge: 3840,
  minPixels: 655_360,
  maxPixels: 8_294_400,
  maxRatio: 3,
  experimentalAbovePixels: 2560 * 1440,
};
const QUALITY_BASE: Choice = { values: ["auto", "low", "medium", "high"], default: "auto" };
const QUALITY_25: Choice = { values: ["auto", "low", "medium", "high", "xhigh", "max"], default: "auto" };
const MODERATION: Choice = { values: ["auto", "low"], default: "auto" };
const BACKGROUND: Choice = { values: ["auto", "opaque", "transparent"], default: "auto" };
const FORMAT = { values: ["png", "jpeg", "webp"] as OutputFormat[], default: "png" as OutputFormat };
const COMPRESSION = { min: 0 as const, max: 100 as const, default: 100 as const };
const OPENAI_EDIT = { maxImages: 16, mask: true };

function openai(
  id: string,
  label: string,
  blurb: string,
  extra: Omit<CloudImageSpec, "id" | "family" | "label" | "blurb" | "docs" | "moderation" | "background" | "outputFormat" | "outputCompression" | "n"> &
    Partial<Pick<CloudImageSpec, "background" | "status" | "statusNote">>,
): CloudImageSpec {
  return {
    id,
    family: "openai",
    label,
    blurb,
    docs: [`https://developers.openai.com/api/docs/models/${id}`, OPENAI_DOCS, OPENAI_REF],
    moderation: MODERATION,
    background: BACKGROUND,
    outputFormat: FORMAT,
    outputCompression: COMPRESSION,
    n: { max: 10 },
    ...extra,
  };
}

// ── shared Gemini pieces ─────────────────────────────────────────────────────

const GEMINI_DOCS = "https://ai.google.dev/gemini-api/docs/generate-content/image-generation";
const GEMINI_PRICE = "https://ai.google.dev/gemini-api/docs/pricing";
const RATIOS_10 = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
const RATIOS_14 = ["1:1", "1:4", "4:1", "1:8", "8:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];

function gemini(id: string, label: string, blurb: string, extra: Omit<CloudImageSpec, "id" | "family" | "label" | "blurb" | "docs" | "n"> & { docs?: string[] }): CloudImageSpec {
  return {
    id,
    family: "gemini",
    label,
    blurb,
    docs: [`https://ai.google.dev/gemini-api/docs/models/${id}`, GEMINI_DOCS, GEMINI_PRICE],
    // The router maps n to candidateCount, but Google documents no candidate
    // count above 1 for its image models (and says they "won't always follow"
    // a requested image count). It could not be measured: this box's key has a
    // zero image quota (docs/cloud-image-params.md). One image per call.
    n: { max: 1 },
    ...extra,
  };
}

const PRO_IMAGE_SPEC = (id: string, extra: Partial<CloudImageSpec> = {}): CloudImageSpec =>
  gemini(id, "Gemini 3 Pro Image", "Nano Banana Pro — best Gemini quality, thinks before drawing, 14 references.", {
    size: { kind: "gemini", aspectRatios: RATIOS_10, imageSizes: ["1K", "2K", "4K"], default: "1K" },
    webSearch: true,
    edit: { maxImages: 14, mask: false, note: "Up to 6 objects at high fidelity, 5 characters and 3 style references. No mask: describe the region in the prompt." },
    pricing: { kind: "gemini", perImage: { "1K": 0.134, "2K": 0.134, "4K": 0.24 }, perInputImage: 0.0011 },
    ...extra,
  });

export const CLOUD_IMAGE_SPECS: CloudImageSpec[] = [
  // ── OpenAI ──
  openai("gpt-image-2.5-sunburst", "GPT Image 2.5 Sunburst", "Editing precision first; up to max quality and 4K-class custom sizes.", {
    quality: QUALITY_25,
    size: { ...FLEXIBLE, presets: STANDARD_SIZES.concat(["2048x2048", "2048x1152", "1152x2048", "3840x2160", "2160x3840"]), default: "auto" },
    edit: { ...OPENAI_EDIT, note: "input_fidelity is not documented for 2.5, so it is not sent." },
    pricing: { kind: "openai", textIn: 5, imageIn: 8, imageOut: 30, grid: { low: 16, medium: 24, high: 48, xhigh: 64, max: 96 } },
  }),
  openai("gpt-image-2.5-flare", "GPT Image 2.5 Flare", "The fast everyday 2.5 model; same parameters as Sunburst.", {
    quality: QUALITY_25,
    size: { ...FLEXIBLE, presets: STANDARD_SIZES.concat(["2048x2048", "2048x1152", "1152x2048", "3840x2160", "2160x3840"]), default: "auto" },
    edit: { ...OPENAI_EDIT, note: "input_fidelity is not documented for 2.5, so it is not sent." },
    pricing: { kind: "openai", textIn: 5, imageIn: 8, imageOut: 30, grid: { low: 16, medium: 24, high: 48, xhigh: 64, max: 96 } },
  }),
  openai("gpt-image-2", "GPT Image 2", "Flexible sizes up to 4K; always reads references at high fidelity.", {
    quality: QUALITY_BASE,
    // Measured 2026-10-03 through the router: background=transparent is a 400
    // ("Transparent background is not supported for this model") on the Images
    // API. OpenAI's tool guide calls it a preview of the Responses API tool.
    background: { values: ["auto", "opaque"], default: "auto", transparentNote: "No transparent background on gpt-image-2 (the Images API refuses it)." },
    size: { ...FLEXIBLE, presets: STANDARD_SIZES.concat(["2048x2048", "2048x1152", "3840x2160", "2160x3840"]), default: "auto" },
    edit: { ...OPENAI_EDIT, note: "gpt-image-2 always uses high input fidelity; the parameter must be omitted." },
    pricing: { kind: "openai", textIn: 5, imageIn: 8, imageOut: 30, grid: { low: 16, medium: 48, high: 96 } },
  }),
  openai("gpt-image-1.5", "GPT Image 1.5", "Three fixed sizes; high input fidelity available for edits.", {
    quality: QUALITY_BASE,
    size: { kind: "fixed", sizes: STANDARD_SIZES, default: "auto" },
    edit: { ...OPENAI_EDIT, inputFidelity: { values: ["low", "high"], default: "low" } },
    pricing: { kind: "openai", textIn: 5, imageIn: 8, imageOut: 32 },
  }),
  openai("chatgpt-image-latest", "ChatGPT Image (latest)", "Whatever image model ChatGPT currently uses; priced like 1.5.", {
    quality: QUALITY_BASE,
    size: { kind: "fixed", sizes: STANDARD_SIZES, default: "auto" },
    edit: { ...OPENAI_EDIT, note: "input_fidelity is not listed for this model, so it is not sent." },
    pricing: { kind: "openai", textIn: 5, imageIn: 8, imageOut: 32 },
  }),
  openai("gpt-image-1", "GPT Image 1", "The original GPT image model; three fixed sizes.", {
    quality: QUALITY_BASE,
    size: { kind: "fixed", sizes: STANDARD_SIZES, default: "auto" },
    edit: { ...OPENAI_EDIT, inputFidelity: { values: ["low", "high"], default: "low" } },
    pricing: { kind: "openai", textIn: 5, imageIn: 10, imageOut: 40 },
  }),
  openai("gpt-image-1-mini", "GPT Image 1 mini", "Cheapest OpenAI image model; drafts and tests.", {
    quality: QUALITY_BASE,
    size: { kind: "fixed", sizes: STANDARD_SIZES, default: "auto" },
    // Only `low` is accepted, so there is nothing to choose — and nothing to send.
    edit: { ...OPENAI_EDIT, note: "gpt-image-1-mini accepts input_fidelity low only (the default), so it is not sent." },
    pricing: { kind: "openai", textIn: 2, imageIn: 2.5, imageOut: 8 },
  }),

  // ── Gemini ──
  PRO_IMAGE_SPEC("gemini-3-pro-image"),
  // Not documented on ai.google.dev (its model page 404s); the router prices it
  // exactly like gemini-3-pro-image, so it is described as that model.
  PRO_IMAGE_SPEC("nano-banana-pro-preview", {
    label: "Nano Banana Pro (preview id)",
    status: "undocumented",
    statusNote: "Not on ai.google.dev; treated as Gemini 3 Pro Image.",
    docs: ["https://ai.google.dev/gemini-api/docs/models/gemini-3-pro-image", GEMINI_DOCS, GEMINI_PRICE],
  }),
  gemini("gemini-3.1-flash-image", "Gemini 3.1 Flash Image", "Nano Banana 2 — fast, 512 to 4K, extreme aspect ratios.", {
    size: { kind: "gemini", aspectRatios: RATIOS_14, imageSizes: ["512", "1K", "2K", "4K"], default: "1K" },
    webSearch: true,
    edit: { maxImages: 14, mask: false, note: "Up to 10 objects and 4 characters. No mask: describe the region in the prompt." },
    pricing: { kind: "gemini", perImage: { "512": 0.045, "1K": 0.067, "2K": 0.101, "4K": 0.151 }, perInputImage: 0.00056 },
  }),
  gemini("gemini-3.1-flash-lite-image", "Gemini 3.1 Flash-Lite Image", "Nano Banana 2 Lite — cheapest Gemini, 1K only.", {
    size: { kind: "gemini", aspectRatios: RATIOS_14, imageSizes: ["1K"], default: "1K" },
    edit: { maxImages: 14, mask: false, note: "Google: not optimised for multiple reference inputs." },
    pricing: { kind: "gemini", perImage: { "1K": 0.0336 }, perInputImage: 0.00028 },
  }),
  gemini("gemini-2.5-flash-image", "Gemini 2.5 Flash Image", "The original Nano Banana; ~1024px, no resolution setting.", {
    status: "deprecated",
    statusNote: "Google lists its shutdown as 2 Oct 2026 (earliest). Prefer Gemini 3.1 Flash Image.",
    size: { kind: "gemini", aspectRatios: RATIOS_10, imageSizes: null, default: "default" },
    edit: { maxImages: 3, mask: false, note: "Works best with up to 3 references." },
    pricing: { kind: "gemini", perImage: { default: 0.039 }, perInputImage: 0.0003 },
  }),
];

const BY_ID = new Map(CLOUD_IMAGE_SPECS.map((s) => [s.id, s]));

/** Router aliases whose name is not the vendor id (config/ai-router.yaml), for when no catalogue target is at hand. */
const ALIAS_TO_VENDOR: Record<string, string> = {
  "gemini-image": "gemini-3-pro-image",
  "gemini-image-fast": "gemini-3.1-flash-image",
};

/**
 * The spec for a router alias. `target` is the catalogue's vendor id
 * ("openai/gpt-image-2"); pass it when known so a renamed alias still resolves.
 * Unknown models fall back by family to the most conservative spec, never to
 * "everything is allowed".
 */
export function resolveCloudImageSpec(alias: string, target?: string | null): CloudImageSpec {
  const vendor = target ? target.replace(/^[a-z_]+\//i, "") : "";
  const hit = BY_ID.get(vendor) ?? BY_ID.get(alias) ?? BY_ID.get(ALIAS_TO_VENDOR[alias] ?? "");
  if (hit) return hit;
  const name = vendor || alias;
  if (/gemini|nano-banana|imagen/i.test(name) || /^gemini\//i.test(target ?? "")) {
    return { ...BY_ID.get("gemini-3.1-flash-lite-image")!, id: name, label: name, status: "undocumented", statusNote: "Not in the console's registry; offering the safest Gemini subset.", size: { kind: "gemini", aspectRatios: RATIOS_10, imageSizes: null, default: "default" } };
  }
  return {
    ...BY_ID.get("gpt-image-1")!,
    id: name,
    label: name,
    status: "undocumented",
    statusNote: "Not in the console's registry; offering the parameters every GPT image model accepts.",
    edit: null,
  };
}

// ── sizes ────────────────────────────────────────────────────────────────────

export function parseSize(size: string): { w: number; h: number } | null {
  const m = /^(\d{2,5})x(\d{2,5})$/.exec(size.trim());
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
}

/** Why a WxH breaks a flexible-size rule; [] when it is valid. */
export function flexibleSizeProblems(rule: Extract<SizeRule, { kind: "flexible" }>, w: number, h: number): string[] {
  const problems: string[] = [];
  if (w % rule.multipleOf || h % rule.multipleOf) problems.push(`Width and height must both be multiples of ${rule.multipleOf}.`);
  if (Math.max(w, h) > rule.maxEdge) problems.push(`Neither edge may exceed ${rule.maxEdge}px.`);
  if (Math.max(w, h) / Math.min(w, h) > rule.maxRatio) problems.push(`Aspect ratio must be between 1:${rule.maxRatio} and ${rule.maxRatio}:1.`);
  if (w * h < rule.minPixels) problems.push(`At least ${rule.minPixels.toLocaleString("en-US")} pixels in total (e.g. 1024x640).`);
  if (w * h > rule.maxPixels) problems.push(`At most ${rule.maxPixels.toLocaleString("en-US")} pixels in total (3840x2160).`);
  return problems;
}

/**
 * The valid size closest to a requested width × height.
 *
 * For callers that speak pixels (Compare's 768², the Lab's square sizes, old
 * clients): fixed-size models snap to the nearest of their three shapes, as
 * hostedImageSize() always did; flexible ones keep the aspect ratio and are
 * scaled into the pixel budget on the 16px grid. Gemini sizes are not pixels.
 */
export function nearestValidSize(spec: CloudImageSpec, width: number, height: number): string | undefined {
  const rule = spec.size;
  if (rule.kind === "gemini") return undefined;
  const w0 = Math.max(1, width), h0 = Math.max(1, height);
  if (rule.kind === "fixed") {
    const ratio = w0 / h0;
    const target = ratio > 1.2 ? "1536x1024" : ratio < 1 / 1.2 ? "1024x1536" : "1024x1024";
    return rule.sizes.includes(target) ? target : rule.sizes[0];
  }
  const ratio = Math.min(rule.maxRatio, Math.max(1 / rule.maxRatio, w0 / h0));
  let px = Math.min(rule.maxPixels, Math.max(rule.minPixels, w0 * h0));
  let w = Math.sqrt(px * ratio), h = Math.sqrt(px / ratio);
  const edge = Math.max(w, h);
  if (edge > rule.maxEdge) { w *= rule.maxEdge / edge; h *= rule.maxEdge / edge; px = w * h; }
  const g = rule.multipleOf;
  let W = Math.max(g, Math.round(w / g) * g), H = Math.max(g, Math.round(h / g) * g);
  // Rounding can leave the budget by a sliver; walk back in one grid step at a time.
  for (let i = 0; i < 64 && W * H < rule.minPixels; i++) { if (W <= H && W + g <= rule.maxEdge) W += g; else H += g; }
  for (let i = 0; i < 64 && (W * H > rule.maxPixels || Math.max(W, H) > rule.maxEdge); i++) { if (W >= H) W -= g; else H -= g; }
  return `${W}x${H}`;
}

// ── validation ───────────────────────────────────────────────────────────────

export type CloudImageInput = Partial<Record<keyof CloudImageParams, unknown>> & {
  /** Legacy pixel request, used only when `size` is absent. */
  width?: unknown;
  height?: unknown;
};

export type CloudValidation =
  | { ok: true; params: CloudImageParams; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

const present = (v: unknown) => v !== undefined && v !== null && v !== "";

/**
 * Check a requested parameter set against one model.
 *
 * Wrong VALUES are errors (the call would 400 upstream, or worse, be silently
 * ignored). Parameters this model doesn't take are dropped with a warning
 * rather than failing the run: they are usually the leftover state of another
 * model in the same form, and refusing over them helps nobody.
 */
export function validateCloudImageParams(
  spec: CloudImageSpec,
  raw: CloudImageInput,
  ctx: { kind: CloudImageKind; imageCount?: number; hasMask?: boolean },
): CloudValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const params: CloudImageParams = { n: 1 };
  const drop = (key: string, why: string) => warnings.push(`${key} ignored: ${why}`);
  const choose = (key: keyof CloudImageParams, choice: Choice | undefined, label: string) => {
    const v = raw[key];
    if (!present(v)) return;
    if (!choice) return drop(String(key), `${spec.label} does not take ${label}.`);
    if (typeof v !== "string" || !choice.values.includes(v)) {
      errors.push(`${label} must be one of ${choice.values.join(", ")} for ${spec.label} (got ${JSON.stringify(v)}).`);
      return;
    }
    (params as Record<string, unknown>)[key] = v;
  };

  // n
  if (present(raw.n)) {
    const n = Number(raw.n);
    if (!Number.isInteger(n) || n < 1 || n > spec.n.max) errors.push(`n must be a whole number from 1 to ${spec.n.max} for ${spec.label}.`);
    else params.n = n;
  }

  choose("quality", spec.quality, "quality");
  choose("moderation", spec.moderation, "moderation");
  choose("background", spec.background, "background");

  // output format + compression
  if (present(raw.output_format)) {
    const f = raw.output_format;
    if (!spec.outputFormat) drop("output_format", `${spec.label} does not take an output format.`);
    else if (typeof f !== "string" || !(spec.outputFormat.values as string[]).includes(f)) errors.push(`output_format must be one of ${spec.outputFormat.values.join(", ")}.`);
    else params.output_format = f as OutputFormat;
  }
  if (present(raw.output_compression)) {
    const c = Number(raw.output_compression);
    if (!spec.outputCompression) drop("output_compression", `${spec.label} does not take compression.`);
    else if (!Number.isInteger(c) || c < 0 || c > 100) errors.push("output_compression must be a whole number from 0 to 100.");
    else if (params.output_format !== "jpeg" && params.output_format !== "webp") drop("output_compression", "compression applies to jpeg and webp only.");
    else params.output_compression = c;
  }
  if (params.background === "transparent" && params.output_format === "jpeg") {
    errors.push("A transparent background needs png or webp output; jpeg has no alpha channel.");
  }

  // size
  const rule = spec.size;
  if (rule.kind === "gemini") {
    if (present(raw.size)) drop("size", "Gemini takes an aspect ratio and a resolution, not pixels.");
    if (present(raw.aspect_ratio)) {
      const a = raw.aspect_ratio;
      if (typeof a !== "string" || !rule.aspectRatios.includes(a)) errors.push(`aspect_ratio must be one of ${rule.aspectRatios.join(", ")} for ${spec.label}.`);
      else params.aspect_ratio = a;
    }
    if (present(raw.image_size)) {
      const s = raw.image_size;
      if (!rule.imageSizes) drop("image_size", `${spec.label} has a single output resolution.`);
      else if (typeof s !== "string" || !rule.imageSizes.includes(s)) errors.push(`image_size must be one of ${rule.imageSizes.join(", ")} for ${spec.label} (uppercase K).`);
      else params.image_size = s;
    }
  } else {
    if (present(raw.aspect_ratio)) drop("aspect_ratio", `${spec.label} takes a pixel size.`);
    if (present(raw.image_size)) drop("image_size", `${spec.label} takes a pixel size.`);
    if (present(raw.size)) {
      const s = String(raw.size).trim();
      if (s === "auto") params.size = "auto";
      else if (rule.kind === "fixed") {
        if (rule.sizes.includes(s)) params.size = s;
        else errors.push(`size must be auto or one of ${rule.sizes.join(", ")} for ${spec.label}.`);
      } else {
        const d = parseSize(s);
        const problems = d ? flexibleSizeProblems(rule, d.w, d.h) : ["Use WIDTHxHEIGHT, e.g. 1536x864."];
        if (problems.length) errors.push(`size ${s}: ${problems.join(" ")}`);
        else {
          params.size = `${d!.w}x${d!.h}`;
          if (d!.w * d!.h > rule.experimentalAbovePixels) warnings.push(`size ${s} is above 2560x1440, which OpenAI calls experimental.`);
        }
      }
    } else if (present(raw.width) && present(raw.height)) {
      const snapped = nearestValidSize(spec, Number(raw.width), Number(raw.height));
      if (snapped) {
        params.size = snapped;
        if (snapped !== `${Number(raw.width)}x${Number(raw.height)}`) warnings.push(`${raw.width}x${raw.height} is not a size ${spec.label} accepts; using ${snapped}.`);
      }
    }
  }

  // Gemini grounding
  if (present(raw.web_search) && raw.web_search !== false) {
    if (!spec.webSearch) drop("web_search", `${spec.label} has no Google Search grounding.`);
    // The router's Gemini edit path forwards n, size and imageConfig only.
    else if (ctx.kind === "edit") drop("web_search", "the router does not forward grounding on edits.");
    else params.web_search = true;
  }

  // edits
  if (ctx.kind === "edit") {
    const e = spec.edit;
    if (!e) errors.push(`${spec.label} has no edit endpoint in the console.`);
    else {
      const count = ctx.imageCount ?? 0;
      if (count < 1 || count > e.maxImages) errors.push(`${spec.label} edits take 1 to ${e.maxImages} reference images (got ${count}).`);
      if (ctx.hasMask && !e.mask) warnings.push(`mask ignored: ${spec.label} has no mask input — describe the region in the prompt.`);
      if (present(raw.input_fidelity)) {
        if (!e.inputFidelity) drop("input_fidelity", e.note || `${spec.label} does not take input_fidelity.`);
        else choose("input_fidelity", e.inputFidelity, "input_fidelity");
      }
    }
  } else if (present(raw.input_fidelity)) {
    drop("input_fidelity", "it applies to edits only.");
  }

  return errors.length ? { ok: false, errors, warnings } : { ok: true, params, warnings };
}

/** The parameters a fresh form starts with: each one at the API's own default. */
export function defaultCloudImageParams(spec: CloudImageSpec): CloudImageParams {
  return {
    n: 1,
    ...(spec.quality ? { quality: spec.quality.default } : {}),
    ...(spec.moderation ? { moderation: spec.moderation.default } : {}),
    ...(spec.background ? { background: spec.background.default } : {}),
    ...(spec.outputFormat ? { output_format: spec.outputFormat.default } : {}),
    ...(spec.size.kind !== "gemini" ? { size: spec.size.default } : spec.size.imageSizes ? { image_size: spec.size.default } : {}),
  };
}

// ── cost ─────────────────────────────────────────────────────────────────────

/** OpenAI's own calculator (gpt-image-2 / 2.5): output image tokens for a size and quality. */
export function gridOutputTokens(base: number, width: number, height: number): number {
  const long = Math.max(width, height), short = Math.min(width, height);
  const s = base / (long / short);
  const l = Math.floor(s);
  const u = s - l === 0.5 ? l + (l % 2) : Math.round(s);
  const tiles = (width >= height ? base : u) * (width >= height ? u : base);
  return Math.ceil((tiles * (2_000_000 + width * height)) / 4_000_000);
}

export type CostEstimate = {
  /** Expected $ for the whole call. */
  usd: number;
  /** Range when a setting is "auto" (the model picks, so the price can land anywhere in it). */
  low: number;
  high: number;
  /** How the number was reached, for the tooltip. */
  basis: string;
  /** Reference-image input is approximated; the router's real cost replaces this after the run. */
  rough: boolean;
};

function standardIndex(size: string): 0 | 1 | 2 {
  const d = parseSize(size);
  if (!d) return 0;
  return d.w === d.h ? 0 : d.h > d.w ? 1 : 2;
}

/**
 * What a run should cost, before running it.
 *
 * Published per-image prices where OpenAI publishes them, OpenAI's calculator
 * formula for custom sizes, Google's per-image table for Gemini. Edits add an
 * approximation for the reference images, flagged as rough.
 */
export function estimateCloudImageCost(spec: CloudImageSpec, p: CloudImageParams, ctx: { kind: CloudImageKind; imageCount?: number; promptChars?: number } = { kind: "generate" }): CostEstimate {
  const n = p.n || 1;
  const refs = ctx.kind === "edit" ? Math.max(0, ctx.imageCount ?? 0) : 0;
  const pr = spec.pricing;

  if (pr.kind === "gemini") {
    const key = spec.size.kind === "gemini" && spec.size.imageSizes ? p.image_size || spec.size.default : "default";
    const per = pr.perImage[key] ?? Object.values(pr.perImage)[0];
    const usd = per * n + refs * pr.perInputImage;
    return { usd, low: usd, high: usd, basis: `Google's price: $${per} per ${key === "default" ? "" : key + " "}image${refs ? ` + $${pr.perInputImage} per reference` : ""}${p.web_search ? "; searches past the free 5,000/month are $14 per 1,000" : ""}.`, rough: false };
  }

  const qualities = spec.quality?.values.filter((q) => q !== "auto") ?? ["medium"];
  const qs = !p.quality || p.quality === "auto" ? qualities : [p.quality];
  const sizes = !p.size || p.size === "auto" ? STANDARD_SIZES : [p.size];
  const perImage = (q: string, size: string): number => {
    const d = parseSize(size) ?? { w: 1024, h: 1024 };
    const base = pr.grid?.[q];
    const tokens = base ? gridOutputTokens(base, d.w, d.h) : (LEGACY_TOKENS[q] ?? LEGACY_TOKENS.medium)[standardIndex(size)];
    return (tokens * pr.imageOut) / 1e6;
  };
  const prices = qs.flatMap((q) => sizes.map((s) => perImage(q, s)));
  const text = (((ctx.promptChars ?? 400) / 4) * pr.textIn) / 1e6;
  // A 1024² reference measured 1,024 input image tokens at low fidelity
  // (gpt-image-1-mini, 2026-10-03); OpenAI adds 4,160 for high fidelity, which
  // gpt-image-2 always uses. Larger references cost more, hence "approx.".
  const highFidelity = spec.id === "gpt-image-2" || p.input_fidelity === "high";
  const refUsd = refs * ((highFidelity ? 1024 + 4160 : 1024) * pr.imageIn) / 1e6;
  const low = Math.min(...prices) * n + text + refUsd;
  const high = Math.max(...prices) * n + text + refUsd;
  const mid = qs.length > 1 || sizes.length > 1 ? (low + high) / 2 : low;
  const what = qs.length > 1 ? "auto quality (low…high)" : `${qs[0]} quality`;
  return {
    usd: mid,
    low,
    high,
    basis: `${what}, ${sizes.length > 1 ? "auto size" : sizes[0]}, ×${n}${refs ? ` + ${refs} reference image${refs > 1 ? "s" : ""} (approx.)` : ""}: OpenAI's output-token count × $${pr.imageOut}/1M image tokens.`,
    rough: refs > 0,
  };
}

/** The parameters the router (LiteLLM 1.94.0) drops on /v1/images/edits — see docs/cloud-image-params.md. */
export const ROUTER_EDIT_DROPS = ["moderation", "output_format", "output_compression"] as const;
