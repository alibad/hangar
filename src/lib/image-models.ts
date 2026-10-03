// The image models the studio can generate with.
//
// These used to be two separate tabs — "Qwen Image" (a dedicated FastAPI service
// on :8021) and "Creative" (a hand-built FLUX workflow posted to ComfyUI on
// :8188). They were never the same model, but the second tab was a strictly
// weaker copy of the first's UI: no gallery, no queue, and history that died on
// reload. They're one tab now, and this is what the picker reads.
//
// FLUX.1 schnell was retired on 28 Sept: declared at 31.7 GB of VRAM it was
// refused every time the evaluation asked for it, and FLUX.2 Klein does the
// same fast-draft job in half the memory (docs/image-model-experiment-2026-09-26.md).

export type ImageModelId =
  | "qwen-image"
  | "qwen-image-2.1"
  | "flux2-klein-4b"
  | "hidream-o1"
  | "hidream-o1-dev"
  | "z-image-turbo";

export type ImageModel = {
  /** A local id, or a router alias when this is a cloud model. */
  id: string;
  name: string;
  /** Shown next to the name so the tradeoff is legible at the point of choosing. */
  tier: string;
  /**
   * Managed service that has to be running — used to gate the Generate button.
   * null for a cloud model: there is no local process, only the router.
   */
  serviceId: "qwen" | "comfyui" | null;
  /** Step presets offered in the picker; first entry is the default. */
  steps: number[];
  defaultCfg: number;
  /** Qwen takes a negative prompt and a cfg scale; distilled FLUX ignores both. */
  supportsNegative: boolean;
  supportsCfg: boolean;
  /** Image-to-image editing: the Qwen service's /edit, or ComfyUI reference images. */
  supportsEdit: boolean;
  /** Whether the batch queue can run this model. */
  supportsBatch: boolean;
};

/**
 * A model backed by a process on this box. The narrower `serviceId` is the whole
 * point: everything that health-checks or starts a backend (the batch queue, the
 * studio's service header) is only ever handed one of these, so it never has to
 * defend against the null a cloud model carries.
 */
export type LocalImageModel = ImageModel & { serviceId: "qwen" | "comfyui" };

export const IMAGE_MODELS: LocalImageModel[] = [
  // Tiers state what the 26 Sept evaluation measured, so the tradeoff is visible
  // where the model is picked (docs/image-model-experiment-2026-09-26.md).
  { id: "flux2-klein-4b", name: "FLUX.2 Klein 4B", tier: "4-step · fastest · generate + edit", serviceId: "comfyui", steps: [4], defaultCfg: 1, supportsNegative: false, supportsCfg: false, supportsEdit: true, supportsBatch: false },
  { id: "hidream-o1-dev", name: "HiDream-O1 Dev", tier: "8B FP8 · native 2K · English prompts only", serviceId: "comfyui", steps: [28], defaultCfg: 1, supportsNegative: false, supportsCfg: false, supportsEdit: false, supportsBatch: false },
  { id: "z-image-turbo", name: "Z-Image Turbo", tier: "6B NVFP4 · 8-step · best local text & Arabic", serviceId: "comfyui", steps: [8, 9], defaultCfg: 1, supportsNegative: false, supportsCfg: false, supportsEdit: false, supportsBatch: false },
  {
    id: "qwen-image",
    name: "Qwen-Image",
    tier: "20B · quality",
    serviceId: "qwen",
    steps: [28, 20, 40, 50],
    defaultCfg: 4.0,
    supportsNegative: true,
    supportsCfg: true,
    supportsEdit: true,
    supportsBatch: true,
  },
  // Added 28 Sept. Both edit through ComfyUI reference images, like Klein.
  // Qwen-Image 2.1 is #1 among open weights on Artificial Analysis for
  // generation and editing, and is licensed for NON-COMMERCIAL use only.
  { id: "qwen-image-2.1", name: "Qwen-Image 2.1", tier: "7B · generate + edit · non-commercial licence", serviceId: "comfyui", steps: [25], defaultCfg: 1, supportsNegative: false, supportsCfg: false, supportsEdit: true, supportsBatch: false },
  // The full (non-distilled) HiDream-O1: 40 steps at CFG 5, where Dev is 28 at 1.
  { id: "hidream-o1", name: "HiDream-O1", tier: "8B FP8 · full · native 2K · generate + edit", serviceId: "comfyui", steps: [40], defaultCfg: 5, supportsNegative: false, supportsCfg: false, supportsEdit: true, supportsBatch: false },
];

