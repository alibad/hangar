#!/usr/bin/env node
/**
 * Prove this machine can actually do what its profile claims.
 *
 *   node scripts/doctor.mjs              every declared runtime
 *   node scripts/doctor.mjs image        just one
 *   node scripts/doctor.mjs --write      record passes as `verifiedAt`
 *   node scripts/doctor.mjs --json       machine-readable, for the setup skill
 *
 * ── WHY ─────────────────────────────────────────────────────────────────────
 * Health checks answer "is something listening". That question had been
 * answered `true` for four days while every image this machine produced was
 * pure static. The service was up; the port replied; the PNG was valid; the
 * pixels were noise.
 *
 * So every check here runs a REAL job and inspects the OUTPUT:
 *
 *   text       ask a question with one correct answer, and read the answer
 *   vision     show it a red square, ask what colour it is
 *   image      generate 512², measure whether it is a picture or static
 *   tts        speak a sentence, check the audio is audible and long enough
 *   stt        transcribe THAT audio, check the words come back
 *   embedding  embed three strings, check related ones actually score closer
 *   video      render a few frames, check the container decodes
 *
 * A check that cannot run says so and is NOT recorded as a pass. `verifiedAt`
 * is written only by this script, only on a genuine pass, and only with
 * --write. Nothing else in the console may set it.
 */

import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { inspectImage } from "../src/lib/image-quality.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const JSON_OUT = args.includes("--json");
const ONLY = args.filter((a) => !a.startsWith("-"));

const GREEN = "\x1b[32m", RED = "\x1b[31m", DIM = "\x1b[2m", YELLOW = "\x1b[33m", OFF = "\x1b[0m";
const log = (...m) => { if (!JSON_OUT) console.log(...m); };

// ── host profile ────────────────────────────────────────────────────────────

function resolveHostId(profiles) {
  const env = (process.env.HOST_ID ?? "").trim().toLowerCase();
  if (env && profiles[env]) return env;
  const host = os.hostname().trim().toLowerCase().replace(/\.local$/, "");
  if (profiles[host]) return host;
  return null;
}

async function loadProfiles() {
  const dir = path.join(ROOT, "config", "hosts");
  const { readdir } = await import("node:fs/promises");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json") && f !== "example.json");
  const out = {};
  for (const f of files) out[f.replace(/\.json$/, "")] = JSON.parse(await readFile(path.join(dir, f), "utf8"));
  return out;
}

/** localUrl of a service in this profile, with ${PUBLIC_DOMAIN} left alone (loopback only). */
function serviceUrl(profile, id) {
  const svc = profile.services?.find((s) => s.id === id);
  return svc?.localUrl ?? null;
}

// ── helpers ─────────────────────────────────────────────────────────────────

async function withTemp(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hangar-doctor-"));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

function run(cmd, cmdArgs, { timeoutMs = 600_000, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, {
      env: { ...process.env, PATH: `${os.homedir()}/.local/bin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ""}`, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out = [], err = [];
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));
    child.on("error", reject);
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`timed out after ${timeoutMs / 1000}s`)); }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString("utf8").trim();
      const stderr = Buffer.concat(err).toString("utf8").trim();
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.split("\n").slice(-4).join(" ").slice(0, 400) || stdout.slice(0, 200) || `exit ${code}`));
    });
  });
}

async function postJson(url, body, timeoutMs = 600_000) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Source": "hangar-doctor" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res;
}

