// FLUX.1-schnell generation via ComfyUI's HTTP API.
//
// Lifted out of the old /api/creative route so the result can go through
// saveImage() like every other image the box produces — that route returned a
// ComfyUI filename and proxied /view to display it, which is why nothing from
// the Creative tab ever reached the gallery, the DuckDB index, or the Activity
// feed. This returns the PNG bytes instead, so the caller can persist it.

import { getServiceUrl } from "@/lib/services";
import { buildComfyImageWorkflow, type ComfyGraph } from "./comfy-image-workflows";

/** ComfyUI graph for text→image on FLUX.1-schnell. Node ids are arbitrary but
 *  must match the wiring references below. */
function buildFluxWorkflow(prompt: string, width: number, height: number, seed: number, steps: number) {
  return {
    "1": { class_type: "DualCLIPLoader", inputs: { clip_name1: "clip_l.safetensors", clip_name2: "t5xxl_fp16.safetensors", type: "flux" } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["1", 0] } },
    "3": { class_type: "EmptySD3LatentImage", inputs: { width, height, batch_size: 1 } },
    "4": { class_type: "UNETLoader", inputs: { unet_name: "flux1-schnell.safetensors", weight_dtype: "default" } },
    "5": { class_type: "BasicGuider", inputs: { model: ["4", 0], conditioning: ["2", 0] } },
    "6": { class_type: "RandomNoise", inputs: { noise_seed: seed } },
    "7": { class_type: "BasicScheduler", inputs: { model: ["4", 0], scheduler: "simple", steps, denoise: 1.0 } },
    "8": { class_type: "SamplerCustomAdvanced", inputs: { noise: ["6", 0], guider: ["5", 0], sampler: ["9", 0], sigmas: ["7", 0], latent_image: ["3", 0] } },
    "9": { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
    "10": { class_type: "VAELoader", inputs: { vae_name: "ae.safetensors" } },
    "11": { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["10", 0] } },
    "12": { class_type: "SaveImage", inputs: { filename_prefix: "betenshi", images: ["11", 0] } },
  };
}

export type FluxParams = {
  prompt: string;
  width: number;
  height: number;
  steps: number;
  seed: number;
};

/** Unwrap undici's "fetch failed", whose useful detail is always on `.cause`. */
function detail(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause ? ` (${String((err.cause as Error)?.message ?? err.cause)})` : "";
  return `${err.message}${cause}`;
}

/**
 * Queue a FLUX generation and return the finished PNG. Throws on error/timeout.
 *
 * `signal` cancels before queue admission. Once ComfyUI accepts a prompt, finish
 * collecting it so a disconnected browser cannot orphan its image or GPU lease.
 */
export async function generateFlux(
  params: FluxParams,
  timeoutMs = 180_000,
  signal?: AbortSignal,
): Promise<Buffer> {
  const workflow = buildFluxWorkflow(params.prompt, params.width, params.height, params.seed, params.steps);
  return runComfyWorkflow(workflow, timeoutMs, signal);
}

export async function generateComfyImage(model: string, params: FluxParams, signal?: AbortSignal, references: string[] = []): Promise<Buffer> {
  const filenames: string[] = [];
  for (const reference of references) {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([\s\S]+)$/.exec(reference);
    if (!match) throw new Error("Input must be a PNG, JPEG or WebP image");
    const form = new FormData();
    form.set("image", new Blob([Buffer.from(match[2], "base64")], { type: match[1] }), `betenshi-edit-${crypto.randomUUID()}.${match[1].split("/")[1]}`);
    const upload = await fetch(getServiceUrl("comfyui") + "/upload/image", { method: "POST", body: form, signal });
    if (!upload.ok) throw new Error(`Reference upload failed: ${upload.status}`);
    const file = await upload.json();
    filenames.push(file.subfolder ? `${file.subfolder}/${file.name}` : file.name);
  }
  return runComfyWorkflow(buildComfyImageWorkflow(model, params, filenames), 900_000, signal);
}

async function runComfyWorkflow(workflow: ComfyGraph, timeoutMs: number, signal?: AbortSignal): Promise<Buffer> {
  const base = getServiceUrl("comfyui");

  const queueRes = await fetch(`${base}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow }),
    signal,
  });
  if (!queueRes.ok) {
    throw new Error(`ComfyUI queue error: ${(await queueRes.text()).slice(0, 300)}`);
  }
  const { prompt_id: promptId } = await queueRes.json();
  // Stop waiting is a client action, not a global ComfyUI interrupt. Persist the
  // accepted job even if that client goes away; the lease lives until we finish.
  signal = undefined;

  // A poll that fails is not a generation that failed. ComfyUI drops
  // connections while it is swapping ~30 GB of weights, and treating the first
  // dropped socket as fatal killed a batch job whose image was still rendering
  // fine — it completed on the server with nothing left to collect it.
  const MAX_CONSECUTIVE_POLL_FAILURES = 10;
  let pollFailures = 0;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1000));

    let history: Record<string, { status?: { status_str?: string; messages?: [string, Record<string, string>][] }; outputs?: Record<string, { images?: { filename: string; subfolder?: string; type?: string }[] }> }>;
    try {
      history = await fetch(`${base}/history/${promptId}`, { signal }).then(r => r.json());
      pollFailures = 0;
    } catch (err) {
      if (++pollFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
        throw new Error(`ComfyUI stopped responding after ${pollFailures} polls: ${detail(err)}`);
      }
      continue;
    }

    const entry = history[promptId];
    if (!entry) continue;

    const status = entry.status?.status_str;

    if (status === "error") {
      const msgs: [string, Record<string, string>][] = entry.status?.messages || [];
      const err = msgs.find(m => m[0] === "execution_error");
      throw new Error(err?.[1]?.exception_message || "ComfyUI generation failed");
    }

    if (status !== "success") continue;

    const outputs = entry.outputs ?? {};
    for (const nodeId of Object.keys(outputs)) {
      const images = outputs[nodeId].images;
      if (!images?.length) continue;
      const img = images[0];
      const q = new URLSearchParams({
        filename: img.filename,
        subfolder: img.subfolder || "",
        type: img.type || "output",
      });
      // Worth one retry for the same reason polling is: the bytes exist, and
      // losing them to a single dropped socket wastes the whole generation.
      for (let attempt = 0; ; attempt++) {
        try {
          const imgRes = await fetch(`${base}/view?${q}`, { signal });
          if (!imgRes.ok) throw new Error(`HTTP ${imgRes.status}`);
          const png = Buffer.from(await imgRes.arrayBuffer());
          // Release cached weights before our lease ends. Otherwise the next
          // model's admission counts both its estimate and our retained cache.
          // Never interrupt another ComfyUI caller's queued/running work.
          try {
            const queue = await fetch(`${base}/queue`).then(r => r.json());
            if (!queue.queue_running?.length && !queue.queue_pending?.length) {
              await fetch(`${base}/free`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ unload_models: true, free_memory: true }) });
            }
          } catch { /* The image is already complete; cleanup cannot lose it. */ }
          return png;
        } catch (err) {
          if (attempt >= 2) {
            throw new Error(`ComfyUI produced an image but it could not be read back: ${detail(err)}`);
          }
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    }
    throw new Error("ComfyUI finished with no image output");
  }

  throw new Error(`ComfyUI generation timed out after ${Math.round(timeoutMs / 1000)}s`);
}
