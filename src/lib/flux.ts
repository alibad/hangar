// Image generation via ComfyUI's HTTP API, for every model the console runs
// there (src/lib/comfy-image-workflows.ts builds the graphs).
//
// Returns the PNG bytes rather than a ComfyUI filename, so the caller can put
// the result through saveImage() like every other image the box produces. The
// file keeps its old name: it began as FLUX.1-schnell's path, and schnell was
// retired on 28 Sept 2026 (docs/image-model-experiment-2026-09-26.md).

import { getServiceUrl } from "@/lib/services";
import { buildComfyImageWorkflow, type ComfyGraph } from "./comfy-image-workflows";

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
 * Queue a ComfyUI generation (or, with references, an edit) and return the
 * finished PNG. Throws on error/timeout.
 *
 * `signal` cancels before queue admission. Once ComfyUI accepts a prompt, finish
 * collecting it so a disconnected browser cannot orphan its image or GPU lease.
 */
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
