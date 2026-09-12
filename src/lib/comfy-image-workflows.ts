export type ComfyGraph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
export type ComfyImageParams = { prompt: string; width: number; height: number; seed: number; steps: number };

// Native ComfyUI nodes, derived from Comfy-Org's published workflow templates.
// No prompt-refining LLM or paid API is hidden in these graphs.
export function buildComfyImageWorkflow(model: string, p: ComfyImageParams, references: string[] = []): ComfyGraph {
  const { prompt, width, height, seed, steps } = p;
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
