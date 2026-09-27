#!/usr/bin/env node
/**
 * An MCP server that hands a coding agent this box's local AI stack.
 *
 * Claude Code and Codex both spawn it over stdio and get the same tools: run the
 * services, see what the GPU is holding, and use the things they cannot do
 * themselves — speak in a cloned voice, generate an image or a piece of music,
 * transcribe audio.
 *
 * Why tools and not a page in the console. A page explaining how to start
 * services is documentation a human reads and relays, which is the job MCP
 * exists to delete — and it would be a second copy of service-commands.json,
 * free to drift from the first. `tools/list` is the guide, delivered to the
 * agent itself, current by construction. The descriptions below are therefore
 * the real interface, and several of them spend most of their words on when NOT
 * to reach for the tool.
 *
 * Why stdio and not an /api/mcp route on the console. Two reasons, and the
 * second is the one that settles it:
 *   - An agent asked to "start the services" is most useful when nothing is
 *     running, and that includes the console. An HTTP route is dead exactly when
 *     it is needed.
 *   - The console deploys to Vercel. An /api/mcp route ships with it and becomes
 *     a remote endpoint reaching for localhost — the cloud-routing hazard this
 *     stack is deliberately built to avoid, reintroduced in a new place.
 *
 * WHAT TALKS TO WHAT, and why it differs per tool:
 *   - Service control → the manager on :8099. It runs every start through
 *     ResourceCoordinator and answers 409 when a model will not fit, so an agent
 *     physically cannot fill the card. That admission check is the only reason
 *     exposing start/stop to an agent is reasonable at all.
 *   - speak → the speech SERVICE directly. The console's /api/tts follows `tts`
 *     routing, which can legitimately point at Kokoro, whose voices are baked
 *     into its weights and will never include yours.
 *   - generate_image, generate_music, transcribe → the CONSOLE's API. Those sit on real logic
 *     (image-gen.ts alone acquires its own resource lease), and reimplementing
 *     it here would both duplicate it and route around the guardrail.
 *
 * No dependencies. MCP is JSON-RPC 2.0 over stdio and the handful of methods
 * needed here are small enough that adding the SDK to a Next.js app's
 * package.json would cost more than it saves.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MANAGER = process.env.MANAGER_URL ?? "http://localhost:8099";
const CONSOLE = process.env.CONSOLE_URL ?? "http://localhost:8003";
/** Long enough for a cold model load; the first call after a reboot pays it. */
const START_TIMEOUT_MS = 120_000;
const MAX_SPEAK_CHARS = 600;

// stderr only: stdout is the protocol channel, and a stray console.log there
// corrupts the JSON-RPC stream.
const log = (...a) => console.error("[mcp-betenshi]", ...a);

const ok = (text) => ({ text });
const fail = (error) => ({ error });

function hostProfile() {
  const known = new Set(["betenshi", "b5"]);
  const env = (process.env.HOST_ID || "").trim().toLowerCase();
  const host = os.hostname().trim().toLowerCase().replace(/\.local$/, "");
  const id = known.has(env) ? env : known.has(host) ? host : process.platform === "darwin" ? "b5" : "betenshi";
  return JSON.parse(fs.readFileSync(path.join(HERE, "..", "config", "hosts", `${id}.json`), "utf8"));
}

