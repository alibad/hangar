#!/usr/bin/env node
/**
 * An MCP server that lets Claude Code speak out loud, in a voice cloned on this
 * box.
 *
 * Claude Code spawns this over stdio and gets two tools: `speak` and
 * `list_voices`. Everything it needs already exists — the Chatterbox service
 * holds the reference clips and ffmpeg ships ffplay — so this file is only the
 * wiring between them.
 *
 * It talks to the SPEECH SERVICE directly rather than to the console's
 * /api/tts, for two reasons. The console's dev server is not always running,
 * and /api/tts follows the `tts` routing, which can legitimately point at Kokoro
 * — whose voices are baked in and will never include yours. "Speak as me" has to
 * find the engine that actually holds the clip, so that is what it looks for.
 *
 * No dependencies. MCP is JSON-RPC 2.0 over stdio and the three methods needed
 * here are small enough that pulling the SDK into a Next.js app's package.json
 * would cost more than it saves.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MANAGER = process.env.MANAGER_URL ?? "http://localhost:8099";
/** Long enough for a cold model load; the first call after a reboot pays it. */
const START_TIMEOUT_MS = 120_000;
const MAX_CHARS = 600;

// stderr only: stdout is the protocol channel, and a stray console.log there
// corrupts the JSON-RPC stream.
const log = (...a) => console.error("[mcp-voice]", ...a);

function hostProfile() {
  const known = new Set(["betenshi", "b5"]);
  const env = (process.env.HOST_ID || "").trim().toLowerCase();
  const host = os.hostname().trim().toLowerCase().replace(/\.local$/, "");
  const id = known.has(env) ? env : known.has(host) ? host : process.platform === "darwin" ? "b5" : "betenshi";
  return JSON.parse(fs.readFileSync(path.join(HERE, "..", "config", "hosts", `${id}.json`), "utf8"));
}

/** Every local service that claims to do text-to-speech, in profile order. */
function ttsServices() {
  return hostProfile().services.filter((s) => s.serves?.tts);
}

async function voicesOf(svc, timeoutMs = 2500) {
  try {
    const res = await fetch(`${svc.localUrl}/v1/audio/voices`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * The service holding `wanted` — or, with no name given, any service that can
 * clone at all. Asked of each engine rather than resolved from config, for the
 * same reason the console asks: only the running process knows what it holds.
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
      if (voices.some((v) => v.id === wanted)) return { svc, voices, voice: wanted };
    } else {
      const clone = voices.find((v) => v.clone);
      if (clone) return { svc, voices, voice: clone.id };
    }
  }

  // Nothing matched. Say which of the two reasons it was.
  const cloning = seen.filter((s) => s.canClone);
  if (!seen.length) {
    const down = services.map((s) => `${s.name} (${s.localUrl})`).join(", ");
    return { error: `No speech engine answered. Not running: ${down || "none configured"}.` };
  }
  if (wanted) {
    const known = cloning.flatMap((s) => s.voices.filter((v) => v.clone).map((v) => v.id));
    return {
      error: known.length
        ? `No voice called "${wanted}". Enrolled: ${known.join(", ")}.`
        : `No voice called "${wanted}", and no cloned voices are enrolled yet. Record one in the console's Speech tab.`,
    };
  }
  return {
    error: "No cloned voices are enrolled yet. Record one in the console's Speech tab (Text → speech → Clone a voice).",
  };
}

/** Ask the service manager to bring an engine up, and wait for it to answer. */
async function ensureRunning() {
  const services = ttsServices();
  for (const svc of services) {
    if (await voicesOf(svc, 1200)) return { ok: true };
  }
  // None answered. Start the ones that can clone — identified by having been
  // started before, so we just try each and let the manager say what it knows.
  for (const svc of services) {
    try {
      const res = await fetch(`${MANAGER}/services/${svc.id}/start`, {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) continue;
      log(`starting ${svc.id}…`);
      const deadline = Date.now() + START_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        if (await voicesOf(svc, 1500)) return { ok: true, started: svc.name };
      }
    } catch {
      /* manager down or service unknown — fall through to the next */
    }
  }
  return { ok: false };
}

function play(file) {
  return new Promise((resolve) => {
    // ffplay ships with the ffmpeg build already on this box, handles wav
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
  if (!say) return { error: "Nothing to say." };
  if (say.length > MAX_CHARS) {
    return {
      error: `That is ${say.length} characters. Keep spoken asides under ${MAX_CHARS} — this is for a sentence or two, not a document.`,
    };
  }

  const up = await ensureRunning();
  if (!up.ok) {
    return { error: "No speech engine is running and it could not be started. Check the console's Services tab." };
  }

  const found = await findEngine(voice);
  if (found.error) return { error: found.error };

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
    return { error: `${found.svc.name} did not answer: ${e.message}` };
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return { error: `${found.svc.name} returned ${res.status}. ${detail.slice(0, 200)}` };
  }

  const file = path.join(os.tmpdir(), `mcp-voice-${Date.now()}.wav`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  const failure = await play(file);
  fs.rmSync(file, { force: true });
  if (failure) return { error: failure };

  return {
    text: `Spoke ${say.length} characters as "${found.voice}" in ${((Date.now() - started) / 1000).toFixed(1)}s.`,
  };
}

async function listVoices() {
  const services = ttsServices();
  const lines = [];
  for (const svc of services) {
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
  return { text: lines.join("\n") || "No speech services on this host." };
}

const TOOLS = [
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
        voice: {
          type: "string",
          description: "Voice id, from list_voices. Omit to use the user's own cloned voice.",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "list_voices",
    description: "The cloned voices enrolled on this machine, and which speech engines are running.",
    inputSchema: { type: "object", properties: {} },
  },
];

// ── JSON-RPC over stdio ───────────────────────────────────────────────────────

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

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
        serverInfo: { name: "betenshi-voice", version: "1.0.0" },
      });

    case "tools/list":
      return reply(id, { tools: TOOLS });

    case "tools/call": {
      const name = params?.name;
      const args = params?.arguments ?? {};
      const run = name === "speak" ? speak : name === "list_voices" ? listVoices : null;
      if (!run) {
        return reply(id, {
          content: [{ type: "text", text: `Unknown tool "${name}".` }],
          isError: true,
        });
      }
      try {
        const out = await run(args);
        return reply(id, {
          content: [{ type: "text", text: out.error ?? out.text }],
          isError: !!out.error,
        });
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
log("ready");
