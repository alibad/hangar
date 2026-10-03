export type ComfyGraph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
export type ComfyImageParams = {
  prompt: string;
  width: number;
  height: number;
  seed: number;
  steps: number;
  /** Ideogram 4 only: the structured JSON caption it draws from (see ideogramCaption* below). */
  caption?: string;
};

/** "W:H" in lowest terms, as Ideogram 4's caption states it. */
function aspectRatio(width: number, height: number): string {
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const g = gcd(width, height) || 1;
  return `${width / g}:${height / g}`;
}

// ── Ideogram 4's caption ─────────────────────────────────────────────────────
//
// Ideogram 4 only draws from structured JSON captions (layout, elements,
// style). Given anything thinner it often renders a baked-in "Image blocked by
// safety filter" card instead: measured 3 Oct, a bakery sign and a bowl of
// fruit were both blocked from plain text and from a one-key caption. So a
// caption is written first, as Ideogram's own pipeline does, by the Qwen3-VL-8B
// the model already loads as its text encoder (the file keeps its LM head),
// following the Comfy template's MIT-licensed instructions
// (config/ideogram4-caption-system.txt, with its transparency rule tightened).
//
// It runs as its own ComfyUI job, not inside the image graph, because the 8B
// writer is unreliable in two ways the image model punishes: it splits the
// caption into two JSON objects, and it declares "transparent background" for
// ideas that never asked for one (the image then sits on a painted checkerboard
// — 16 of the first 24 suite images). repairIdeogramCaption() fixes both in code.

/**
 * system + user come from the template; `transparent` is its transparent-
 * background rule, kept apart and sent ONLY for ideas that ask for
 * transparency. With the rule present the 8B writer declared "transparent
 * background" for a café scene 8 times in 9 (default, reasoning-on and
 * low-temperature sampling alike).
 */
export type IdeogramCaptionInstructions = { system: string; user: string; transparent?: string };

/** The caption-writing job: Ideogram's encoder as an LLM, seeded, text out. */
export function buildIdeogramCaptionGraph(p: { prompt: string; width: number; height: number; seed: number }, instructions: IdeogramCaptionInstructions): ComfyGraph {
  const userTurn = instructions.user
    .replace("{{ratio}}", aspectRatio(p.width, p.height))
    .replace("{{original_prompt}}", p.prompt);
  const system = instructions.transparent && ASKS_FOR_TRANSPARENCY.test(p.prompt) ? `${instructions.system}\n\n${instructions.transparent}` : instructions.system;
  return {
    "1": { class_type: "CLIPLoader", inputs: { clip_name: "qwen3vl_8b_fp8_scaled.safetensors", type: "ideogram4" } },
    "2": {
      class_type: "TextGenerate",
      inputs: {
        clip: ["1", 0], system_prompt: system, prompt: userTurn, max_length: 2048,
        thinking: false, use_default_template: true, mtp: "auto",
        sampling_mode: "on", "sampling_mode.temperature": 0.7, "sampling_mode.top_k": 64, "sampling_mode.top_p": 0.95,
        "sampling_mode.min_p": 0.05, "sampling_mode.repetition_penalty": 1.05, "sampling_mode.seed": p.seed,
      },
    },
    "3": { class_type: "PreviewAny", inputs: { source: ["2", 0] } },
  };
}

/** Every top-level JSON object in a string, in order (string-aware brace matching). */
function jsonObjects(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let depth = 0, start = -1, inString = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") { if (depth++ === 0) start = i; }
    else if (ch === "}" && depth > 0 && --depth === 0) {
      try { out.push(JSON.parse(text.slice(start, i + 1))); } catch { /* skip a malformed object */ }
    }
  }
  return out;
}

const ASKS_FOR_TRANSPARENCY = /transparen|alpha channel|cut-?out|isolated|sticker|no background|without (a )?background/i;

/**
 * One valid Ideogram caption from what the writer produced, or ok:false when
 * there is nothing usable (no description). Merges split objects, sets the
 * requested aspect ratio, and gives an idea that did not ask for transparency
 * a real background: the high-level description, which always describes the
 * scene, minus any "on a transparent background".
 */
