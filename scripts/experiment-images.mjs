// Reproducible LOCAL-only comparison. Calls the same endpoints as Image Studio.
// node scripts/experiment-images.mjs [model ...]
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { getImageModel, isImageModelId } from "../src/lib/image-models.ts";
const exec = promisify(execFile);
const models = process.argv.slice(2);
if (!models.length) models.push("z-image-turbo", "flux2-klein-4b", "hidream-o1-dev");
if (models.some(m => !isImageModelId(m))) throw new Error("Only registered local image models are allowed");
const prompt = "A whimsical cut-paper illustration of a tiny orange fox piloting a teal sailboat on an indigo sea beneath a huge crescent moon. Exactly three yellow stars in the sky. Visible layered paper edges, flat graphic shapes, no photorealism, no text.";
const results = [];
for (const model of models) {
  let peakGpuMiB = 0, samples = 0, polling = false;
  const sample = async () => {
    if (polling) return;
    polling = true;
    try { const { stdout } = await exec("nvidia-smi", ["--query-gpu=memory.used", "--format=csv,noheader,nounits"], { windowsHide: true }); peakGpuMiB = Math.max(peakGpuMiB, Number(stdout.trim()) || 0); samples++; } finally { polling = false; }
  };
  await sample();
  const timer = setInterval(() => { void sample().catch(() => {}); }, 500);
  try {
    const size = model === "hidream-o1-dev" ? 2048 : 1024;
    const response = await fetch("http://localhost:8003/api/image/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, prompt, width: size, height: size, seed: 20260912, steps: getImageModel(model).steps[0], folder: "Studio Verification", requestId: `experiment-style-${model}` }), signal: AbortSignal.timeout(900000) });
    const result = await response.json();
    const { image, ...metadata } = result;
    results.push({ ...metadata, httpStatus: response.status, peakWholeGpuMiB: peakGpuMiB, samples });
    console.log(JSON.stringify(results.at(-1)));
  } catch (error) { results.push({ model, error: String(error), peakWholeGpuMiB: peakGpuMiB }); console.error(String(error)); }
  finally { clearInterval(timer); }
}
await mkdir("var/experiments", { recursive: true });
await writeFile(`var/experiments/${Date.now()}-style.json`, JSON.stringify({ prompt, results, note: "Whole-card sampled VRAM includes desktop and other apps, not model-only allocation. Each model runs sequentially with its native step count; HiDream uses native 2K." }, null, 2));