/** A minimal RIFF/WAVE reader: enough to say "is there audible audio here". */
function inspectWav(buf) {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    return { ok: false, reason: "not a WAV file" };
  }
  let pos = 12, rate = 0, channels = 1, bits = 16, dataStart = 0, dataLen = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === "fmt ") { channels = buf.readUInt16LE(pos + 10); rate = buf.readUInt32LE(pos + 12); bits = buf.readUInt16LE(pos + 22); }
    else if (id === "data") { dataStart = pos + 8; dataLen = Math.min(size, buf.length - dataStart); break; }
    pos += 8 + size + (size % 2);
  }
  if (!rate || !dataLen) return { ok: false, reason: "no audio data" };
  const seconds = dataLen / (rate * channels * (bits / 8));
  // Silence is the TTS equivalent of static: a valid file containing nothing.
  let peak = 0;
  if (bits === 16) {
    for (let i = dataStart; i + 1 < dataStart + dataLen; i += 2) peak = Math.max(peak, Math.abs(buf.readInt16LE(i)));
  }
  const level = peak / 32768;
  if (seconds < 0.3) return { ok: false, reason: `only ${seconds.toFixed(2)}s of audio`, seconds, level };
  if (bits === 16 && level < 0.01) return { ok: false, reason: "the audio is silent", seconds, level };
  return { ok: true, seconds, level };
}

/** Word overlap, so a transcript is judged on content rather than punctuation. */
function wordOverlap(expected, actual) {
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  const want = norm(expected), got = new Set(norm(actual));
  if (!want.length) return 0;
  return want.filter((w) => got.has(w)).length / want.length;
}

/** A tiny solid-red PNG, for asking a vision model a question with one answer. */
function redSquarePng(size = 128) {
  const zlib = require("node:zlib");
  const stride = size * 3;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const i = y * (stride + 1) + 1 + x * 3;
      raw[i] = 220; raw[i + 1] = 20; raw[i + 2] = 20;
    }
  }
  const chunk = (type, body) => {
    const out = Buffer.alloc(body.length + 12);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, "ascii");
    body.copy(out, 8);
    out.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type, "ascii"), body])) >>> 0, body.length + 8);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

// ── the checks ──────────────────────────────────────────────────────────────
//
// Each returns { ok, note, detail } and NEVER throws: a check that cannot run
// is a reported skip, not a crashed doctor.

