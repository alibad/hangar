import type { VideoMode, VideoModelSpec } from "./video-models";

/**
 * ComfyUI API graphs for the local video models.
 *
 * Each one is Comfy-Org's published template for that model (the
 * comfyui_workflow_templates_json package: video_wan2_2_5B_ti2v,
 * video_wan2_2_14B_{i2v,t2v}, video_ltx2_5_{i2v,t2v},
 * video_hunyuan_video_1.5_720p_{i2v,t2v}, video_minimax_h3_{i2v,t2v}) with its
 * subgraph flattened into API form and its switches resolved to the settings
 * the Lab runs: the distilled / 4-step / 8-step paths, since those are the ones
 * worth waiting for on one card. Deliberate departures from the templates:
 *
 *  - No prompt enhancer. LTX-2.5's template can rewrite the prompt with a second
 *    Gemma model; every model here gets the prompt as typed, so a comparison
 *    compares models rather than prompt rewriters.
 *  - The source image is scaled and centre-cropped to the output size first,
 *    so every model starts from the same framing.
 *  - Output is always an MP4 through SaveVideo.
 *
 * Only `import type`, so scripts/video-lab.test.mjs can load this file with
 * Node's own type stripping and check every graph without a server.
 */

export type ComfyNode = { class_type: string; inputs: Record<string, unknown> };
export type ComfyGraph = Record<string, ComfyNode>;

export type VideoGraphParams = {
  mode: VideoMode;
  prompt: string;
  /** Uploaded ComfyUI input filename; required for i2v. */
  image?: string;
  width: number;
  height: number;
  frames: number;
  seed: number;
  /** Overrides the model's default step count. */
  steps?: number;
  /** SaveVideo filename_prefix (under ComfyUI's output dir). */
  prefix: string;
};

/** Wan's own negative prompt, verbatim from its templates. */
export const WAN_NEGATIVE =
  "色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走";

const LTX_NEGATIVE = "pc game, console game, video game, cartoon, childish, ugly";

type Ref = [string, number];
const ref = (id: string, slot = 0): Ref => [id, slot];

/** A graph plus a counter, so builders read top to bottom. */
function graphBuilder() {
  const g: ComfyGraph = {};
  let n = 0;
  const add = (class_type: string, inputs: Record<string, unknown>): string => {
    const id = String(++n);
    g[id] = { class_type, inputs };
    return id;
  };
  return { g, add };
}

export function buildVideoWorkflow(spec: VideoModelSpec, p: VideoGraphParams): ComfyGraph {
  if (!spec.local || spec.backend !== "comfyui") throw new Error(`${spec.id} is not a ComfyUI model`);
  if (!spec.modes.includes(p.mode)) throw new Error(`${spec.label} does not do ${p.mode}`);
  if (p.mode === "i2v" && !p.image) throw new Error("Image-to-video needs a source image");
  switch (spec.id) {
    case "wan2.2-ti2v-5b":
      return wan5b(spec, p);
    case "wan2.2-14b":
      return wan14b(spec, p);
    case "ltx-2.5":
      return ltx25(spec, p);
    case "hunyuanvideo-1.5":
      return hunyuan15(spec, p);
    case "minimax-h3":
      return minimaxH3(spec, p);
    default:
      throw new Error(`No ComfyUI graph for ${spec.id}`);
  }
}

function sourceImage(add: ReturnType<typeof graphBuilder>["add"], p: VideoGraphParams): string {
  const load = add("LoadImage", { image: p.image });
  return add("ImageScale", { image: ref(load), upscale_method: "lanczos", width: p.width, height: p.height, crop: "center" });
}

function save(add: ReturnType<typeof graphBuilder>["add"], images: Ref, fps: number, prefix: string, audio?: Ref) {
  const video = add("CreateVideo", { images, fps, ...(audio ? { audio } : {}) });
  add("SaveVideo", { video: ref(video), filename_prefix: prefix, format: "mp4" });
}

