export type ComfyGraph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
export type ComfyImageParams = { prompt: string; width: number; height: number; seed: number; steps: number };

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

  // HiDream-O1 full (Comfy-Org template image_hidream_o1): the non-distilled
  // model at 40 steps and CFG 5 with the template's seam smoothing, where Dev
  // is 28 steps at CFG 1 with LCM. References attach to both conditionings.
  if (model === "hidream-o1") {
    const graph: ComfyGraph = {
      "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "hidream_o1_image_fp8_scaled.safetensors" } },
      "2": { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["1", 1] } },
      "3": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["1", 1] } },
      "4": { class_type: "EmptyHiDreamO1LatentImage", inputs: { width, height, batch_size: 1 } },
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