async function managerFetch(p, init, timeoutMs = 15_000) {
  try {
    const res = await fetch(`${MANAGER}${p}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const body = await res.json().catch(() => ({}));
    return { res, body };
  } catch (e) {
    return { error: `The service manager on ${MANAGER} did not answer (${e.message}). It runs as "node scripts/manager.cjs" in the console repo.` };
  }
}

async function consoleFetch(p, init, timeoutMs = 300_000) {
  try {
    const res = await fetch(`${CONSOLE}${p}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    return { res };
  } catch (e) {
    return { error: `The console on ${CONSOLE} did not answer (${e.message}). This tool needs it running — "npm run dev" in the console repo.` };
  }
}

// ── services ──────────────────────────────────────────────────────────────────

async function listServices() {
  const { error, body } = await managerFetch("/services");
  if (error) return fail(error);
  if (!Array.isArray(body)) return fail("The manager returned something unexpected.");

  // What each service SERVES comes from the host profile, not the manager — an
  // agent deciding which one to start cares about the capability, not the name.
  const serves = new Map(hostProfile().services.map((s) => [s.id, s.serves ?? {}]));
  const rows = body.map((s) => {
    const caps = Object.keys(serves.get(s.id) ?? {});
    const state = s.healthy ? "running" : s.status === "running" ? "running (unhealthy)" : s.status;
    const extra = [
      caps.length ? `serves ${caps.join("/")}` : null,
      s.owner === "external" ? "started outside the manager" : null,
      s.error ? `error: ${String(s.error).slice(0, 80)}` : null,
    ].filter(Boolean);
    return `${s.id.padEnd(12)} ${state.padEnd(20)} :${s.port}${extra.length ? `  — ${extra.join("; ")}` : ""}`;
  });
  return ok(rows.join("\n"));
}

/**
 * Reject an id this host has never heard of, before it reaches the manager.
 *
 * The manager runs its resource check FIRST, so `start nope` came back as
 * "Cannot start nope: RAM needs 0 GB more…" — a resource failure for a service
 * that does not exist. And `stop nope` answered "ok", so a typo reported
 * success. Neither is the manager's bug to fix: it is answering about a
 * workload, and this is the layer that knows the name was never valid.
 */
function unknownService(id) {
  const ids = hostProfile().services.map((s) => s.id);
  if (ids.includes(id)) return null;
  return `No service called "${id}" on this host. Known: ${ids.join(", ")}.`;
}

async function startService({ id }) {
  if (!id) return fail("Which service? Use list_services for ids.");
  const bad = unknownService(id);
  if (bad) return fail(bad);
  const { error, res, body } = await managerFetch(`/services/${encodeURIComponent(id)}/start`, { method: "POST" });
  if (error) return fail(error);
  if (res.status === 409) {
    // The admission check refused. This is the interesting failure: report the
    // reason verbatim rather than flattening it to "could not start".
    return fail(`Not enough room to start "${id}": ${body.error ?? "resource limit"}. Stop something first — gpu_status shows what is holding memory.`);
  }
  if (!res.ok) return fail(body.error ?? `Could not start "${id}" (${res.status}).`);
  return ok(`Starting ${id}${body.pid ? ` (pid ${body.pid})` : ""}. Large models take a minute to load; list_services shows when it is healthy.`);
}

async function stopService({ id }) {
  if (!id) return fail("Which service? Use list_services for ids.");
  const bad = unknownService(id);
  if (bad) return fail(bad);
  const { error, res, body } = await managerFetch(`/services/${encodeURIComponent(id)}/stop`, { method: "POST" });
  if (error) return fail(error);
  if (!res.ok) return fail(body.error ?? `Could not stop "${id}" (${res.status}).`);
  return ok(`Stopped ${id}.`);
}

async function serviceLogs({ id, tail }) {
  if (!id) return fail("Which service? Use list_services for ids.");
  const bad = unknownService(id);
  if (bad) return fail(bad);
  const n = Math.min(Math.max(parseInt(tail ?? 50, 10) || 50, 1), 200);
  const { error, res, body } = await managerFetch(`/services/${encodeURIComponent(id)}/logs?tail=${n}`);
  if (error) return fail(error);
  if (!res.ok) return fail(body.error ?? `No logs for "${id}" (${res.status}).`);
  const lines = body.logs ?? [];
  if (!lines.length) return ok(`No output captured for "${id}". It may not have been started from the manager.`);
  return ok(lines.join("\n"));
}

async function gpuStatus() {
  const { error, body } = await managerFetch("/resources");
  if (error) return fail(error);
  const cap = body.capacity ?? {};
  const lines = [
    `VRAM  ${(cap.vram?.freeGb ?? 0).toFixed(1)} GB free of ${(cap.vram?.totalGb ?? 0).toFixed(1)} GB`,
    `RAM   ${(cap.ram?.freeGb ?? 0).toFixed(1)} GB free of ${(cap.ram?.totalGb ?? 0).toFixed(1)} GB`,
  ];

  // `activeServices` is a list of ids — plain strings. The manager does not
  // attribute memory per service, so this does not invent a number for each;
  // what it can say precisely is which GPU slots are LEASED right now, which is
  // the thing that actually blocks a start.
  const active = body.activeServices ?? [];
  if (active.length) lines.push("", `Running: ${active.join(", ")}`);

  const leases = body.leases ?? [];
  if (leases.length) {
    lines.push("", "Holding a GPU slot:");
    for (const l of leases) {
      lines.push(`  ${String(l.workload ?? "?").padEnd(18)} ${l.slot ?? ""}${l.owner ? `  (${l.owner})` : ""}`);
    }
  }
  if (body.queue?.length) lines.push("", `${body.queue.length} workload(s) waiting for room.`);
  return ok(lines.join("\n"));
}

// ── voice ─────────────────────────────────────────────────────────────────────

function ttsServices() {
  return hostProfile().services.filter((s) => s.serves?.tts);
}

async function voicesOf(svc, timeoutMs = 2500) {
  try {
    const res = await fetch(`${svc.localUrl}/v1/audio/voices`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * The service holding `wanted` — or, with no name given, any service that can
 * clone at all. Asked of each engine rather than resolved from config, because
 * only the running process knows which clips it holds.
 */
async function findEngine(wanted) {
  const services = ttsServices();
  const seen = [];
  for (const svc of services) {
    const payload = await voicesOf(svc);
    if (!payload) continue;
    const voices = Array.isArray(payload.voices) ? payload.voices : [];
    seen.push({ svc, voices, canClone: payload.can_clone === true });
    if (wanted) {
      if (voices.some((v) => v.id === wanted)) return { svc, voice: wanted };
    } else {
      const clone = voices.find((v) => v.clone);
      if (clone) return { svc, voice: clone.id };
    }
  }
  if (!seen.length) {
    const down = services.map((s) => `${s.name} (${s.id})`).join(", ");
    return { error: `No speech engine answered. Try start_service on one of: ${down || "none configured"}.` };
  }
  const known = seen.flatMap((s) => s.voices.filter((v) => v.clone).map((v) => v.id));
  if (wanted) {
    return {
      error: known.length
        ? `No voice called "${wanted}". Enrolled: ${known.join(", ")}.`
        : `No voice called "${wanted}", and no cloned voices are enrolled. Record one in the console's Speech tab.`,
    };
  }
  return { error: "No cloned voices are enrolled yet. Record one in the console's Speech tab (Text → speech → Clone a voice)." };
}

/** Bring a speech engine up if none is answering, and wait for it. */
async function ensureSpeech() {
  const services = ttsServices();
  for (const svc of services) if (await voicesOf(svc, 1200)) return { ok: true };
  for (const svc of services) {
    const { res } = await managerFetch(`/services/${svc.id}/start`, { method: "POST" }, 10_000);
    if (!res?.ok) continue;
    log(`starting ${svc.id}…`);
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      if (await voicesOf(svc, 1500)) return { ok: true };
    }
  }
  return { ok: false };
}

function play(file) {
  return new Promise((resolve) => {
    // ffplay ships with the ffmpeg build already on this box, reads wav
    // natively, and exits on its own with -autoexit.
    const p = spawn("ffplay", ["-nodisp", "-autoexit", "-loglevel", "quiet", file], {
      stdio: "ignore",
      windowsHide: true,
    });
    p.on("error", (e) => resolve(`Could not play audio: ${e.message}. Is ffplay on PATH?`));
    p.on("exit", () => resolve(null));
  });
}

async function speak({ text, voice }) {
  const say = String(text ?? "").trim();
  if (!say) return fail("Nothing to say.");
  if (say.length > MAX_SPEAK_CHARS) {
    return fail(`That is ${say.length} characters. Keep spoken asides under ${MAX_SPEAK_CHARS} — this is for a sentence or two, not a document.`);
  }

  if (!(await ensureSpeech()).ok) {
    return fail("No speech engine is running and it could not be started. Check gpu_status, then start_service.");
  }
  const found = await findEngine(voice);
  if (found.error) return fail(found.error);

  const started = Date.now();
  let res;
  try {
    res = await fetch(`${found.svc.localUrl}/v1/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: say, voice: found.voice }),
      signal: AbortSignal.timeout(180_000),
    });
  } catch (e) {
    return fail(`${found.svc.name} did not answer: ${e.message}`);
  }
  if (!res.ok) {
    return fail(`${found.svc.name} returned ${res.status}. ${(await res.text().catch(() => "")).slice(0, 200)}`);
  }

  const file = path.join(os.tmpdir(), `mcp-voice-${Date.now()}.wav`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  const failure = await play(file);
  fs.rmSync(file, { force: true });
  if (failure) return fail(failure);
  return ok(`Spoke ${say.length} characters as "${found.voice}" in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
}

async function listVoices() {
  const lines = [];
  for (const svc of ttsServices()) {
    const payload = await voicesOf(svc);
    if (!payload) {
      lines.push(`${svc.name}: not running`);
      continue;
    }
    const clones = (payload.voices ?? []).filter((v) => v.clone);
    lines.push(
      `${svc.name}: ${clones.length ? clones.map((v) => v.id).join(", ") : "no cloned voices"}` +
        (payload.can_clone ? "" : " (cannot clone — fixed voices)"),
    );
  }
  return ok(lines.join("\n") || "No speech services on this host.");
}

// ── the things an agent cannot do itself ──────────────────────────────────────

async function transcribe({ file }) {
  if (!file) return fail("Which file? Pass an absolute path to an audio file.");
  if (!fs.existsSync(file)) return fail(`No such file: ${file}`);

  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(file)]), path.basename(file));
  const { error, res } = await consoleFetch("/api/stt", { method: "POST", body: form });
  if (error) return fail(error);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return fail(body.error ?? `Transcription failed (${res.status}).`);
  if (!body.text?.trim()) return ok(`No speech detected in ${path.basename(file)}.`);
  return ok(`${body.text.trim()}\n\n— ${body.model} in ${body.latency}ms`);
}

async function generateImage({ prompt, model, folder }) {
  if (!prompt?.trim()) return fail("What should it draw? Pass a prompt.");
  const { error, res } = await consoleFetch("/api/image/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: prompt.trim(), ...(model ? { model } : {}), ...(folder ? { folder } : {}) }),
  });
  if (error) return fail(error);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (body.resourceBlocked) {
      return fail(`Not enough room to generate: ${body.error}. gpu_status shows what is holding memory.`);
    }
    return fail(body.error ?? `Image generation failed (${res.status}).`);
  }
  // The path, never the base64. The console has already saved it to the
  // gallery, and an agent can read a file — a megabyte of data URL in the
  // transcript helps nobody.
  return ok(
    body.savedPath
      ? `Saved to ${body.savedPath} — ${body.model}, ${(body.bytes / 1024).toFixed(0)} KB in ${(body.latency / 1000).toFixed(1)}s.`
      : `Generated with ${body.model} in ${(body.latency / 1000).toFixed(1)}s, but the console did not report a saved path.`,
  );
}