// ── Wan 2.2 TI2V 5B ── video_wan2_2_5B_ti2v: one model, uni_pc, cfg 5, shift 8
function wan5b(spec: VideoModelSpec, p: VideoGraphParams): ComfyGraph {
  const { g, add } = graphBuilder();
  const unet = add("UNETLoader", { unet_name: "wan2.2_ti2v_5B_fp16.safetensors", weight_dtype: "default" });
  const clip = add("CLIPLoader", { clip_name: "umt5_xxl_fp8_e4m3fn_scaled.safetensors", type: "wan", device: "default" });
  const vae = add("VAELoader", { vae_name: "wan2.2_vae.safetensors" });
  const model = add("ModelSamplingSD3", { model: ref(unet), shift: 8 });
  const pos = add("CLIPTextEncode", { text: p.prompt, clip: ref(clip) });
  const neg = add("CLIPTextEncode", { text: WAN_NEGATIVE, clip: ref(clip) });
  const latent = add("Wan22ImageToVideoLatent", {
    vae: ref(vae),
    width: p.width,
    height: p.height,
    length: p.frames,
    batch_size: 1,
    ...(p.mode === "i2v" ? { start_image: ref(sourceImage(add, p)) } : {}),
  });
  const sampled = add("KSampler", {
    model: ref(model),
    seed: p.seed,
    steps: p.steps ?? spec.steps,
    cfg: 5,
    sampler_name: "uni_pc",
    scheduler: "simple",
    positive: ref(pos),
    negative: ref(neg),
    latent_image: ref(latent),
    denoise: 1,
  });
  const decoded = add("VAEDecode", { samples: ref(sampled), vae: ref(vae) });
  save(add, ref(decoded), spec.fps, p.prefix);
  return g;
}

// ── Wan 2.2 14B ── video_wan2_2_14B_{i2v,t2v} with "Enable 4steps LoRA" on:
// high-noise expert for the first half of the steps, low-noise for the rest.
function wan14b(spec: VideoModelSpec, p: VideoGraphParams): ComfyGraph {
  const { g, add } = graphBuilder();
  const kind = p.mode; // "i2v" | "t2v" — file names differ only by this
  const loraVer = kind === "i2v" ? "v1" : "v1.1";
  const steps = p.steps ?? spec.steps;
  const split = Math.max(1, Math.round(steps / 2));
  const clip = add("CLIPLoader", { clip_name: "umt5_xxl_fp8_e4m3fn_scaled.safetensors", type: "wan", device: "default" });
  const vae = add("VAELoader", { vae_name: "wan_2.1_vae.safetensors" });
  const expert = (noise: "high" | "low") => {
    const unet = add("UNETLoader", { unet_name: `wan2.2_${kind}_${noise}_noise_14B_fp8_scaled.safetensors`, weight_dtype: "default" });
    const lora = add("LoraLoaderModelOnly", {
      model: ref(unet),
      lora_name: `wan2.2_${kind}_lightx2v_4steps_lora_${loraVer}_${noise}_noise.safetensors`,
      strength_model: 1,
    });
    return add("ModelSamplingSD3", { model: ref(lora), shift: 5 });
  };
  const high = expert("high");
  const low = expert("low");
  const pos = add("CLIPTextEncode", { text: p.prompt, clip: ref(clip) });
  const neg = add("CLIPTextEncode", { text: WAN_NEGATIVE, clip: ref(clip) });
  let positive: Ref = ref(pos);
  let negative: Ref = ref(neg);
  let latent: Ref;
  if (kind === "i2v") {
    const i2v = add("WanImageToVideo", {
      positive,
      negative,
      vae: ref(vae),
      width: p.width,
      height: p.height,
      length: p.frames,
      batch_size: 1,
      start_image: ref(sourceImage(add, p)),
    });
    positive = ref(i2v, 0);
    negative = ref(i2v, 1);
    latent = ref(i2v, 2);
  } else {
    latent = ref(add("EmptyHunyuanLatentVideo", { width: p.width, height: p.height, length: p.frames, batch_size: 1 }));
  }
  const first = add("KSamplerAdvanced", {
    model: ref(high),
    add_noise: "enable",
    noise_seed: p.seed,
    steps,
    cfg: 1,
    sampler_name: "euler",
    scheduler: "simple",
    positive,
    negative,
    latent_image: latent,
    start_at_step: 0,
    end_at_step: split,
    return_with_leftover_noise: "enable",
  });
  const second = add("KSamplerAdvanced", {
    model: ref(low),
    add_noise: "disable",
    noise_seed: 0,
    steps,
    cfg: 1,
    sampler_name: "euler",
    scheduler: "simple",
    positive,
    negative,
    latent_image: ref(first),
    start_at_step: split,
    end_at_step: steps,
    return_with_leftover_noise: "disable",
  });
  const decoded = add("VAEDecode", { samples: ref(second), vae: ref(vae) });
  save(add, ref(decoded), spec.fps, p.prefix);
  return g;
}