export function repairIdeogramCaption(raw: string, prompt: string, width: number, height: number): { ok: boolean; caption: string; repairs: string[] } {
  const repairs: string[] = [];
  const objects = jsonObjects(raw);
  if (objects.length > 1) repairs.push(`merged ${objects.length} JSON objects`);
  const merged: Record<string, unknown> = {};
  for (const o of objects) {
    for (const [k, v] of Object.entries(o)) {
      const prev = merged[k];
      merged[k] = prev && typeof prev === "object" && !Array.isArray(prev) && v && typeof v === "object" && !Array.isArray(v) ? { ...prev, ...v } : v;
    }
  }
  let hld = typeof merged.high_level_description === "string" ? merged.high_level_description.trim() : "";
  if (!hld) return { ok: false, caption: "", repairs: [...repairs, "no high_level_description"] };
  const cd = (merged.compositional_deconstruction && typeof merged.compositional_deconstruction === "object" ? merged.compositional_deconstruction : {}) as { background?: unknown; elements?: unknown };
  let background = typeof cd.background === "string" ? cd.background.trim() : "";
  const elements = Array.isArray(cd.elements) ? cd.elements : [];
  if (!ASKS_FOR_TRANSPARENCY.test(prompt)) {
    if (/transparent/i.test(hld)) {
      hld = hld.replace(/,?\s*(on|against|over) a transparent background/gi, "").trim();
      repairs.push("dropped an unrequested transparent background from the description");
    }
    if (!background || /^transparent background$/i.test(background)) {
      repairs.push(background ? "replaced an unrequested transparent background" : "filled an empty background");
      background = hld;
    }
  }
  const ratio = aspectRatio(width, height);
  if (merged.aspect_ratio !== ratio) repairs.push(`aspect ratio ${String(merged.aspect_ratio ?? "missing")} → ${ratio}`);
  const caption = JSON.stringify({ ...merged, aspect_ratio: ratio, high_level_description: hld, compositional_deconstruction: { ...cd, background, elements } });
  return { ok: true, caption, repairs };
}