// ── process lab ─────────────────────────────────────────────────────────────

async function processLab({ action = "status", caseKey, run, scenarios, secondsPerDay, autoHuman }) {
  const call = async (path, init) => {
    const { error, res } = await consoleFetch(`/api/labs/process/${path}`, init, 120_000);
    if (error) return { error };
    const body = await res.json().catch(() => ({}));
    return res.ok ? { body } : { error: body.error ?? `HTTP ${res.status}` };
  };
  if (action === "status") {
    const { error, body } = await call("status");
    if (error) return fail(error);
    const lines = body.services.map((s) => `${s.up ? "up  " : "down"} ${s.id} — ${s.role}`);
    return ok(`${lines.join("\n")}\nStart a stopped one with start_service(id); the lab needs process-engine and process-lab.`);
  }
  if (action === "cases") {
    const { error, body } = await call(`api/cases?limit=40${run ? `&run=${encodeURIComponent(run)}` : ""}`);
    if (error) return fail(error);
    if (!body.length) return ok("No cases yet.");
    return ok(body.map((c) => `${c.caseKey} ${c.clientName ?? ""} → ${c.destination ?? "?"} · ${c.service ?? "service unknown"} · ${c.state === "ACTIVE" ? `at ${c.current.join(", ")}` : c.outcome}${c.incidents ? " · INCIDENT" : ""}`).join("\n"));
  }
  if (action === "case") {
    if (!caseKey) return fail("Pass caseKey (from action cases).");
    const { error, body } = await call(`api/cases/${encodeURIComponent(caseKey)}`);
    if (error) return fail(error);
    const d = body.decisions.map((x) => `[${x.kind}] ${x.question} → ${x.decided}${x.confidence != null ? ` (${Number(x.confidence).toFixed(2)})` : ""}${x.model ? ` by ${x.model}` : ""}${x.provider === "cloud" ? " (cloud)" : ""}${x.escalated ? " → person" : ""}${x.overridden ? " OVERRIDDEN" : ""}`);
    return ok(`${body.caseKey}: ${body.state === "ACTIVE" ? `at ${body.current.join(", ")}` : body.outcome}\n${d.join("\n")}`);
  }
  if (action === "simulate") {
    const { error, body } = await call("api/sim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenarios, secondsPerDay, autoHuman }),
    });
    if (error) return fail(error);
    return ok(`Started ${body.id}: ${body.config.scenarios.length} synthetic cases at ${body.config.secondsPerDay} s per simulated day. Follow it with action "cases" (run ${body.id}) and "stats".`);
  }
  if (action === "stats") {
    const { error, body } = await call(`api/stats${run ? `?run=${encodeURIComponent(run)}` : ""}`);
    if (error) return fail(error);
    const kinds = Object.entries(body.byKind).map(([k, v]) => `${k}: ${v.count}, median ${v.medianLatencyMs ?? "?"} ms${v.accuracy != null ? `, ${v.accuracy}% vs truth` : ""}${v.cloud ? `, ${v.cloud} on cloud` : ""}`);
    return ok(
      `${body.finished}/${body.cases} finished · outcomes ${JSON.stringify(body.outcomes)} · right ending ${body.pathAccuracy?.pct ?? "?"}% · ` +
        `median cycle ${body.cycle.medianDays} simulated days · AI→person ${body.escalation.pct ?? "?"}% · person overrode AI ${body.overrides.pct ?? "?"}% · ` +
        `cloud $${body.models.costUsd}\n${kinds.join("\n")}`,
    );
  }
  return fail(`Unknown action "${action}".`);
}