// ── LTX-2.5 distilled ── video_ltx2_5_{i2v,t2v}: 8 steps at half resolution,
// ×2 latent upscale, 3 refinement steps; audio latent sampled alongside.
function ltx25(spec: VideoModelSpec, p: VideoGraphParams): ComfyGraph {
  const { g, add } = graphBuilder();
  const unet = add("UNETLoader", { unet_name: "ltx-2.5-22b-distilled-transformer-nvfp4.safetensors", weight_dtype: "default" });
  const vae = add("VAELoader", { vae_name: "ltx-2.5-video-vae-bf16.safetensors" });
  const audioVae = add("VAELoader", { vae_name: "ltx-2.5-audio-vae-bf16.safetensors" });
  const clip = add("CLIPLoader", { clip_name: "gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors", type: "ltxv", device: "default" });
  const upscaler = add("LatentUpscaleModelLoader", { model_name: "ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors" });
  const pos = add("CLIPTextEncode", { text: p.prompt, clip: ref(clip) });
  const neg = add("CLIPTextEncode", { text: LTX_NEGATIVE, clip: ref(clip) });
  const cond = add("LTXVConditioning", { positive: ref(pos), negative: ref(neg), frame_rate: spec.fps });
  const guider = () =>
    add("LTXVDualCFGGuider", { model: ref(unet), positive: ref(cond, 0), negative: ref(cond, 1), video_cfg: 1, audio_cfg: 1 });

  const image = p.mode === "i2v" ? add("LTXVPreprocess", { image: ref(sourceImage(add, p)), img_compression: 18 }) : null;
  const inplace = (latent: Ref, strength: number): Ref =>
    image ? ref(add("LTXVImgToVideoInplace", { vae: ref(vae), image: ref(image), latent, strength, bypass: false })) : latent;

  // Stage 1 — half resolution.
  const empty = add("EmptyLTXVLatentVideo", { width: p.width / 2, height: p.height / 2, length: p.frames, batch_size: 1 });
  const audio = add("LTXVEmptyLatentAudio", { audio_vae: ref(audioVae), frames_number: p.frames, frame_rate: spec.fps, batch_size: 1 });
  const av1 = add("LTXVConcatAVLatent", { video_latent: inplace(ref(empty), 0.7), audio_latent: ref(audio) });
  const s1 = add("SamplerCustomAdvanced", {
    noise: ref(add("RandomNoise", { noise_seed: p.seed })),
    guider: ref(guider()),
    sampler: ref(add("KSamplerSelect", { sampler_name: "euler_ancestral" })),
    sigmas: ref(add("ManualSigmas", { sigmas: "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0" })),
    latent_image: ref(av1),
  });
  const split1 = add("LTXVSeparateAVLatent", { av_latent: ref(s1) });

  // Stage 2 — ×2 upscale in latent space, then refine.
  const up = add("LTXVLatentUpsampler", { samples: ref(split1, 0), upscale_model: ref(upscaler), vae: ref(vae) });
  const av2 = add("LTXVConcatAVLatent", { video_latent: inplace(ref(up), 1), audio_latent: ref(split1, 1) });
  const s2 = add("SamplerCustomAdvanced", {
    noise: ref(add("RandomNoise", { noise_seed: 42 })),
    guider: ref(guider()),
    sampler: ref(add("KSamplerSelect", { sampler_name: "euler_ancestral" })),
    sigmas: ref(add("ManualSigmas", { sigmas: "0.85, 0.7250, 0.4219, 0.0" })),
    latent_image: ref(av2),
  });
  const split2 = add("LTXVSeparateAVLatent", { av_latent: ref(s2) });
  const frames = add("VAEDecodeTiled", { samples: ref(split2, 0), vae: ref(vae), tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 16 });
  const sound = add("LTXVAudioVAEDecode", { samples: ref(split2, 1), audio_vae: ref(audioVae) });
  save(add, ref(frames), spec.fps, p.prefix, ref(sound));
  return g;
}