// Native ComfyUI nodes, derived from Comfy-Org's published workflow templates.
// No prompt-refining LLM or paid API is hidden in these graphs.
export function buildComfyImageWorkflow(model: string, p: ComfyImageParams, references: string[] = []): ComfyGraph {
  const { prompt, width, height, seed, steps } = p;
  /** LoadImage nodes for uploaded references, keyed for an Autogrow `images` input. */
  const loadRefs = (graph: ComfyGraph, firstId: number) => {
    const inputs: Record<string, [string, number]> = {};
    references.forEach((file, i) => {
      graph[String(firstId + i)] = { class_type: "LoadImage", inputs: { image: file } };
      inputs[`images.image_${i + 1}`] = [String(firstId + i), 0];
    });
    return inputs;
  };

  // Qwen-Image 2.1 (Comfy-Org template image_qwen_image_2_1_t2i / _image_edit,
  // ComfyUI v0.37+). One node encodes the prompt with the Qwen3-VL-8B encoder
  // and, when references are given, splices them in and sizes the latent from
  // the first. The template's optional 9B prompt-enhancer LLM is left out.
  if (model === "qwen-image-2.1") {
    const graph: ComfyGraph = {
      "1": { class_type: "UNETLoader", inputs: { unet_name: "qwen_image_2.1_int8_convrot.safetensors", weight_dtype: "default" } },
      "2": { class_type: "CLIPLoader", inputs: { clip_name: "qwen3vl_8b_int8_convrot.safetensors", type: "qwen_image" } },
      "3": { class_type: "VAELoader", inputs: { vae_name: "qwen_image_2.1_vae_bf16.safetensors" } },
      "4": { class_type: "QwenImage21Cache", inputs: { model: ["1", 0], device: "auto", dtype: "default" } },
      "6": { class_type: "EmptyLatentImage", inputs: { width, height, batch_size: 1 } },
      "8": { class_type: "VAEDecode", inputs: { samples: ["7", 0], vae: ["3", 0] } },
      "9": { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: "betenshi-qwen-image-2.1" } },
    };
    const refs = loadRefs(graph, 20);
    graph["5"] = {
      class_type: "TextEncodeQwenImage21",
      inputs: {
        clip: ["2", 0], prompt, negative_prompt: "",
        // References are resized to about resolution² and the latent follows the first.
        resolution: references.length ? Math.round(Math.sqrt(width * height) / 32) * 32 : 1024,
        ...(references.length ? { vae: ["3", 0], ...refs } : {}),
      },
    };
    graph["7"] = {
      class_type: "KSampler",
      inputs: {
        model: ["4", 0], positive: ["5", 0], negative: ["5", 1],
        latent_image: references.length ? ["5", 2] : ["6", 0],
        seed, steps, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1,
      },
    };
    return graph;
  }

  // Ideogram 4 (Comfy-Org template image_ideogram4_t2i, "Default" preset:
  // 20 steps, mu 0, std 1.75). Two transformers: the conditional one guided
  // against a separately trained unconditional one (DualModelGuider, CFG 7,
  // easing to 3 for the last 30% of steps). It draws from a structured JSON
  // caption written beforehand (buildIdeogramCaptionGraph + repairIdeogramCaption,
  // above); the server supplies it. Generation only.
  if (model === "ideogram-4") {
    if (references.length) throw new Error("Ideogram 4 is wired for generation only");
    if (!p.caption) throw new Error("Ideogram 4 needs a structured caption (write one with buildIdeogramCaptionGraph)");
    const w = Math.max(256, Math.ceil(width / 16) * 16);
    const h = Math.max(256, Math.ceil(height / 16) * 16);
    return {
      "1": { class_type: "UNETLoader", inputs: { unet_name: "ideogram4_fp8_scaled.safetensors", weight_dtype: "default" } },
      "2": { class_type: "UNETLoader", inputs: { unet_name: "ideogram4_unconditional_fp8_scaled.safetensors", weight_dtype: "default" } },
      "3": { class_type: "CLIPLoader", inputs: { clip_name: "qwen3vl_8b_fp8_scaled.safetensors", type: "ideogram4" } },
      "4": { class_type: "VAELoader", inputs: { vae_name: "flux2-vae.safetensors" } },
      "5": { class_type: "CLIPTextEncode", inputs: { text: p.caption, clip: ["3", 0] } },
      "6": { class_type: "ConditioningZeroOut", inputs: { conditioning: ["5", 0] } },
      "7": { class_type: "CFGOverride", inputs: { model: ["1", 0], cfg: 3, start_percent: 0.7, end_percent: 1 } },
      "8": { class_type: "DualModelGuider", inputs: { model: ["7", 0], positive: ["5", 0], cfg: 7, model_negative: ["2", 0], negative: ["6", 0] } },
      "9": { class_type: "Ideogram4Scheduler", inputs: { steps, width: w, height: h, mu: 0, std: 1.75 } },
      "10": { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
      "11": { class_type: "RandomNoise", inputs: { noise_seed: seed } },
      "12": { class_type: "EmptyFlux2LatentImage", inputs: { width: w, height: h, batch_size: 1 } },
      "13": { class_type: "SamplerCustomAdvanced", inputs: { noise: ["11", 0], guider: ["8", 0], sampler: ["10", 0], sigmas: ["9", 0], latent_image: ["12", 0] } },
      "14": { class_type: "VAEDecode", inputs: { samples: ["13", 0], vae: ["4", 0] } },
      "15": { class_type: "SaveImage", inputs: { images: ["14", 0], filename_prefix: "betenshi-ideogram-4" } },
    };
  }

  // Ming-Image 0.1 Design (Comfy-Org templates image_ming_image_01_design_t2i
  // / _image_edit, ComfyUI v0.38+): a Z-Image-family model with the Ling-mini
  // 2.0 MoE as its text encoder, 12 steps, no CFG. The templates' optional
  // Qwen3.8-27B prompt expansion (off by default there) is left out. Editing
  // feeds references through TextEncodeMingImageEdit and samples with LCM, as
  // the edit template does.
  if (model === "ming-image") {
    const graph: ComfyGraph = {
      "1": { class_type: "UNETLoader", inputs: { unet_name: "ming_image_0.1_design_int8_convrot.safetensors", weight_dtype: "default" } },
      "2": { class_type: "ModelAttentionBackend", inputs: { model: ["1", 0], attention: "comfy kitchen attention" } },
      "3": { class_type: "ModelSamplingFlux", inputs: { model: ["2", 0], max_shift: 1.15, base_shift: 0.5, width, height } },
      "4": { class_type: "CLIPLoader", inputs: { clip_name: "ming_image_0.1_ling_mini_2.0_int8_convrot.safetensors", type: "qwen_image" } },
      "5": { class_type: "VAELoader", inputs: { vae_name: "ming_image_vae_bf16.safetensors" } },
      "7": { class_type: "BasicGuider", inputs: { model: ["3", 0], conditioning: ["6", 0] } },
      "8": { class_type: "BasicScheduler", inputs: { model: ["3", 0], scheduler: "simple", steps, denoise: 1 } },
      "9": { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
      "10": { class_type: "RandomNoise", inputs: { noise_seed: seed } },
      "11": { class_type: "EmptyLatentImage", inputs: { width, height, batch_size: 1 } },
      "12": { class_type: "SamplerCustomAdvanced", inputs: { noise: ["10", 0], guider: ["7", 0], sampler: ["9", 0], sigmas: ["8", 0], latent_image: ["11", 0] } },
      "13": { class_type: "VAEDecode", inputs: { samples: ["12", 0], vae: ["5", 0] } },
      "14": { class_type: "SaveImage", inputs: { images: ["13", 0], filename_prefix: "betenshi-ming-image" } },
    };
    if (references.length) {
      graph["6"] = { class_type: "TextEncodeMingImageEdit", inputs: { clip: ["4", 0], prompt, vae: ["5", 0], ...loadRefs(graph, 20) } };
      graph["9"] = { class_type: "SamplerLCM", inputs: { s_noise: 1.02, s_noise_end: 1, noise_clip_std: 0 } };
    } else {
      graph["6"] = { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["4", 0] } };
    }
    return graph;
  }

  // HiDream-O1 full (Comfy-Org template image_hidream_o1): the non-distilled
  // model at 40 steps and CFG 5 with the template's seam smoothing, where Dev
  // is 28 steps at CFG 1 with LCM. References attach to both conditionings.
  if (model === "hidream-o1") {
    // Edits get a ~4 MP canvas at the source's aspect, as the template does
    // (ImageScaleToTotalPixels 4 MP → floor to 32). Measured 3 Oct: the same
    // edit on a 1024² canvas came back as pure noise; 1536² and 2048² were clean.
    const editScale = references.length ? Math.max(1, Math.sqrt((4 * 1024 * 1024) / (width * height))) : 1;
    const canvasW = references.length ? Math.min(2048, Math.floor((width * editScale) / 32) * 32) : width;
    const canvasH = references.length ? Math.min(2048, Math.floor((height * editScale) / 32) * 32) : height;
    const graph: ComfyGraph = {
      "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "hidream_o1_image_fp8_scaled.safetensors" } },
      "2": { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["1", 1] } },
      "3": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["1", 1] } },
      "4": { class_type: "EmptyHiDreamO1LatentImage", inputs: { width: canvasW, height: canvasH, batch_size: 1 } },
      "5": { class_type: "ModelNoiseScale", inputs: { model: ["1", 0], noise_scale: 8 } },
      "6": { class_type: "BasicScheduler", inputs: { model: ["5", 0], scheduler: "normal", steps, denoise: 1 } },
      "7": { class_type: "KSamplerSelect", inputs: { sampler_name: "dpmpp_2m_sde_gpu" } },
      "11": { class_type: "HiDreamO1PatchSeamSmoothing", inputs: { model: ["5", 0], start_percent: 0.8, end_percent: 1, pattern: "single_shift", passes: "ramp_2_4", blend: "median", strength: 1 } },
      "9": { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["1", 2] } },
      "10": { class_type: "SaveImage", inputs: { images: ["9", 0], filename_prefix: "betenshi-hidream-o1" } },
    };
    let positive: [string, number] = ["2", 0];
    let negative: [string, number] = ["3", 0];
    if (references.length) {
      graph["12"] = { class_type: "HiDreamO1ReferenceImages", inputs: { positive, negative, ...loadRefs(graph, 20) } };
      positive = ["12", 0];
      negative = ["12", 1];
    }
    graph["8"] = { class_type: "SamplerCustom", inputs: { model: ["11", 0], add_noise: true, noise_seed: seed, cfg: 5, positive, negative, sampler: ["7", 0], sigmas: ["6", 0], latent_image: ["4", 0] } };
    return graph;
  }

  if (model === "hidream-o1-dev" && references.length) throw new Error("HiDream-O1 Dev is wired for generation only; edit with HiDream-O1");
  if (model === "hidream-o1-dev") return {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "hidream_o1_image_dev_fp8_scaled.safetensors" } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["1", 1] } },
    "3": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["1", 1] } },
    "4": { class_type: "EmptyHiDreamO1LatentImage", inputs: { width, height, batch_size: 1 } },
    "5": { class_type: "ModelNoiseScale", inputs: { model: ["1", 0], noise_scale: 7.6 } },
    "6": { class_type: "BasicScheduler", inputs: { model: ["5", 0], scheduler: "normal", steps, denoise: 1 } },
    "7": { class_type: "SamplerLCM", inputs: { s_noise: 1, s_noise_end: 1, noise_clip_std: 2.5 } },
    "8": { class_type: "SamplerCustom", inputs: { model: ["5", 0], add_noise: true, noise_seed: seed, cfg: 1, positive: ["2", 0], negative: ["3", 0], sampler: ["7", 0], sigmas: ["6", 0], latent_image: ["4", 0] } },
    "9": { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["1", 2] } },
    "10": { class_type: "SaveImage", inputs: { images: ["9", 0], filename_prefix: "betenshi-hidream" } },
  };
  if (model !== "flux2-klein-4b" && model !== "z-image-turbo") throw new Error(`Unsupported ComfyUI image model: ${model}`);
  const klein = model === "flux2-klein-4b";
  if (references.length && !klein) throw new Error("This model does not support gallery editing");
  const graph: ComfyGraph = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: klein ? "flux-2-klein-4b.safetensors" : "z_image_turbo_nvfp4.safetensors", weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: "qwen_3_4b_fp8_mixed.safetensors", type: klein ? "flux2" : "lumina2" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: klein ? "flux2-vae.safetensors" : "ae.safetensors" } },
    "4": { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["2", 0] } },
    "5": { class_type: "ConditioningZeroOut", inputs: { conditioning: ["4", 0] } },
    "6": { class_type: klein ? "EmptyFlux2LatentImage" : "EmptySD3LatentImage", inputs: { width, height, batch_size: 1 } },
    "11": { class_type: "VAEDecode", inputs: { samples: ["10", 0], vae: ["3", 0] } },
    "12": { class_type: "SaveImage", inputs: { images: ["11", 0], filename_prefix: `betenshi-${model}` } },
  };
  let positive: [string, number] = ["4", 0];
  for (let i = 0; i < references.length; i++) {
    const id = 20 + i * 3;
    graph[String(id)] = { class_type: "LoadImage", inputs: { image: references[i] } };
    graph[String(id + 1)] = { class_type: "VAEEncode", inputs: { pixels: [String(id), 0], vae: ["3", 0] } };
    graph[String(id + 2)] = { class_type: "ReferenceLatent", inputs: { conditioning: positive, latent: [String(id + 1), 0] } };
    positive = [String(id + 2), 0];
  }
  if (klein) Object.assign(graph, {
    "7": { class_type: "Flux2Scheduler", inputs: { steps, width, height } },
    "8": { class_type: "CFGGuider", inputs: { model: ["1", 0], positive, negative: ["5", 0], cfg: 1 } },
    "9": { class_type: "RandomNoise", inputs: { noise_seed: seed } },
    "10": { class_type: "SamplerCustomAdvanced", inputs: { noise: ["9", 0], guider: ["8", 0], sampler: ["13", 0], sigmas: ["7", 0], latent_image: ["6", 0] } },
    "13": { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
  });
  else Object.assign(graph, {
    "7": { class_type: "ModelSamplingAuraFlow", inputs: { model: ["1", 0], shift: 3 } },
    "10": { class_type: "KSampler", inputs: { model: ["7", 0], positive, negative: ["5", 0], latent_image: ["6", 0], seed, steps, cfg: 1, sampler_name: "res_multistep", scheduler: "simple", denoise: 1 } },
  });
  return graph;
}