async function generateMusic({ prompt, lyrics, seconds, seed, bpm, fade_out }) {
  if (!prompt?.trim()) return fail("Describe the music: genre, instruments, mood, tempo.");
  const dur = Math.round(Number(seconds) || 30);
  if (dur < 10 || dur > 600) return fail("seconds must be between 10 and 600.");
  // Through the Music Lab's run route, like generate_image through the
  // console: it holds the GPU lease, saves to the gallery and records the run.
  const f = new FormData();
  f.set("task", "text2music");
  f.set("caption", prompt.trim());
  f.set("instrumental", String(!lyrics?.trim()));
  if (lyrics?.trim()) f.set("lyrics", lyrics);
  f.set("duration", String(dur));
  if (Number.isInteger(seed) && seed >= 0) f.set("seed", String(seed));
  if (bpm) f.set("bpm", String(bpm));
  if (Number(fade_out) > 0) f.set("fade_out", String(fade_out));
  f.set("format", "flac");
  const { error, res } = await consoleFetch("/api/labs/music/run", { method: "POST", body: f }, 900_000);
  if (error) return fail(error);
  const body = await res.json().catch(() => ({}));
  if (!body.ok) {
    if (body.resourceBlocked) return fail(`Not enough room to generate: ${body.error}. gpu_status shows what is holding memory.`);
    if (/isn't reachable|not ready|loading/i.test(body.error ?? "")) return fail(`${body.error} start_service("music") starts it (~30 s to load).`);
    return fail(body.error ?? `Music generation failed (${res.status}).`);
  }
  const t = body.output.track;
  const dir = process.env.MUSIC_OUTPUT_DIR || path.join(HERE, "..", "generated-music");
  const r = t.meta.resolved ?? {};
  return ok(
    `Saved to ${path.join(dir, t.file)} — ${t.meta.audio_seconds}s FLAC (48 kHz stereo), seed ${t.meta.seed}` +
      `${r.bpm ? `, ${r.bpm} bpm` : ""}${r.keyscale ? `, ${r.keyscale}` : ""}, in ${(body.latencyMs / 1000).toFixed(1)}s.`,
  );
}

async function decideTool({ question, choices, type, context, model }) {
  if (!question?.trim()) return fail("Pass the question to decide.");
  const { error, res } = await consoleFetch("/api/decide", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Source": "mcp-decide" },
    body: JSON.stringify({ question, choices, type, context, ...(model ? { model } : {}) }),
  });
  if (error) return fail(error);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 503) return fail(`${body.error ?? "The decision service is not running."} start_service("laya") starts it.`);
    return fail(body.error ?? `Decision failed (${res.status}).`);
  }
  // The whole distribution, not just the winner: the point of asking a
  // calibrated model is to act differently at 0.55 than at 0.98.
  const dist = Object.entries(body.probabilities)
    .sort((a, b) => b[1] - a[1])
    .map(([k, p]) => `${k} ${(p * 100).toFixed(1)}%`)
    .join(", ");
  const how = [body.model, body.checkpoint && `checkpoint ${body.checkpoint}`, `${Math.round(body.latencyMs)} ms`, body.costUsd != null && `$${body.costUsd.toFixed(5)}`]
    .filter(Boolean)
    .join(", ");
  return ok(`${body.choice} (${(body.confidence * 100).toFixed(1)}%). Distribution: ${dist}. [${how}]${body.parsed === false ? " Warning: the LLM did not return the requested JSON; the distribution is a fallback." : ""}`);
}

