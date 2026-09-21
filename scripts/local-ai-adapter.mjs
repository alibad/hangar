#!/usr/bin/env node
/**
 * Loopback-only HTTP adapter for a Mac's local AI toolkit.
 *
 * Hangar speaks stable HTTP contracts for image, video, speech and embeddings.
 * The tools that do that work on Apple silicon are command-line programs, not
 * daemons, so this translates between the two. It never binds off-box, never
 * downloads a model, and serialises heavy work because everything here shares
 * one unified-memory pool.
 *
 * ── DRIVERS, NOT ONE BINARY ─────────────────────────────────────────────────
 * The image path used to call exactly one thing: `local-ai image`, which wraps
 * Draw Things' standalone CLI. On 2026-09-21 that CLI began returning pure
 * static on this machine — macOS 27's Metal compiler rejects the Metal 4
 * cooperative-tensor shaders it ships (`matmul2d_descriptor`,
 * `execution_simdgroups`). The pinned July build fails SILENTLY, emitting a
 * structurally perfect PNG of noise; the current 26.0910.1 at least crashes
 * with the shader error. The same weights render correctly in the Draw Things
 * GUI app, so this is the standalone binary, not the model and not the machine.
 *
 * One hardcoded engine meant one OS upgrade took the whole capability out. So
 * the engine is now DECLARED in the host profile (`runtimes.image.driver`) and
 * implemented here as one small driver each. Swapping engines is a one-line
 * profile edit plus `node scripts/doctor.mjs image --write`.
 *
 * ── AND IT CHECKS ITS OWN OUTPUT ────────────────────────────────────────────
 * Every image leaving this process is measured by lib/image-quality.ts. Static
 * is returned as a 502 naming the driver, never as a 200 the console would
 * save to a gallery. That is the single change that would have turned four
 * silent days into one loud minute.
 *
 * ── PATHS ───────────────────────────────────────────────────────────────────
 * Nothing here hardcodes a home directory. LOCAL_AI_BIN, MFLUX_BIN and
 * HANGAR_HOST_ID come from the environment (see scripts/service-commands.*),
 * and every default resolves relative to the current user.
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { inspectImage } from "../src/lib/image-quality.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOME = os.homedir();
const LOCAL_AI = process.env.LOCAL_AI_BIN || path.join(HOME, "LocalAI/bin/local-ai");
const MFLUX_BIN_DIR = process.env.MFLUX_BIN_DIR || path.join(HOME, ".local/bin");
const PORT = Number(process.env.PORT || process.argv[process.argv.indexOf("--port") + 1] || 8111);
const HOST = "127.0.0.1";
const MAX_BODY = 64 * 1024 * 1024;
const VOICES = ["Ryan", "Aiden", "Serena"];
const EXTRA_PATH = `${path.join(HOME, ".local/bin")}:/opt/homebrew/bin:/usr/local/bin`;

let operation = null;
let tail = Promise.resolve();

// ── which engine drives what, from the host profile ─────────────────────────

/**
 * Read this host's declared runtimes.
 *
 * The profile is the single source of truth the console, the manager and this
 * adapter all read — the same reason profiles are JSON rather than TypeScript.
 * Falling back to the Draw Things CLI keeps an older profile (one written
 * before `runtimes` existed) working exactly as it did.
 */
async function loadRuntimes() {
  const id =
    (process.env.HANGAR_HOST_ID || process.env.HOST_ID || "").trim().toLowerCase() ||
    os.hostname().trim().toLowerCase().replace(/\.local$/, "");
  const dir = path.join(ROOT, "config", "hosts");
  const files = await readdir(dir).catch(() => []);
  const match = files.find((f) => f.replace(/\.json$/, "") === id);
  if (!match) return {};
  try {
    const profile = JSON.parse(await readFile(path.join(dir, match), "utf8"));
    return profile.runtimes ?? {};
  } catch {
    return {};
  }
}

let RUNTIMES = {};
const driverFor = (capability, fallback) => RUNTIMES[capability]?.driver ?? fallback;
const modelFor = (capability, fallback) => RUNTIMES[capability]?.model ?? fallback;
/** Profile JSON carries `_doc` keys for humans; they are not capabilities. */
const declaredRuntimes = () => Object.entries(RUNTIMES).filter(([k]) => !k.startsWith("_"));

