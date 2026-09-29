/**
 * The video models the Video Lab can run, and the arithmetic each one needs.
 *
 * Pure data and pure functions, no imports at all, so the browser, the server
 * and scripts/video-lab.test.mjs all read the same file. What is INSTALLED on a
 * machine is not decided here: the server asks ComfyUI which weight files it
 * can see (`installedIn`), and the host profile says which ids a machine
 * serves. This file only says what each model is and how to drive it.
 *
 * Every local model runs as a ComfyUI graph (src/lib/comfy-video-workflows.ts)
 * derived from Comfy-Org's own templates, not a bespoke service.
 */

export type VideoMode = "t2v" | "i2v";
export type VideoBackend = "comfyui" | "gemini";
export type VideoTier = "low" | "high";

export type VideoResolution = { tier: VideoTier; width: number; height: number; label: string };

export type VideoModelSpec = {
  /** Also the served-model name in `serves.video` and the key into model-meta (`local-<id>`). */
  id: string;
  label: string;
  /** Short line for the picker. */
  blurb: string;
  local: boolean;
  backend: VideoBackend;
  modes: VideoMode[];
  /** Output frame rate. Wan 2.2 14B is a 16 fps model; the rest are 24. */
  fps: number;
  /** Generates a soundtrack in the same pass. */
  audio: boolean;
  /** 16:9 landscape presets, low (~480p) and high (~720p). */
  resolutions: VideoResolution[];
  /** Seconds the model was trained around, and the most the Lab will ask for. */
  nativeSeconds: number;
  maxSeconds: number;
  /** Cloud models only accept a fixed set of lengths. */
  allowedSeconds?: number[];
  /** Sampling steps the graph uses (distilled / turbo settings). */
  steps: number;
  /** Weight files ComfyUI must list for the model to be runnable, by folder. */
  files: Partial<Record<ComfyFolder, string[]>>;
  /** Resource-policy workload the run leases. */
  workload?: string;
  /** Cloud price per second of output video, USD, for the default resolution. */
  usdPerSecond?: number;
  /** Plain-language licence summary; the model-meta entry carries the detail. */
  licence: string;
  /** Anything a person should know before pressing Run. */
  caveat?: string;
};

export type ComfyFolder =
  | "diffusion_models"
  | "text_encoders"
  | "vae"
  | "loras"
  | "latent_upscale_models"
  | "clip_vision";

const r = (tier: VideoTier, width: number, height: number): VideoResolution => ({
  tier,
  width,
  height,
  label: `${width}×${height}`,
});