// ── tool table ────────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "list_services",
    description:
      "Every local AI service on this machine: whether it is running and healthy, its port, and which capability it serves (text/vision/image/stt/tts). Start here before starting or stopping anything.",
    inputSchema: { type: "object", properties: {} },
    run: listServices,
  },
  {
    name: "start_service",
    description:
      "Start a local service by id. Large models take up to a minute to load and hold their memory for as long as they run, so start what the task needs and no more. If there is not enough room this refuses with the reason rather than thrashing the GPU.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Service id from list_services." } },
      required: ["id"],
    },
    run: startService,
  },
  {
    name: "stop_service",
    description:
      "Stop a local service and release its memory. Worth doing when a model is finished with and something larger needs the card — but check with the user first if they might still be using it.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Service id from list_services." } },
      required: ["id"],
    },
    run: stopService,
  },
  {
    name: "service_logs",
    description:
      "The tail of a service's output. This is the tool for diagnosing a service that started but is not healthy, or that died on startup.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Service id from list_services." },
        tail: { type: "number", description: "How many lines, 1-200. Default 50." },
      },
      required: ["id"],
    },
    run: serviceLogs,
  },
  {
    name: "gpu_status",
    description:
      "Free and total VRAM and RAM, and which services are holding them. Check this before starting a large model, and when a start is refused for lack of room.",
    inputSchema: { type: "object", properties: {} },
    run: gpuStatus,
  },
  {
    name: "speak",
    description:
      "Say something out loud on this machine, in a voice cloned from the user's own recording. " +
      "Use it sparingly and at moments that earn it: a long job finished while they were away, " +
      "something needs their decision, or they asked you to tell them out loud. " +
      "Do not narrate your work, do not speak every reply, and do not use it for anything long — " +
      "it plays through the speakers, so one or two sentences is the whole budget. " +
      "Blocks until playback finishes. The user's enrolled voice is the default.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "What to say. One or two sentences." },
        voice: { type: "string", description: "Voice id from list_voices. Omit for the user's own cloned voice." },
      },
      required: ["text"],
    },
    run: speak,
  },
  {
    name: "list_voices",
    description: "The cloned voices enrolled on this machine, and which speech engines are running.",
    inputSchema: { type: "object", properties: {} },
    run: listVoices,
  },
  {
    name: "transcribe",
    description:
      "Transcribe an audio file on this machine with the local speech-to-text model. Use it for audio you cannot otherwise read — a recording, a voice memo, the audio of a screen capture. Audio never leaves the box.",
    inputSchema: {
      type: "object",
      properties: { file: { type: "string", description: "Absolute path to an audio file (mp3, wav, m4a, ogg, webm)." } },
      required: ["file"],
    },
    run: transcribe,
  },
  {
    name: "generate_image",
    description:
      "Generate an image with a local diffusion model and save it to the console's gallery, returning the path. " +
      "This is the user's own GPU, and a generation costs real time and power — use it when an image is the deliverable " +
      "or the user asked for one, not to illustrate an explanation. Takes tens of seconds.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "What to draw." },
        model: {
          type: "string",
          description:
            'Local model. Measured on this box (docs/image-model-experiment-2026-09-26.md): "flux2-klein-4b" is fastest ' +
            '(~10 s) and good at layout; "z-image-turbo" (~14 s) is the one to use for rendered text, Arabic text or exact ' +
            'small counts; "hidream-o1-dev" is native 2K but English prompts only (it ignored an Arabic prompt). ' +
            'Omitting it means Qwen-Image, which needs ~28 GB of free host RAM and several minutes to load, and is often ' +
            'refused while other models are resident. Do not use "flux-schnell": it needs the whole card.',
        },
        folder: { type: "string", description: "Gallery folder to save into." },
      },
      required: ["prompt"],
    },
    run: generateImage,
  },
  {
    name: "generate_music",
    description:
      "Generate a piece of music locally with ACE-Step 1.5 and save it to the console's music gallery, returning the " +
      "file path (FLAC). Use it when a track is the deliverable, e.g. a background bed for a video you are assembling: " +
      "describe genre, instruments, mood and tempo, and ask for the length the edit needs. Instrumental unless you pass " +
      "lyrics. Measured on this box: ~15 s for 30 s of audio, ~20 s for a minute, ~42 s for three. Do NOT use it to illustrate an answer, for " +
      "sound effects or speech (use speak for a voice), or when the user needs a specific existing song. The weights " +
      "are MIT-licensed, but a generated track can still resemble existing music; say it was AI-generated where that " +
      "matters. Needs the music service running (start_service(\"music\")).",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Genre, instruments, mood, tempo — e.g. \"calm cinematic strings and piano, slow build, 70 bpm\"." },
        seconds: { type: "number", description: "Length in seconds, 10-600. Default 30." },
        lyrics: { type: "string", description: "Optional sung lyrics, with [verse]/[chorus] section tags. Omit for instrumental." },
        seed: { type: "integer", description: "Fix it to reproduce a track." },
        bpm: { type: "integer", description: "Tempo, if the edit needs it exact. Otherwise the planner picks one." },
        fade_out: { type: "number", description: "Seconds to fade to silence at the end — usually wanted for a video bed (e.g. 2)." },
      },
      required: ["prompt"],
    },
    run: generateMusic,
  },
  {
    name: "process_lab",
    description:
      "The process lab: a SIMULATED relocation agency whose cases run on a BPMN engine (Operaton), with DMN rules " +
      "and AI at the judgement steps. Actions: status (its services), cases (list, optionally for one simulation run), " +
      "case (one case's full decision history: which kind of decision, what it decided, confidence, model, whether a " +
      "person overrode it), simulate (start a run of synthetic clients), stats (cycle time, hand-offs, overrides, cost). " +
      "Use it to study how rules, a decision model and an LLM share work in a process. Do NOT use it for real clients or " +
      "real immigration advice — every case and document is synthetic — and do not start a simulation to answer a " +
      "question the existing runs already answer: a run costs GPU time or cloud money.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["status", "cases", "case", "simulate", "stats"] },
        caseKey: { type: "string", description: "For action case." },
        run: { type: "string", description: "A simulation run id, e.g. SIM2609271637 (cases, stats)." },
        scenarios: { type: "array", items: { type: "string" }, description: "simulate: scenario ids; omit for all." },
        secondsPerDay: { type: "number", description: "simulate: wall-clock seconds per simulated day (default 10)." },
        autoHuman: { type: "boolean", description: "simulate: a simulated consultant works the inbox (default true)." },
      },
      required: ["action"],
    },
    run: processLab,
  },
  {
    name: "decide",
    description:
      "Answer one typed question about a piece of text with calibrated probabilities, using Laya, a local " +
      "decision model (~30 ms, nothing leaves the box): pick one of a few labels, yes/no, or a low-to-high score. " +
      "It is good at coarse, vocabulary-level calls (topic, language, 'is this about billing') and weak at judgement: " +
      "on this box's six labelled decision sets (triage, moderation, routing, relevance, intent, Arabic dialect) it " +
      "scored 17-65% where Claude Haiku scored 83-100% — see docs/decision-model-experiment-2026-09-27.md. " +
      "Do NOT use it when you can simply read the text and decide yourself, for anything that needs reading between " +
      "the lines, world knowledge or arithmetic, for open-ended questions, or for more than ~20 options. " +
      "The same tool asks an LLM in the same shape: pass model \"local-small\" (a resident 7B, ~0.2 s, free) or " +
      "\"claude-haiku\" (~1 s, metered) — usually the better choice for a real decision.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question, e.g. \"Is this post spam?\"" },
        choices: {
          description: "The options: a list of labels, or an object of label → what the label means (descriptions help). Omit for yesno.",
          oneOf: [{ type: "array", items: { type: "string" } }, { type: "object", additionalProperties: { type: "string" } }],
        },
        type: { type: "string", enum: ["choice", "yesno", "score"], description: "Default choice. score: choices ordered low → high." },
        context: { description: "The text (or a JSON object) the decision is about.", oneOf: [{ type: "string" }, { type: "object" }] },
        model: { type: "string", description: "Default \"laya\". Also laya-multilingual, laya-typed-decisions, or a router chat alias." },
      },
      required: ["question", "context"],
    },
    run: decideTool,
  },
];