export const DEFAULT_IMAGE_MODEL: ImageModelId = "qwen-image";

/**
 * The local models that support a capability, as prose for the tooltip that
 * explains why a tab is disabled.
 *
 * Derived rather than written out, because the hardcoded version went stale
 * without anyone noticing: Batch said "runs on Qwen-Image. Select Qwen-Image to
 * use it." long after FLUX.1 schnell gained batch and the queue learned to
 * dispatch per-backend, so it named one of the two answers and sent you away
 * from the other.
 */
export function modelsSupporting(capability: "supportsEdit" | "supportsBatch"): string {
  const names = IMAGE_MODELS.filter((m) => m[capability]).map((m) => m.name);
  if (names.length === 0) return "no local model";
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Describe a cloud model reached through the AI Router.
 *
 * getImageModel() falls back to IMAGE_MODELS[0] for anything it doesn't know,
 * which for a router alias would quietly hand back Qwen-Image — claiming edit
 * and batch support the cloud model does not have, and gating Generate on the
 * :8021 service being up when the router is what actually matters.
 *
 * Batch and edit are false on purpose rather than unimplemented: the batch queue
 * dispatches per-backend across the LOCAL services and has no cloud path, and
 * editing needs an endpoint only the Qwen service and FLUX.2 Klein expose.
 */
export function cloudImageModel(alias: string, provider?: string): ImageModel {
  return {
    id: alias,
    name: alias,
    tier: provider ? `${provider} · cloud` : "cloud",
    serviceId: null,
    steps: [28, 20, 40],
    defaultCfg: 4.0,
    // The router runs with drop_params, so these are ignored rather than
    // rejected — but offering knobs that do nothing is worse than hiding them.
    supportsNegative: false,
    supportsCfg: false,
    supportsEdit: false,
    supportsBatch: false,
  };
}

/** Resolve a LOCAL model. Unknown ids fall back to Qwen-Image — callers that may
 *  be holding a router alias must check isImageModelId() first (image-gen does). */
export function getImageModel(id: string | null | undefined): LocalImageModel {
  return IMAGE_MODELS.find(m => m.id === id) ?? IMAGE_MODELS.find(m => m.id === DEFAULT_IMAGE_MODEL)!;
}

/**
 * The local model behind an id as the Labs name it, or null for a cloud alias.
 * The Lab lists ComfyUI's models by their served names (already local ids) and
 * the Qwen service by its router alias ("local-qwen-image"), so both map back
 * here; anything else is a router alias to send to the cloud unchanged.
 */
export function localImageModelFor(id: string): ImageModelId | null {
  if (isImageModelId(id)) return id;
  const stripped = id.replace(/^local-/, "");
  return isImageModelId(stripped) ? stripped : null;
}

/**
 * The size to ask a hosted image model for. Hosted APIs take a fixed set, not
 * any square: gpt-image-1-mini accepts only 1024x1024, 1536x1024 and 1024x1536,
 * and gpt-image-2 rejects 768x768 as "below the minimum pixel budget". Those
 * three are accepted everywhere, so snap to the one nearest in aspect ratio.
 * Local models keep the exact size they were asked for.
 */
export function hostedImageSize(width: number, height: number): string {
  const ratio = width / height;
  if (ratio > 1.2) return "1536x1024";
  if (ratio < 1 / 1.2) return "1024x1536";
  return "1024x1024";
}

export function isImageModelId(v: unknown): v is ImageModelId {
  return typeof v === "string" && IMAGE_MODELS.some(m => m.id === v);
}