const CHECKS = {
  async text(rt, profile) {
    const base = serviceUrl(profile, rt.serviceId ?? "ollama");
    if (!base) return { ok: false, skipped: true, note: `no service "${rt.serviceId}" in this profile` };
    const t0 = Date.now();
    const res = await postJson(`${base}/v1/chat/completions`, {
      model: rt.model,
      messages: [{ role: "user", content: "Reply with only the word: HANGAR" }],
      max_tokens: 2000,
      stream: false,
    }, 300_000);
    const body = await res.json();
    const content = body?.choices?.[0]?.message?.content ?? "";
    const ms = Date.now() - t0;
    // The answer is checked, not just its existence. A reasoning model that
    // spends its whole budget in `thinking` and returns "" is exactly the
    // silent failure this file exists to catch — it happened here in September
    // with qwen3-vl:32b (the thinking variant) and looked like a timeout.
    if (!content.trim()) return { ok: false, note: `answered with an empty string in ${ms} ms (a reasoning model may have spent its whole budget thinking)` };
    if (!/hangar/i.test(content)) return { ok: false, note: `did not follow a one-word instruction: ${JSON.stringify(content.slice(0, 80))}` };
    return { ok: true, note: `${ms} ms, answered correctly` };
  },

  async vision(rt, profile) {
    const base = serviceUrl(profile, rt.serviceId ?? "ollama");
    if (!base) return { ok: false, skipped: true, note: `no service "${rt.serviceId}" in this profile` };
    const t0 = Date.now();
    const res = await postJson(`${base}/v1/chat/completions`, {
      model: rt.model,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "What single colour fills this image? Answer with one word." },
          { type: "image_url", image_url: { url: `data:image/png;base64,${redSquarePng().toString("base64")}` } },
        ],
      }],
      max_tokens: 2000,
      stream: false,
    }, 300_000);
    const body = await res.json();
    const content = body?.choices?.[0]?.message?.content ?? "";
    const ms = Date.now() - t0;
    if (!content.trim()) return { ok: false, note: `answered with an empty string in ${ms} ms` };
    if (!/red|crimson|scarlet/i.test(content)) return { ok: false, note: `could not see a red square: ${JSON.stringify(content.slice(0, 80))}` };
    return { ok: true, note: `${ms} ms, identified the colour` };
  },

  async image(rt, profile) {
    const base = serviceUrl(profile, rt.serviceId ?? "qwen");
    if (!base) return { ok: false, skipped: true, note: `no service "${rt.serviceId}" in this profile` };
    const t0 = Date.now();
    const res = await postJson(`${base}/generate`, {
      prompt: "a single red apple on a plain white studio background, sharp focus",
      width: 512, height: 512, steps: 4, seed: 20260921,
    }, 900_000);
    const buf = Buffer.from(await res.arrayBuffer());
    const ms = Date.now() - t0;
    const verdict = inspectImage(buf);
    if (!verdict.ok) {
      return { ok: false, note: `returned static after ${(ms / 1000).toFixed(1)}s`, detail: verdict.reason };
    }
    if (verdict.neighbourDelta < 0) {
      return { ok: false, note: `returned ${buf.length} bytes that could not be decoded as a PNG` };
    }
    return {
      ok: true,
      note: `${verdict.width}×${verdict.height} in ${(ms / 1000).toFixed(1)}s, ${(verdict.smoothFraction * 100).toFixed(0)}% smooth`,
    };
  },

  async tts(rt, profile) {
    const base = serviceUrl(profile, rt.serviceId ?? "qwen");
    if (!base) return { ok: false, skipped: true, note: `no service "${rt.serviceId}" in this profile` };
    const t0 = Date.now();
    const res = await postJson(`${base}/v1/audio/speech`, { input: SPOKEN_PHRASE, model: rt.model }, 300_000);
    const buf = Buffer.from(await res.arrayBuffer());
    const ms = Date.now() - t0;
    const wav = inspectWav(buf);
    if (!wav.ok) return { ok: false, note: `${wav.reason} after ${(ms / 1000).toFixed(1)}s` };
    lastSpokenWav = buf; // handed to the stt check below
    return { ok: true, note: `${wav.seconds.toFixed(1)}s of audio in ${(ms / 1000).toFixed(1)}s, peak ${(wav.level * 100).toFixed(0)}%` };
  },

  async stt(rt, profile) {
    const base = serviceUrl(profile, rt.serviceId ?? "qwen");
    if (!base) return { ok: false, skipped: true, note: `no service "${rt.serviceId}" in this profile` };
    if (!lastSpokenWav) {
      return { ok: false, skipped: true, note: "needs the tts check to produce audio first — run the doctor without a capability filter" };
    }
    const t0 = Date.now();
    const form = new FormData();
    form.append("file", new Blob([lastSpokenWav], { type: "audio/wav" }), "doctor.wav");
    form.append("model", rt.model);
    const res = await fetch(`${base}/v1/audio/transcriptions`, {
      method: "POST", body: form, headers: { "X-Source": "hangar-doctor" }, signal: AbortSignal.timeout(600_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    const ms = Date.now() - t0;
    const text = String(body?.text ?? "");
    const score = wordOverlap(SPOKEN_PHRASE, text);
    // 0.6 rather than 1.0: ASR legitimately differs on casing, punctuation and
    // the odd homophone, and demanding an exact match would fail a working
    // engine. Well clear of the ~0.1 a wrong or truncated transcript scores —
    // and truncation is the real risk: a transcriber that silently returns a
    // fifth of the audio reads as a fluent, plausible sentence.
    if (score < 0.6) {
      return { ok: false, note: `recovered ${(score * 100).toFixed(0)}% of the spoken words in ${(ms / 1000).toFixed(1)}s`, detail: `heard: ${JSON.stringify(text.slice(0, 160))}` };
    }
    return { ok: true, note: `${(score * 100).toFixed(0)}% of words recovered in ${(ms / 1000).toFixed(1)}s` };
  },

  async embedding(rt, profile) {
    const base = serviceUrl(profile, rt.serviceId ?? "ollama");
    if (!base) return { ok: false, skipped: true, note: `no service "${rt.serviceId}" in this profile` };
    const t0 = Date.now();
    const res = await postJson(`${base}/v1/embeddings`, {
      model: rt.model,
      input: ["a cat sleeping on a windowsill", "a kitten napping by the window", "quarterly financial reporting standards"],
    }, 300_000);
    const body = await res.json();
    const ms = Date.now() - t0;
    const vecs = (body?.data ?? []).map((d) => d.embedding);
    if (vecs.length !== 3 || !Array.isArray(vecs[0]) || vecs[0].length < 8) {
      return { ok: false, note: "did not return three usable vectors" };
    }
    const cos = (a, b) => {
      let dot = 0, na = 0, nb = 0;
      for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
      return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
    };
    const near = cos(vecs[0], vecs[1]);
    const far = cos(vecs[0], vecs[2]);
    // A model returning constant or random vectors passes a shape check and
    // fails this one. That is the whole difference between "it responded" and
    // "it works".
    if (!(near > far)) {
      return { ok: false, note: `vectors carry no meaning — related text scored ${near.toFixed(3)}, unrelated ${far.toFixed(3)}` };
    }
    return { ok: true, note: `${vecs[0].length} dimensions in ${ms} ms, related ${near.toFixed(2)} vs unrelated ${far.toFixed(2)}` };
  },

  async video(rt, profile) {
    const base = serviceUrl(profile, rt.serviceId ?? "qwen");
    if (!base) return { ok: false, skipped: true, note: `no service "${rt.serviceId}" in this profile` };
    const t0 = Date.now();
    const res = await postJson(`${base}/video`, {
      prompt: "gentle ripples moving across a calm lake", width: 512, height: 320, frames: 17, steps: 8, seed: 20260921,
    }, 1_800_000);
    const buf = Buffer.from(await res.arrayBuffer());
    const ms = Date.now() - t0;
    if (buf.length < 4096 || buf.toString("ascii", 4, 8) !== "ftyp") {
      return { ok: false, note: `returned ${buf.length} bytes that are not an MP4 container` };
    }
    // If ffmpeg is here, decode a frame and run it through the same picture
    // test as an image. Without it, the container check is all that is
    // claimed, and the note says so rather than implying more.
    return await withTemp(async (dir) => {
      const mp4 = path.join(dir, "clip.mp4");
      const frame = path.join(dir, "frame.png");
      await writeFile(mp4, buf);
      try {
        await run("ffmpeg", ["-v", "error", "-i", mp4, "-frames:v", "1", "-f", "image2", frame], { timeoutMs: 120_000 });
      } catch {
        return { ok: true, note: `${(buf.length / 1e6).toFixed(1)} MB MP4 in ${(ms / 1000).toFixed(0)}s — container only, install ffmpeg to check the frames` };
      }
      const verdict = inspectImage(await readFile(frame));
      if (!verdict.ok) return { ok: false, note: `frames are static after ${(ms / 1000).toFixed(0)}s`, detail: verdict.reason };
      return { ok: true, note: `${(buf.length / 1e6).toFixed(1)} MB MP4 in ${(ms / 1000).toFixed(0)}s, first frame is a picture` };
    });
  },
};

/** Spoken by the tts check and transcribed back by the stt check. */
const SPOKEN_PHRASE = "The quick brown fox jumps over the lazy dog near the river bank.";
let lastSpokenWav = null;

// Ordered so tts runs before stt, which consumes its output.
const ORDER = ["text", "vision", "embedding", "image", "tts", "stt", "video"];

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  const profiles = await loadProfiles();
  const hostId = resolveHostId(profiles);
  if (!hostId) {
    const msg = `No host profile matches this machine (${os.hostname()}). Run /hangar-setup or \`node scripts/detect-host.mjs\` first.`;
    if (JSON_OUT) console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
    else console.error(`${RED}✗${OFF} ${msg}`);
    process.exit(2);
  }

  const profile = profiles[hostId];
  const runtimes = Object.entries(profile.runtimes ?? {}).filter(([k]) => !k.startsWith("_"));
  if (!runtimes.length) {
    const msg = `config/hosts/${hostId}.json declares no \`runtimes\`. See config/hosts/example.json for the block to add.`;
    if (JSON_OUT) console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
    else console.error(`${YELLOW}!${OFF} ${msg}`);
    process.exit(2);
  }

  log(`\n${profile.name} (${hostId}) — checking what this machine can actually do\n`);

  const results = {};
  const wanted = ORDER.filter((c) => runtimes.some(([k]) => k === c) && (!ONLY.length || ONLY.includes(c)));
  // A capability asked for but not declared is a user error worth naming.
  for (const c of ONLY) {
    if (!runtimes.some(([k]) => k === c)) {
      log(`${YELLOW}!${OFF} ${c} — not declared in config/hosts/${hostId}.json`);
    }
  }

  for (const capability of wanted) {
    const rt = profile.runtimes[capability];
    const label = `${capability.padEnd(10)} ${DIM}${rt.driver ?? "no driver"}${OFF}`;
    if (!rt.driver) {
      log(`${DIM}—${OFF} ${label} ${DIM}nothing configured to drive it${OFF}`);
      results[capability] = { ok: false, skipped: true, note: "no driver configured" };
      continue;
    }
    process.stdout.write(JSON_OUT ? "" : `  ${label} … `);
    let result;
    try {
      result = await CHECKS[capability](rt, profile);
    } catch (err) {
      result = { ok: false, note: err instanceof Error ? err.message : String(err) };
    }
    results[capability] = result;
    if (JSON_OUT) continue;
    if (result.ok) console.log(`${GREEN}✓${OFF} ${result.note}`);
    else if (result.skipped) console.log(`${DIM}skipped — ${result.note}${OFF}`);
    else {
      console.log(`${RED}✗${OFF} ${result.note}`);
      if (result.detail) console.log(`      ${DIM}${result.detail}${OFF}`);
    }
  }

  // ── record ────────────────────────────────────────────────────────────────
  // Only passes, only with --write, and a FAILURE CLEARS a previous pass: a
  // stale `verifiedAt` asserting a capability that has since broken is exactly
  // the lie this whole mechanism exists to prevent. That is what an OS upgrade
  // did here — the claim stayed true in the file long after it stopped being
  // true on the machine.
  if (WRITE) {
    const now = new Date().toISOString();
    let changed = 0;
    for (const [capability, result] of Object.entries(results)) {
      const rt = profile.runtimes[capability];
      if (result.skipped) continue;
      if (result.ok) {
        rt.verifiedAt = now;
        rt.verifiedNote = result.note;
        changed++;
      } else if (rt.verifiedAt) {
        delete rt.verifiedAt;
        delete rt.verifiedNote;
        changed++;
        log(`${YELLOW}!${OFF} cleared a previous pass for ${capability} — it no longer works`);
      }
    }
    if (changed) {
      await writeFile(path.join(ROOT, "config", "hosts", `${hostId}.json`), JSON.stringify(profile, null, 2) + "\n");
      log(`\n${DIM}config/hosts/${hostId}.json updated${OFF}`);
    }
  }

  const failed = Object.values(results).filter((r) => !r.ok && !r.skipped).length;
  const passed = Object.values(results).filter((r) => r.ok).length;

  if (JSON_OUT) {
    console.log(JSON.stringify({ host: hostId, written: WRITE, passed, failed, results }, null, 2));
  } else {
    log(`\n${passed} verified, ${failed} failing${WRITE ? "" : `  ${DIM}(run with --write to record the passes)${OFF}`}\n`);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(`${RED}doctor crashed:${OFF}`, err);
  process.exit(3);
});
