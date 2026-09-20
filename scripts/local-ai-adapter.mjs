#!/usr/bin/env node
/**
 * Loopback-only HTTP adapter for the verified LocalAI toolkit on B5.
 *
 * The toolkit intentionally exposes commands, not a daemon. Hangar already
 * speaks stable HTTP contracts for image, speech and model services, so this
 * small adapter translates those contracts into the existing local-ai CLI.
 * It never binds off-box, never downloads a model, and serializes heavy work
 * because Draw Things and MLX share one unified-memory pool.
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

const LOCAL_AI = process.env.LOCAL_AI_BIN || "/Users/alibadereddin/LocalAI/bin/local-ai";
const PORT = Number(process.env.PORT || process.argv[process.argv.indexOf("--port") + 1] || 8111);
const HOST = "127.0.0.1";
const MAX_BODY = 64 * 1024 * 1024;
const VOICES = ["Ryan", "Aiden", "Serena"];

let operation = null;
let tail = Promise.resolve();

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

function runCli(args, { timeoutMs = 15 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(LOCAL_AI, args, {
      env: { ...process.env, PATH: `/Users/alibadereddin/.local/bin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ""}` },
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
      reject(new Error(`local-ai timed out after ${Math.round(timeoutMs / 1000)} seconds`));
    }, timeoutMs);
    child.on("exit", (code, signal) => {
      clearTimeout(timeout);
      const out = Buffer.concat(stdout).toString("utf8").trim();
      const err = Buffer.concat(stderr).toString("utf8").trim();
      if (code === 0) resolve({ stdout: out, stderr: err });
      else reject(new Error(err || out || `local-ai exited ${code ?? signal}`));
    });
  });
}

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

async function imageGeneration(body, edit = false) {
  const prompt = String(body.prompt || "").trim();
  if (!prompt) throw new Error("Prompt is required");
  const { width, height } = dimensions(body, { width: 1024, height: 1024 });
  const steps = Number(body.steps || 4);
  const seed = Number.isFinite(Number(body.seed)) ? Math.floor(Number(body.seed)) : 42;
  return queued(edit ? "image-edit" : "image", () => withTemp("image", async (dir) => {
    const output = path.join(dir, "result.png");
    const args = ["image", "--text", prompt, "--out", output, "--width", String(width), "--height", String(height), "--steps", String(steps), "--seed", String(seed)];
    if (edit) {
      const images = Array.isArray(body.images) ? body.images : [];
      if (images.length !== 1) throw new Error("Draw Things editing currently accepts exactly one reference image");
      const input = path.join(dir, "reference.png");
      await writeFile(input, dataImage(images[0]));
      args.push("--image", input);
    }
    await runCli(args);
    return readFile(output);
  }));
}

async function videoGeneration(body) {
  const prompt = String(body.prompt || "").trim();
  if (!prompt) throw new Error("Prompt is required");
  const { width, height } = dimensions(body, { width: 768, height: 448 });
  const steps = Number(body.steps || 30);
  const frames = Number(body.frames || 49);
  const seed = Number.isFinite(Number(body.seed)) ? Math.floor(Number(body.seed)) : 42;
  return queued("video", () => withTemp("video", async (dir) => {
    const output = path.join(dir, "result.mp4");
    const args = ["video", "--text", prompt, "--out", output, "--width", String(width), "--height", String(height), "--steps", String(steps), "--frames", String(frames), "--seed", String(seed)];
    if (body.image) {
      const input = path.join(dir, "reference.png");
      await writeFile(input, dataImage(body.image));
      args.push("--image", input);
    }
    await runCli(args, { timeoutMs: 30 * 60_000 });
    return readFile(output);
  }));
}

async function speech(body) {
  const input = String(body.input || body.text || "").trim();
  if (!input) throw new Error("Text is required");
  const voice = VOICES.includes(String(body.voice)) ? String(body.voice) : "Ryan";
  const language = String(body.language || "English");
  const style = String(body.instructions || body.style || "Speak naturally and warmly, like explaining an idea to a friend. Conversational pacing, subtle expression, no announcer voice.");
  return queued("speech", () => withTemp("speech", async (dir) => {
    const output = path.join(dir, "speech.wav");
    await runCli(["speak", "--text", input, "--voice", voice, "--language", language, "--style", style, "--out", output], { timeoutMs: 5 * 60_000 });
    return readFile(output);
  }));
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
  return queued("transcription", () => withTemp("stt", async (dir) => {
    const ext = path.extname(typeof file.name === "string" ? file.name : "") || ".wav";
    const input = path.join(dir, `audio${ext}`);
    await writeFile(input, Buffer.from(await file.arrayBuffer()));
    const language = String(form.get("language") || "").trim();
    const args = ["transcribe", input, ...(language ? ["--language", language] : [])];
    const result = await runCli(args, { timeoutMs: 10 * 60_000 });
    return result.stdout;
  }));
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

async function handle(req, res) {
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/v1/health")) {
    return json(res, 200, {
      ok: true,
      model: "FLUX.2 Klein 4B · Draw Things",
      loaded: false,
      load: { state: operation?.kind?.startsWith("image") ? "loading" : "idle" },
      edit: { enabled: true, model: "FLUX.2 Klein 4B · Draw Things edit", loaded: false },
      capabilities: ["image", "video", "stt", "tts", "embedding"],
      local: true,
      operation,
    });
  }
  if (req.method === "GET" && url.pathname === "/progress") {
    return json(res, 200, operation ? { running: true, phase: operation.kind, startedAt: operation.startedAt } : { running: false });
  }
  if (req.method === "GET" && url.pathname === "/v1/audio/voices") {
    return json(res, 200, { voices: VOICES.map((id) => ({ id, label: `${id} · Qwen3-TTS preset` })), can_clone: false });
  }
  if (req.method === "POST" && url.pathname === "/v1/audio/speech") {
    const audio = await speech(await jsonBody(req));
    return bytes(res, 200, audio, "audio/wav");
  }
  if (req.method === "POST" && url.pathname === "/v1/audio/transcriptions") {
    const text = await transcription(req);
    return json(res, 200, { text, model: "qwen3-asr-1.7b-8bit" });
  }
  if (req.method === "POST" && url.pathname === "/v1/embeddings") {
    const body = await jsonBody(req);
    const vectors = await embeddings(body);
    return json(res, 200, { object: "list", model: "qwen3-embedding:0.6b", data: vectors.map((embedding, index) => ({ object: "embedding", index, embedding })) });
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
    if (!res.headersSent) json(res, /required|accepts exactly|too large/i.test(String(error?.message)) ? 400 : 500, { error: error instanceof Error ? error.message : String(error) });
    else res.destroy();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[local-ai-adapter] listening on http://${HOST}:${PORT}`);
  console.log(`[local-ai-adapter] CLI ${LOCAL_AI}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