// ── plumbing ────────────────────────────────────────────────────────────────

function json(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": data.length });
  res.end(data);
}

function bytes(res, status, body, contentType) {
  res.writeHead(status, { "Content-Type": contentType, "Content-Length": body.length });
  res.end(body);
}

async function bodyBuffer(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function jsonBody(req) {
  const raw = await bodyBuffer(req);
  return raw.length ? JSON.parse(raw.toString("utf8")) : {};
}

function runCommand(bin, args, { timeoutMs = 15 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      env: { ...process.env, PATH: `${EXTRA_PATH}:${process.env.PATH || ""}` },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${path.basename(bin)} timed out after ${Math.round(timeoutMs / 1000)} seconds`));
    }, timeoutMs);
    child.on("exit", (code, signal) => {
      clearTimeout(timeout);
      const out = Buffer.concat(stdout).toString("utf8").trim();
      const err = Buffer.concat(stderr).toString("utf8").trim();
      if (code === 0) resolve({ stdout: out, stderr: err });
      else reject(new Error(err || out || `${path.basename(bin)} exited ${code ?? signal}`));
    });
  });
}

const runCli = (args, opts) => runCommand(LOCAL_AI, args, opts);

/**
 * One heavy job at a time.
 *
 * Draw Things, MLX and Ollama all draw on the same unified pool, and two
 * concurrent generations do not fail cleanly — they thrash. This is also why
 * the adapter is NOT split into one process per capability: the serialisation
 * is the feature, and separate processes could not enforce it.
 */
function queued(kind, task) {
  const startedAt = new Date().toISOString();
  const run = async () => {
    operation = { kind, startedAt };
    try {
      return await task();
    } finally {
      operation = null;
    }
  };
  const result = tail.then(run, run);
  tail = result.catch(() => {});
  return result;
}

function dimensions(body, defaults) {
  const parseSize = /^([0-9]+)x([0-9]+)$/.exec(String(body.size || ""));
  const width = Number(body.width || parseSize?.[1] || defaults.width);
  const height = Number(body.height || parseSize?.[2] || defaults.height);
  return { width, height };
}

function dataImage(value) {
  const match = /^data:image\/[a-z0-9.+-]+;base64,(.+)$/i.exec(String(value || ""));
  if (!match) throw new Error("Reference image must be a base64 data URL");
  return Buffer.from(match[1], "base64");
}

async function withTemp(prefix, task) {
  const dir = await mkdtemp(path.join(os.tmpdir(), `hangar-${prefix}-`));
  try {
    return await task(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Raised when a driver produced output that is not what it claims to be. */
class OutputError extends Error {
  constructor(message) {
    super(message);
    this.name = "OutputError";
    this.badOutput = true;
  }
}

// ── image drivers ───────────────────────────────────────────────────────────
//
// Each takes the same options and returns a PNG buffer. Adding an engine is a
// function here plus a `driver` string in the host profile.

const IMAGE_DRIVERS = {
  /**
   * Draw Things' standalone CLI, through the LocalAI wrapper.
   * Known-broken on macOS 27 — see the header. Kept because it is correct on
   * other macOS versions and the doctor decides per machine.
   */
  async "draw-things-cli"({ prompt, width, height, steps, seed, reference, dir }) {
    const output = path.join(dir, "result.png");
    const args = ["image", "--text", prompt, "--out", output, "--width", String(width), "--height", String(height), "--steps", String(steps), "--seed", String(seed)];
    if (reference) {
      const input = path.join(dir, "reference.png");
      await writeFile(input, reference);
      args.push("--image", input);
    }
    await runCli(args);
    return readFile(output);
  },

  /**
   * mflux — FLUX.2 on Apple's MLX.
   *
   * Chosen as B5's driver on 2026-09-21 because MLX is a different compute
   * stack from Draw Things' custom Metal shaders, and MLX is already proven on
   * this machine: the speech models have run on it since September. It is also
   * the more portable answer — pip-installable, headless, no GUI app to leave
   * running — which matters for the machines that are not this one.
   */
  async mflux({ prompt, width, height, steps, seed, reference, dir, model }) {
    const output = path.join(dir, "result.png");
    const bin = path.join(MFLUX_BIN_DIR, reference ? "mflux-generate-flux2-edit" : "mflux-generate-flux2");
    const args = [
      "--prompt", prompt,
      "--width", String(width),
      "--height", String(height),
      "--steps", String(steps),
      "--seed", String(seed),
      "--output", output,
      // 8-bit keeps a 4B model comfortably inside a shared pool while leaving
      // room for whatever chat model is resident. Quality loss is not visible
      // at these step counts.
      "--quantize", "8",
      // mflux writes a metadata JSON beside the image unless told not to;
      // the console keeps its own sidecar, so a second one is just litter.
      "--no-metadata",
    ];
    // `model` is deliberately NOT passed as --base-model. The profile's model
    // field is the name the console DISPLAYS and reasons about; mflux resolves
    // its own checkpoint, and handing it a display name it does not recognise
    // would fail a generation that otherwise works. A host that needs a
    // specific mflux base model should gain an explicit field for it rather
    // than overloading this one.
    if (reference) {
      const input = path.join(dir, "reference.png");
      await writeFile(input, reference);
      args.push("--image-path", input);
    }
    await runCommand(bin, args, { timeoutMs: 20 * 60_000 });
    return readFile(output);
  },

  /**
   * The Draw Things GUI app's own local server.
   *
   * The app renders correctly on this machine when its CLI does not, so this
   * is the fallback that reuses the known-good engine. It needs the server
   * switched on inside the app (Settings → Server), which is a human action;
   * the doctor reports it as unreachable rather than guessing.
   */
  async "draw-things-app"({ prompt, width, height, steps, seed, dir }) {
    const base = process.env.DRAW_THINGS_URL || "http://127.0.0.1:7860";
    const res = await fetch(`${base}/sdapi/v1/txt2img`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, width, height, steps, seed, cfg_scale: 1 }),
      signal: AbortSignal.timeout(20 * 60_000),
    }).catch((cause) => {
      throw new Error(`Draw Things' local server is not answering on ${base}. Switch the server on in the app (Settings → Server), or point DRAW_THINGS_URL at it. (${cause.message})`);
    });
    if (!res.ok) throw new Error(`Draw Things server returned HTTP ${res.status}`);
    const body = await res.json();
    const b64 = body?.images?.[0];
    if (!b64) throw new Error("Draw Things server returned no image");
    void dir;
    return Buffer.from(b64, "base64");
  },
};