export const VIDEO_MODELS: VideoModelSpec[] = [
  {
    id: "wan2.2-ti2v-5b",
    label: "Wan 2.2 TI2V 5B",
    blurb: "Small, fast, text or image to 720p at 24 fps",
    local: true,
    backend: "comfyui",
    modes: ["t2v", "i2v"],
    fps: 24,
    audio: false,
    resolutions: [r("low", 832, 480), r("high", 1280, 704)],
    nativeSeconds: 5,
    maxSeconds: 10,
    steps: 20,
    files: {
      diffusion_models: ["wan2.2_ti2v_5B_fp16.safetensors"],
      text_encoders: ["umt5_xxl_fp8_e4m3fn_scaled.safetensors"],
      vae: ["wan2.2_vae.safetensors"],
    },
    workload: "video-wan5b",
    licence: "Apache 2.0",
  },
  {
    id: "wan2.2-14b",
    label: "Wan 2.2 14B (4-step)",
    blurb: "Two-expert 14B MoE with the lightx2v 4-step LoRAs, 16 fps",
    local: true,
    backend: "comfyui",
    modes: ["t2v", "i2v"],
    fps: 16,
    audio: false,
    resolutions: [r("low", 832, 480), r("high", 1280, 720)],
    nativeSeconds: 5,
    maxSeconds: 10,
    steps: 4,
    files: {
      diffusion_models: [
        "wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors",
        "wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors",
        "wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors",
        "wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors",
      ],
      loras: [
        "wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors",
        "wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors",
        "wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors",
        "wan2.2_t2v_lightx2v_4steps_lora_v1.1_low_noise.safetensors",
      ],
      text_encoders: ["umt5_xxl_fp8_e4m3fn_scaled.safetensors"],
      vae: ["wan_2.1_vae.safetensors"],
    },
    workload: "video-wan14b",
    licence: "Apache 2.0",
  },
  {
    id: "ltx-2.5",
    label: "LTX-2.5 22B distilled",
    blurb: "Video and audio in one pass; half-res draft, then ×2 latent upscale",
    local: true,
    backend: "comfyui",
    modes: ["t2v", "i2v"],
    fps: 24,
    audio: true,
    resolutions: [r("low", 832, 448), r("high", 1280, 704)],
    nativeSeconds: 5,
    maxSeconds: 15,
    steps: 8,
    files: {
      diffusion_models: ["ltx-2.5-22b-distilled-transformer-nvfp4.safetensors"],
      text_encoders: ["gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors"],
      vae: ["ltx-2.5-video-vae-bf16.safetensors", "ltx-2.5-audio-vae-bf16.safetensors"],
      latent_upscale_models: ["ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors"],
    },
    workload: "video-ltx",
    licence: "LTX-2.x Community (free under $10M revenue)",
  },
  {
    id: "hunyuanvideo-1.5",
    label: "HunyuanVideo 1.5 480p",
    blurb: "8.3B; step-distilled image-to-video, 4-step LoRA for text-to-video",
    local: true,
    backend: "comfyui",
    modes: ["t2v", "i2v"],
    fps: 24,
    audio: false,
    // Only the 480p checkpoints are installed; 720p needs a different set.
    resolutions: [r("low", 848, 480)],
    nativeSeconds: 5,
    maxSeconds: 10,
    steps: 8,
    files: {
      diffusion_models: [
        "hunyuanvideo1.5_480p_i2v_step_distilled_fp8_scaled.safetensors",
        "hunyuanvideo1.5_480p_t2v_cfg_distilled_fp8_scaled.safetensors",
      ],
      loras: ["hunyuanvideo1.5_t2v_480p_lightx2v_4step_lora_rank_32_bf16.safetensors"],
      text_encoders: ["qwen_2.5_vl_7b_fp8_scaled.safetensors", "byt5_small_glyphxl_fp16.safetensors"],
      vae: ["hunyuanvideo15_vae_fp16.safetensors"],
      clip_vision: ["sigclip_vision_patch14_384.safetensors"],
    },
    workload: "video-hunyuan",
    licence: "Tencent Hunyuan Community (excludes EU, UK, South Korea)",
  },
  {
    id: "minimax-h3",
    label: "MiniMax H3 (pruned FP8, 8-step)",
    blurb: "33B omni model, stereo audio, up to 15 s; the heaviest here",
    local: true,
    backend: "comfyui",
    modes: ["t2v", "i2v"],
    fps: 24,
    audio: true,
    resolutions: [r("low", 864, 480), r("high", 1344, 768)],
    nativeSeconds: 5,
    maxSeconds: 15,
    steps: 8,
    files: {
      diffusion_models: ["minimax_h3_fl2va_pruned_fp8_scaled.safetensors"],
      text_encoders: ["qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"],
      vae: ["minimax_h3_video_vae_fp16.safetensors", "minimax_h3_audio_vae_fp32.safetensors"],
      loras: ["minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors"],
    },
    workload: "video-h3",
    licence: "MiniMax H3 Community (excludes USA, EU, UK, South Korea)",
    caveat:
      "The licence grants no rights in the USA, EU, UK or South Korea — including displaying outputs there.",
  },
  {
    id: "veo-3.1-fast",
    label: "Veo 3.1 Fast (cloud)",
    blurb: "Google, via the Gemini API; 720p with audio",
    local: false,
    backend: "gemini",
    modes: ["t2v", "i2v"],
    fps: 24,
    audio: true,
    resolutions: [r("high", 1280, 720)],
    nativeSeconds: 8,
    maxSeconds: 8,
    allowedSeconds: [4, 6, 8],
    steps: 0,
    files: {},
    usdPerSecond: 0.1,
    licence: "Google API terms",
  },
  {
    id: "veo-3.1-lite",
    label: "Veo 3.1 Lite (cloud)",
    blurb: "Google's cheapest video tier; 720p with audio",
    local: false,
    backend: "gemini",
    modes: ["t2v", "i2v"],
    fps: 24,
    audio: true,
    resolutions: [r("high", 1280, 720)],
    nativeSeconds: 8,
    maxSeconds: 8,
    allowedSeconds: [4, 6, 8],
    steps: 0,
    files: {},
    usdPerSecond: 0.05,
    licence: "Google API terms",
  },
];

export function getVideoModel(id: string): VideoModelSpec | undefined {
  return VIDEO_MODELS.find((m) => m.id === id);
}

/**
 * Frame count for `seconds` of video, rounded to what the model's latent
 * layout accepts. Each family packs time differently:
 *  - Wan and HunyuanVideo compress time 4×, so length must be 4k+1.
 *  - LTX compresses 8×: length must be 8k+1.
 *  - MiniMax H3's template rounds to its own grid (length ≡ 5 mod 17 steps),
 *    reproduced exactly from Comfy-Org's video_minimax_h3 templates.
 */
export function framesFor(spec: VideoModelSpec, seconds: number): number {
  const raw = Math.max(1, Math.round(seconds * spec.fps));
  if (spec.id === "minimax-h3") {
    const base = Math.max(5, raw);
    return base + ((5 - (base % 17)) % 17 + 17) % 17;
  }
  const step = spec.id === "ltx-2.5" ? 8 : 4;
  return Math.round(raw / step) * step + 1;
}

/** Seconds a request is clamped to for this model. */
export function clampSeconds(spec: VideoModelSpec, seconds: number): number {
  if (spec.allowedSeconds?.length) {
    return spec.allowedSeconds.reduce((best, s) => (Math.abs(s - seconds) < Math.abs(best - seconds) ? s : best));
  }
  return Math.min(spec.maxSeconds, Math.max(1, Math.round(seconds)));
}

export function resolutionFor(spec: VideoModelSpec, tier: VideoTier): VideoResolution {
  return spec.resolutions.find((x) => x.tier === tier) ?? spec.resolutions[spec.resolutions.length - 1];
}

/** Every weight file a model needs, flattened, with its folder. */
export function requiredFiles(spec: VideoModelSpec): { folder: ComfyFolder; file: string }[] {
  return Object.entries(spec.files).flatMap(([folder, files]) =>
    (files ?? []).map((file) => ({ folder: folder as ComfyFolder, file })),
  );
}

/** Seconds of video produced per minute of wall-clock — the headline number. */
export function videoSecondsPerMinute(videoSeconds: number, latencyMs: number): number | null {
  if (!latencyMs || latencyMs <= 0) return null;
  return Math.round((videoSeconds / (latencyMs / 60_000)) * 100) / 100;
}
