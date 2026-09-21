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

export type ImageModelId = "qwen-image" | "flux-schnell" | "flux2-klein-4b" | "hidream-o1-dev" | "z-image-turbo" | "draw-things-flux2-klein";

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

/**
 * Resolved in next.config.ts and published as a plain string, the same way the
 * host id is. NOT read from src/lib/runtimes.ts: this module is imported by a
 * bundler-free `node --test` suite, where a relative TypeScript import chain
 * does not resolve.
 */
const IMAGE_RUNTIME: { driver: string | null; label: string | null } = (() => {
  try {
    return JSON.parse(process.env.NEXT_PUBLIC_IMAGE_RUNTIME || "{}");
  } catch {
    return { driver: null, label: null };
  }
})();

const IMAGE_DRIVER = IMAGE_RUNTIME.driver;

const NVIDIA_IMAGE_MODELS: LocalImageModel[] = [
  { id: "flux2-klein-4b", name: "FLUX.2 Klein 4B", tier: "4-step · generate + edit", serviceId: "comfyui", steps: [4], defaultCfg: 1, supportsNegative: false, supportsCfg: false, supportsEdit: true, supportsBatch: false },
  { id: "hidream-o1-dev", name: "HiDream-O1 Dev", tier: "8B FP8 · native 2K · experimental", serviceId: "comfyui", steps: [28], defaultCfg: 1, supportsNegative: false, supportsCfg: false, supportsEdit: false, supportsBatch: false },
  { id: "z-image-turbo", name: "Z-Image Turbo", tier: "6B NVFP4 · 8-step fast draft", serviceId: "comfyui", steps: [8, 9], defaultCfg: 1, supportsNegative: false, supportsCfg: false, supportsEdit: false, supportsBatch: false },
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

/**
 * B5 already has Draw Things and its verified native FLUX.2 checkpoint. The
 * local adapter occupies the established `qwen` image-service slot so the same
 * gallery, queue, edit and lifecycle code works without pretending CUDA-only
 * ComfyUI or Qwen checkpoints exist on the Mac.
 */
const APPLE_IMAGE_MODELS: LocalImageModel[] = [
  {
    // The id is historical and deliberately unchanged: it is written into every
    // gallery row and DuckDB record this machine has produced, and renaming it
    // would orphan them. The NAME comes from the profile, so the card says
    // which engine is really behind it today.
    id: "draw-things-flux2-klein",
    name: IMAGE_RUNTIME.label ?? "Local image model",
    tier: IMAGE_RUNTIME.driver ? `${IMAGE_RUNTIME.driver} · generate + edit` : "local · generate + edit",
    serviceId: "qwen",
    steps: [4, 6, 8],
    defaultCfg: 1,
    supportsNegative: false,
    supportsCfg: false,
    supportsEdit: true,
    supportsBatch: true,
  },
];

/**
 * Which list this host uses, decided by its DECLARED IMAGE DRIVER.
 *
 * This was `process.env.NEXT_PUBLIC_HOST_ID === "b5"` — one machine's name,
 * compiled into a module that decides what every machine can generate with.
 * Any other Mac got BeTenshi's CUDA-only ComfyUI checkpoints offered to it, and
 * B5 could not be moved off Draw Things without editing this file.
 *
 * The driver is the honest axis anyway: what distinguishes these lists is not
 * Apple-versus-NVIDIA, it is whether images come from a ComfyUI graph or from a
 * single-model local engine. A Linux box running mflux would want the second
 * list, and it now gets it without this module learning its hostname.
 */
const SINGLE_MODEL_DRIVERS = ["mflux", "draw-things-cli", "draw-things-app"] as const;
const USES_SINGLE_MODEL = SINGLE_MODEL_DRIVERS.includes(IMAGE_DRIVER as (typeof SINGLE_MODEL_DRIVERS)[number]);

export const IMAGE_MODELS: LocalImageModel[] = USES_SINGLE_MODEL ? APPLE_IMAGE_MODELS : NVIDIA_IMAGE_MODELS;
export const DEFAULT_IMAGE_MODEL: ImageModelId = USES_SINGLE_MODEL ? "draw-things-flux2-klein" : "qwen-image";

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

export function isImageModelId(v: unknown): v is ImageModelId {
  return typeof v === "string" && IMAGE_MODELS.some(m => m.id === v);
}
