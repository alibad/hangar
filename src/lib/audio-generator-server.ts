import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { getHost } from "./host";
import { hostMemory, terminateLocalWorker } from "./sysinfo";
import { audioDir, saveAudioImport, saveAudioRevision } from "./audio-store";
import { EFFECTS_MODEL, type EffectRequest } from "./audio-generation";
import type { AudioRecipe } from "./audio-project";

// Keep the single-flight guard through development hot reloads. A worker exits
// after each run, so model memory is released even if the browser goes away.
const globals = globalThis as typeof globalThis & { hangarEffects?: { busy: boolean } };
const flight = globals.hangarEffects ??= { busy: false };
type Runtime = { python: string; hfHome: string };
async function runtimeConfig(): Promise<Runtime | null> {
  try {
    const config = JSON.parse(await readFile(path.join(process.cwd(), "config", `effects-runtime.${getHost().id}.local.json`), "utf8"));
    if (typeof config.python !== "string" || typeof config.hfHome !== "string" || !path.isAbsolute(config.python) || !path.isAbsolute(config.hfHome)) return null;
    await access(config.python);
    await access(path.join(config.hfHome, "hub", "models--stabilityai--stable-audio-3-small-sfx", "refs", "main"));
    return config;
  } catch { return null; }
}

export async function effectGeneratorStatus() {
  const config = await runtimeConfig();
  const memory = await hostMemory();
  return { available: Boolean(config), busy: flight.busy, model: EFFECTS_MODEL, freeGb: memory.free_gb, fits: memory.free_gb >= 12,
    reason: config ? "Cached model · CPU · one generation at a time" : "Local effect generation is not configured on this host. You can still import and edit recordings." };
}

export async function generateEffect(request: EffectRequest) {
  if (flight.busy) throw new Error("An effect is already generating. Wait for it to finish before starting another.");
  flight.busy = true;
  let scratch: string | undefined;
  try {
    const config = await runtimeConfig();
    if (!config) throw new Error("Local effect generation is not configured on this host.");
    if ((await hostMemory()).free_gb < 12) throw new Error("Generation needs 12 GB of free RAM, including headroom. Free some memory and try again; existing services have been left running.");
    await mkdir(audioDir(), { recursive: true });
    scratch = await mkdtemp(path.join(audioDir(), "generation-"));
    await new Promise<void>((resolve, reject) => {
      const worker = spawn(config.python, [path.join(process.cwd(), "scripts", "effects-worker.py"), scratch!], {
        windowsHide: true, detached: getHost().platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, HF_HOME: config.hfHome, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
      });
      let stderr = "", timedOut = false;
      worker.stdout.resume();
      worker.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-3000); });
      const timeout = setTimeout(() => {
        timedOut = true;
        if (worker.pid) void terminateLocalWorker(worker.pid).catch(error => console.error("[effects] Worker termination:", error));
      }, 240000);
      worker.on("error", error => { clearTimeout(timeout); console.error("[effects] Worker start:", error); reject(new Error("The local generator could not start. Check its runtime configuration.")); });
      worker.on("close", code => {
        clearTimeout(timeout);
        if (code !== 0 || timedOut) {
          console.error("[effects] Local worker failed:", stderr.slice(-3000));
          reject(new Error(timedOut ? "Local generation timed out. Try a shorter effect." : "The local generator could not finish. Your draft is unchanged. Check the console log and try again."));
        } else resolve();
      });
      worker.stdin.on("error", () => { /* The close/error handler reports a worker failure. */ });
      worker.stdin.end(JSON.stringify(request));
    });
    const bytes = await readFile(path.join(scratch, "output.wav"));
    const generation = { model: EFFECTS_MODEL, prompt: request.prompt, seed: request.seed, steps: 8 };
    const asset = await saveAudioImport(bytes, `${request.name}.wav`, "wav", "Generated locally · Stable Audio 3 Small SFX · Stability AI Community License", generation);
    const recipe: AudioRecipe = { length: request.length, loop: false, notes: request.prompt, layers: [{ id: asset.id, name: asset.name, url: asset.url, duration: request.length, start: 0, end: request.length, offset: 0, gainDb: 0, pitch: 0, fadeIn: 0, fadeOut: 0, lowpass: 24000, pan: 0, muted: false, solo: false }] };
    const revision = await saveAudioRevision(bytes, { event: request.event, name: `${request.name} · seed ${request.seed}`, recipe, peakDb: 0, rmsDb: 0, notes: "" });
    return { asset, revision };
  } finally {
    flight.busy = false;
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(error => console.error("[effects] Scratch cleanup:", error));
  }
}