// ── HunyuanVideo 1.5, 480p ── video_hunyuan_video_1.5_720p_{i2v,t2v} pointed at
// the 480p checkpoints: step-distilled for i2v, cfg-distilled + lightx2v 4-step
// LoRA for t2v; cfg 1 and shift 5, per the Hunyuan team's table in the template.
function hunyuan15(spec: VideoModelSpec, p: VideoGraphParams): ComfyGraph {
  const { g, add } = graphBuilder();
  const i2v = p.mode === "i2v";
  const unet = add("UNETLoader", {
    unet_name: i2v
      ? "hunyuanvideo1.5_480p_i2v_step_distilled_fp8_scaled.safetensors"
      : "hunyuanvideo1.5_480p_t2v_cfg_distilled_fp8_scaled.safetensors",
    weight_dtype: "default",
  });
  const base = i2v
    ? unet
    : add("LoraLoaderModelOnly", { model: ref(unet), lora_name: "hunyuanvideo1.5_t2v_480p_lightx2v_4step_lora_rank_32_bf16.safetensors", strength_model: 1 });
  const model = add("ModelSamplingSD3", { model: ref(base), shift: 5 });
  const clip = add("DualCLIPLoader", {
    clip_name1: "qwen_2.5_vl_7b_fp8_scaled.safetensors",
    clip_name2: "byt5_small_glyphxl_fp16.safetensors",
    type: "hunyuan_video_15",
    device: "default",
  });
  const vae = add("VAELoader", { vae_name: "hunyuanvideo15_vae_fp16.safetensors" });
  const pos = add("CLIPTextEncode", { text: p.prompt, clip: ref(clip) });
  const neg = add("CLIPTextEncode", { text: "", clip: ref(clip) });
  let positive: Ref = ref(pos);
  let negative: Ref = ref(neg);
  let latent: Ref;
  if (i2v) {
    const img = sourceImage(add, p);
    const vision = add("CLIPVisionEncode", {
      clip_vision: ref(add("CLIPVisionLoader", { clip_name: "sigclip_vision_patch14_384.safetensors" })),
      image: ref(img),
      crop: "center",
    });
    const cond = add("HunyuanVideo15ImageToVideo", {
      positive,
      negative,
      vae: ref(vae),
      width: p.width,
      height: p.height,
      length: p.frames,
      batch_size: 1,
      start_image: ref(img),
      clip_vision_output: ref(vision),
    });
    positive = ref(cond, 0);
    negative = ref(cond, 1);
    latent = ref(cond, 2);
  } else {
    latent = ref(add("EmptyHunyuanVideo15Latent", { width: p.width, height: p.height, length: p.frames, batch_size: 1 }));
  }
  const sampled = add("SamplerCustomAdvanced", {
    noise: ref(add("RandomNoise", { noise_seed: p.seed })),
    guider: ref(add("CFGGuider", { model: ref(model), positive, negative, cfg: 1 })),
    sampler: ref(add("KSamplerSelect", { sampler_name: "euler" })),
    sigmas: ref(add("BasicScheduler", { model: ref(model), scheduler: "simple", steps: p.steps ?? (i2v ? spec.steps : 4), denoise: 1 })),
    latent_image: latent,
  });
  const decoded = add("VAEDecode", { samples: ref(sampled), vae: ref(vae) });
  save(add, ref(decoded), spec.fps, p.prefix);
  return g;
}

// ── MiniMax H3 ── video_minimax_h3_{i2v,t2v} with the Lightning (8-step turbo)
// LoRA enabled. One node builds conditioning and latent; video and audio are
// decoded from the same sampled latent.
function minimaxH3(spec: VideoModelSpec, p: VideoGraphParams): ComfyGraph {
  const { g, add } = graphBuilder();
  const unet = add("UNETLoader", { unet_name: "minimax_h3_fl2va_pruned_fp8_scaled.safetensors", weight_dtype: "default" });
  const model = add("LoraLoaderModelOnly", { model: ref(unet), lora_name: "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors", strength_model: 1 });
  const clip = add("CLIPLoader", { clip_name: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", type: "minimax", device: "default" });
  const vae = add("VAELoader", { vae_name: "minimax_h3_video_vae_fp16.safetensors" });
  const audioVae = add("VAELoader", { vae_name: "minimax_h3_audio_vae_fp32.safetensors" });
  const cond = add("MiniMaxH3ImageToVideo", {
    clip: ref(clip),
    vae: ref(vae),
    prompt: p.prompt,
    width: p.width,
    height: p.height,
    length: p.frames,
    ...(p.mode === "i2v" ? { first_frame: ref(sourceImage(add, p)) } : {}),
  });
  const sampled = add("SamplerCustomAdvanced", {
    noise: ref(add("RandomNoise", { noise_seed: p.seed })),
    guider: ref(add("BasicGuider", { model: ref(model), conditioning: ref(cond, 0) })),
    sampler: ref(add("KSamplerSelect", { sampler_name: "res_multistep" })),
    sigmas: ref(add("BasicScheduler", { model: ref(model), scheduler: "simple", steps: p.steps ?? spec.steps, denoise: 1 })),
    latent_image: ref(cond, 1),
  });
  const frames = add("VAEDecode", { samples: ref(sampled), vae: ref(vae) });
  const sound = add("VAEDecodeAudio", { samples: ref(sampled), vae: ref(audioVae) });
  save(add, ref(frames), spec.fps, p.prefix, ref(sound));
  return g;
}

/**
 * Structural check: every link points at a node that exists, and exactly one
 * SaveVideo. Cheap insurance against a graph that ComfyUI would reject only
 * after a minute of loading weights.
 */
export function graphProblems(g: ComfyGraph): string[] {
  const problems: string[] = [];
  for (const [id, node] of Object.entries(g)) {
    for (const [name, value] of Object.entries(node.inputs)) {
      if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "number") {
        if (!g[value[0]]) problems.push(`${id}.${name} → missing node ${value[0]}`);
      }
      if (value === undefined) problems.push(`${id}.${name} is undefined`);
    }
  }
  const saves = Object.values(g).filter((n) => n.class_type === "SaveVideo").length;
  if (saves !== 1) problems.push(`expected one SaveVideo, found ${saves}`);
  return problems;
}