async function imageGeneration(body, edit = false) {
  const prompt = String(body.prompt || "").trim();
  if (!prompt) throw new Error("Prompt is required");
  const { width, height } = dimensions(body, { width: 1024, height: 1024 });
  const steps = Number(body.steps || 4);
  const seed = Number.isFinite(Number(body.seed)) ? Math.floor(Number(body.seed)) : 42;

  const driverName = driverFor("image", "draw-things-cli");
  const driver = IMAGE_DRIVERS[driverName];
  if (!driver) {
    throw new Error(`No image driver called "${driverName}". Set runtimes.image.driver in this host's profile to one of: ${Object.keys(IMAGE_DRIVERS).join(", ")}.`);
  }

  let reference = null;
  if (edit) {
    const images = Array.isArray(body.images) ? body.images : [];
    if (images.length !== 1) throw new Error("Editing currently accepts exactly one reference image");
    reference = dataImage(images[0]);
  }

  return queued(edit ? "image-edit" : "image", () =>
    withTemp("image", async (dir) => {
      const png = await driver({ prompt, width, height, steps, seed, reference, dir, model: modelFor("image", null) });


      // The gate. A driver that returns static returns an error instead — the
      // console must never be handed noise it would save as a success.
      const verdict = inspectImage(png);
      if (!verdict.ok) {
        throw new OutputError(
          `${driverName} produced static rather than an image. ${verdict.reason} ` +
          `Try a different runtimes.image.driver in this host's profile.`,
        );
      }
      return png;
    }),
  );
}

