// The image models the studio can generate with.
//
// These used to be two separate tabs — "Qwen Image" (a dedicated FastAPI service
// on :8021) and "Creative" (a hand-built FLUX workflow posted to ComfyUI on
// :8188). They were never the same model, but the second tab was a strictly
// weaker copy of the first's UI: no gallery, no queue, and history that died on
// reload. They're one tab now, and this is what the picker reads.
//
// The real axis between them is speed, not capability: FLUX schnell is a 4-step
// distilled model, Qwen-Image is a 28-step 20B. Keep both.

export type ImageModelId = "qwen-image" | "flux-schnell";

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
  /** Image-to-image editing — only the Qwen service exposes an /edit endpoint. */
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
  {
    id: "flux-schnell",
    name: "FLUX.1 schnell",
    tier: "4-step · fast draft",
    serviceId: "comfyui",
    steps: [4, 8, 12],
    defaultCfg: 1.0,
    supportsNegative: false,
    supportsCfg: false,
    supportsEdit: false,
    supportsBatch: true,
  },
];

export const DEFAULT_IMAGE_MODEL: ImageModelId = "qwen-image";

/**
 * Describe a cloud model reached through the AI Router.
 *
 * getImageModel() falls back to IMAGE_MODELS[0] for anything it doesn't know,
 * which for a router alias would quietly hand back Qwen-Image — claiming edit
 * and batch support the cloud model does not have, and gating Generate on the
 * :8021 service being up when the router is what actually matters.
 *
 * Batch and edit are false on purpose rather than unimplemented: the batch queue
 * drives :8021 directly and only the Qwen service exposes /edit.
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
  return IMAGE_MODELS.find(m => m.id === id) ?? IMAGE_MODELS[0];
}

export function isImageModelId(v: unknown): v is ImageModelId {
  return typeof v === "string" && IMAGE_MODELS.some(m => m.id === v);
}