// ── JSON-RPC over stdio ───────────────────────────────────────────────────────

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });

async function handle(msg) {
  const { id, method, params } = msg;
  // Notifications have no id and take no response.
  if (id === undefined || id === null) return;

  switch (method) {
    case "initialize":
      return reply(id, {
        // Echo the client's version rather than pinning one: this server's
        // surface is stable across the revisions that differ elsewhere.
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "betenshi", version: "2.0.0" },
      });

    case "tools/list":
      return reply(id, { tools: TOOLS.map(({ run, ...t }) => t) });

    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) {
        return reply(id, { content: [{ type: "text", text: `Unknown tool "${params?.name}".` }], isError: true });
      }
      try {
        const out = await tool.run(params?.arguments ?? {});
        return reply(id, { content: [{ type: "text", text: out.error ?? out.text }], isError: !!out.error });
      } catch (e) {
        return reply(id, { content: [{ type: "text", text: String(e) }], isError: true });
      }
    }

    case "ping":
      return reply(id, {});

    default:
      return send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method "${method}"` } });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  // Messages are newline-delimited JSON; a partial line waits for the rest.
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      log("ignored unparseable line");
      continue;
    }
    handle(msg).catch((e) => log("handler failed:", e));
  }
});
process.stdin.on("end", () => process.exit(0));
log(`ready — ${TOOLS.length} tools`);