// ── video ───────────────────────────────────────────────────────────────────

async function videoGeneration(body) {
  const prompt = String(body.prompt || "").trim();
  if (!prompt) throw new Error("Prompt is required");
  const { width, height } = dimensions(body, { width: 768, height: 448 });
  const steps = Number(body.steps || 30);
  const frames = Number(body.frames || 49);
  const seed = Number.isFinite(Number(body.seed)) ? Math.floor(Number(body.seed)) : 42;
  const driverName = driverFor("video", "draw-things-cli");
  if (driverName !== "draw-things-cli") {
    throw new Error(`No video driver called "${driverName}" is implemented in this adapter.`);
  }
  return queued("video", () =>
    withTemp("video", async (dir) => {
      const output = path.join(dir, "result.mp4");
      const args = ["video", "--text", prompt, "--out", output, "--width", String(width), "--height", String(height), "--steps", String(steps), "--frames", String(frames), "--seed", String(seed)];
      if (body.image) {
        const input = path.join(dir, "reference.png");
        await writeFile(input, dataImage(body.image));
        args.push("--image", input);
      }
      await runCli(args, { timeoutMs: 30 * 60_000 });
      const mp4 = await readFile(output);
      // The cheapest structural check there is. Frame-level inspection needs a
      // decoder and belongs in the doctor, which has ffmpeg available to it.
      if (mp4.length < 4096 || mp4.toString("ascii", 4, 8) !== "ftyp") {
        throw new OutputError(`${driverName} returned ${mp4.length} bytes that are not an MP4 container.`);
      }
      return mp4;
    }),
  );
}

// ── speech and embeddings ───────────────────────────────────────────────────

async function speech(body) {
  const input = String(body.input || body.text || "").trim();
  if (!input) throw new Error("Text is required");
  const voice = VOICES.includes(String(body.voice)) ? String(body.voice) : "Ryan";
  const language = String(body.language || "English");
  const style = String(body.instructions || body.style || "Speak naturally and warmly, like explaining an idea to a friend. Conversational pacing, subtle expression, no announcer voice.");
  return queued("speech", () =>
    withTemp("speech", async (dir) => {
      const output = path.join(dir, "speech.wav");
      await runCli(["speak", "--text", input, "--voice", voice, "--language", language, "--style", style, "--out", output], { timeoutMs: 5 * 60_000 });
      const wav = await readFile(output);
      // Silence is TTS's version of static: a valid file containing nothing.
      if (wav.length < 2048) throw new OutputError("The speech engine returned an empty audio file.");
      return wav;
    }),
  );
}

async function transcription(req) {
  const request = new Request(`http://${HOST}:${PORT}/v1/audio/transcriptions`, {
    method: "POST",
    headers: req.headers,
    body: Readable.toWeb(req),
    duplex: "half",
  });
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof Blob)) throw new Error("An audio file is required");
  return queued("transcription", () =>
    withTemp("stt", async (dir) => {
      const ext = path.extname(typeof file.name === "string" ? file.name : "") || ".wav";
      const input = path.join(dir, `audio${ext}`);
      await writeFile(input, Buffer.from(await file.arrayBuffer()));
      const language = String(form.get("language") || "").trim();
      const args = ["transcribe", input, ...(language ? ["--language", language] : [])];
      const result = await runCli(args, { timeoutMs: 10 * 60_000 });
      return result.stdout;
    }),
  );
}

async function embeddings(body) {
  const input = Array.isArray(body.input) ? body.input.map(String) : [String(body.input || body.text || "")];
  if (!input.length || input.some((item) => !item.trim())) throw new Error("Embedding input is required");
  return queued("embedding", async () => {
    const vectors = [];
    for (const item of input) {
      const result = await runCli(["embed", "--text", item], { timeoutMs: 5 * 60_000 });
      const parsed = JSON.parse(result.stdout);
      const vector = parsed.embeddings?.[0] || parsed.embedding;
      if (!Array.isArray(vector)) throw new Error("LocalAI returned no embedding vector");
      vectors.push(vector);
    }
    return vectors;
  });
}

// ── routes ──────────────────────────────────────────────────────────────────

async function handle(req, res) {
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/v1/health")) {
    const image = RUNTIMES.image ?? {};
    return json(res, 200, {
      ok: true,
      model: image.label || image.model || "image runtime",
      loaded: false,
      load: { state: operation?.kind?.startsWith("image") ? "loading" : "idle" },
      edit: { enabled: true, model: image.label || "edit", loaded: false },
      capabilities: ["image", "video", "stt", "tts", "embedding"],
      local: true,
      operation,
      // Declared so the console can distinguish "listening" from "works". A
      // health check cannot tell those apart; only the doctor can.
      drivers: Object.fromEntries(declaredRuntimes().map(([k, v]) => [k, v.driver ?? null])),
      verified: Object.fromEntries(declaredRuntimes().map(([k, v]) => [k, v.verifiedAt ?? null])),
    });
  }
  if (req.method === "GET" && url.pathname === "/progress") {
    return json(res, 200, operation ? { running: true, phase: operation.kind, startedAt: operation.startedAt } : { running: false });
  }
  if (req.method === "GET" && url.pathname === "/v1/audio/voices") {
    return json(res, 200, { voices: VOICES.map((id) => ({ id, label: `${id} · preset voice` })), can_clone: false });
  }
  if (req.method === "POST" && url.pathname === "/v1/audio/speech") {
    const audio = await speech(await jsonBody(req));
    return bytes(res, 200, audio, "audio/wav");
  }
  if (req.method === "POST" && url.pathname === "/v1/audio/transcriptions") {
    const text = await transcription(req);
    return json(res, 200, { text, model: modelFor("stt", "local") });
  }
  if (req.method === "POST" && url.pathname === "/v1/embeddings") {
    const body = await jsonBody(req);
    const vectors = await embeddings(body);
    return json(res, 200, { object: "list", model: modelFor("embedding", "local"), data: vectors.map((embedding, index) => ({ object: "embedding", index, embedding })) });
  }
  if (req.method === "POST" && ["/generate", "/v1/images/generations"].includes(url.pathname)) {
    const image = await imageGeneration(await jsonBody(req));
    if (url.pathname.startsWith("/v1/")) return json(res, 200, { created: Math.floor(Date.now() / 1000), data: [{ b64_json: image.toString("base64") }] });
    return bytes(res, 200, image, "image/png");
  }
  if (req.method === "POST" && url.pathname === "/edit") {
    const image = await imageGeneration(await jsonBody(req), true);
    return bytes(res, 200, image, "image/png");
  }
  if (req.method === "POST" && ["/video", "/v1/videos/generations"].includes(url.pathname)) {
    const video = await videoGeneration(await jsonBody(req));
    if (url.pathname.startsWith("/v1/")) return json(res, 200, { created: Math.floor(Date.now() / 1000), data: [{ b64_json: video.toString("base64"), format: "mp4" }] });
    return bytes(res, 200, video, "video/mp4");
  }
  return json(res, 404, { error: "not found" });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error(`[local-ai-adapter] ${req.method} ${req.url}:`, error);
    if (!res.headersSent) {
      // 502 for bad output: the request was fine, the engine behind it was not.
      // A 500 here would read as an adapter bug and send someone to the wrong
      // file.
      const status = error?.badOutput ? 502 : /required|accepts exactly|too large/i.test(String(error?.message)) ? 400 : 500;
      json(res, status, { error: error instanceof Error ? error.message : String(error), badOutput: !!error?.badOutput });
    } else res.destroy();
  });
});

loadRuntimes().then((runtimes) => {
  RUNTIMES = runtimes;
  server.listen(PORT, HOST, () => {
    console.log(`[local-ai-adapter] listening on http://${HOST}:${PORT}`);
    console.log(`[local-ai-adapter] CLI ${LOCAL_AI}`);
    const declared = declaredRuntimes().map(
      ([k, v]) => `${k}=${v.driver ?? "none"}${v.verifiedAt ? "" : " (unverified)"}`,
    );
    console.log(`[local-ai-adapter] drivers ${declared.join(" ") || "none declared — falling back to draw-things-cli"}`);
  });
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
