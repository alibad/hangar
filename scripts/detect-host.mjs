/**
 * Probe THIS machine and print a draft host profile.
 *
 *   node scripts/detect-host.mjs            # human-readable + JSON
 *   node scripts/detect-host.mjs --json     # JSON only
 *
 * The mechanical half of setting up a new machine. Everything here is
 * MEASURED — hostname, platform, accelerator, memory model, and which of the
 * known ports actually answer — so that the judgment half (what to call a
 * service, which workstreams to offer, what the start commands are) is all a
 * human or an agent has left to do.
 *
 * It deliberately does not write any file. A profile is the thing the console
 * trusts about a machine; something that guessed one into place silently would
 * be worse than the fallback it replaced.
 */

import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import os from "node:os";
import { promisify } from "node:util";

const run = promisify(execFile);
const GB = (bytes) => Math.round((bytes / 1024 ** 3) * 10) / 10;

/** Ports this project knows how to serve, and what answers there. */
const KNOWN = [
  { port: 8099, id: "manager",     name: "Service Manager",  healthPath: "/services",      category: "monitoring" },
  { port: 11434, id: "ollama",     name: "Ollama",           healthPath: "/api/tags",      category: "ai", serves: { text: "" } },
  { port: 8005, id: "vllm",        name: "vLLM",             healthPath: "/health",        category: "ai", serves: { text: "" } },
  { port: 8006, id: "vllm-small",  name: "vLLM (small)",     healthPath: "/health",        category: "ai", serves: { text: "" } },
  { port: 8001, id: "whisper",     name: "Whisper STT",      healthPath: "/health",        category: "ai", serves: { stt: "whisper-1" } },
  { port: 8002, id: "tts",         name: "Kokoro TTS",       healthPath: "/health",        category: "ai", serves: { tts: "kokoro" } },
  { port: 8021, id: "qwen",        name: "Qwen-Image",       healthPath: "/health",        category: "ai", serves: { image: "qwen-image" } },
  // The Mac toolkit adapter (scripts/local-ai-adapter.mjs). Shares the `qwen`
  // id with the line above because Image Studio routes that id through its
  // established generate/gallery/queue/edit paths; only one of the two ports
  // is ever bound on a given machine. Omitting it is what made the detector
  // report "2 of 14 known ports" on a box that was serving five capabilities.
  { port: 8111, id: "qwen",        name: "Local AI Toolkit", healthPath: "/health",        category: "ai", localOnly: true, serves: { image: "", stt: "", tts: "" } },
  { port: 8188, id: "comfyui",     name: "ComfyUI",          healthPath: "/system_stats",  category: "app" },
  { port: 8009, id: "sam3d",       name: "SAM 3D Body",      healthPath: "/health",        category: "ai" },
  { port: 8010, id: "sam3",        name: "SAM 3",            healthPath: "/health",        category: "ai" },
  { port: 3001, id: "webui",       name: "Open WebUI",       healthPath: "/",              category: "app" },
  { port: 3002, id: "grafana",     name: "Grafana",          healthPath: "/api/health",    category: "monitoring" },
  { port: 9090, id: "prometheus",  name: "Prometheus",       healthPath: "/-/healthy",     category: "monitoring" },
  { port: 4000, id: "ai-router",   name: "AI Router",        healthPath: "/health/liveliness", category: "ai", localOnly: true },
];

/** Is anything listening? A TCP connect, because a health path may 404 and still be a live service. */
function listening(port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const sock = createConnection({ host: "127.0.0.1", port });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

async function probeHealth(port, path) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(2500) });
    return { status: res.status, ok: res.ok };
  } catch {
    return null;
  }
}

/** Which model names Ollama is actually serving, so `serves.text` is real. */
async function ollamaModels() {
  try {
    const res = await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(3000) });
    const d = await res.json();
    return (d.models ?? []).map((m) => ({
      name: m.name,
      bytes: m.size ?? 0,
      capabilities: m.capabilities ?? m.details?.capabilities ?? [],
      family: m.details?.family ?? "",
    }));
  } catch {
    return [];
  }
}

/**
 * The model a person would actually want to chat with.
 *
 * This used to be `models[0]` — whatever Ollama happened to list first, which
 * is by modification time. On B5 that drafted `qwen3-vl:32b-instruct`, a vision
 * model, as the machine's text default, while the 27B it actually chats with
 * sat fourth in the list. First-in-the-list is not a judgement about anything.
 *
 * Embedding models are excluded outright: they cannot hold a conversation, and
 * a box whose only model is an embedder should draft no text capability at all
 * rather than a broken one. Among the rest this prefers the largest, on the
 * theory that the big checkpoint is the one that was pulled on purpose.
 *
 * That is a GUESS and the detector says so, because no port scan can answer it.
 * Two models can both chat and differ in ways only a real call reveals: on this
 * machine `qwen3-vl:32b` and `qwen3-vl:32b-instruct` are the same weights and
 * the same size, and the first spends its whole token budget in `thinking` and
 * returns an empty string. That is what `node scripts/doctor.mjs text` is for —
 * the detector proposes, the doctor proves.
 */
function bestTextModel(models) {
  const chat = models.filter(
    (m) => !/embed/i.test(m.name) && !/embed/i.test(m.family) && !m.capabilities.includes("embedding"),
  );
  if (!chat.length) return null;
  return [...chat].sort((a, b) => b.bytes - a.bytes)[0].name;
}

async function detectGpu() {
  if (process.platform === "darwin") {
    // Apple silicon is the only Mac case that matters here: one pool, no VRAM.
    try {
      const { stdout } = await run("sysctl", ["-n", "machdep.cpu.brand_string"]);
      if (/Apple/i.test(stdout)) return { gpu: "apple", memoryKind: "unified" };
    } catch { /* fall through */ }
    return { gpu: "none", memoryKind: "unified" };
  }
  try {
    const { stdout } = await run("nvidia-smi",
      ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"]);
    const [name, vram] = stdout.trim().split("\n")[0].split(",").map((x) => x.trim());
    return { gpu: "nvidia", memoryKind: "discrete", gpuName: name, vramTotalGb: Math.round((Number(vram) / 1024) * 10) / 10 };
  } catch {
    return { gpu: "none", memoryKind: "discrete" };
  }
}

const machine = os.hostname();
const id = machine.toLowerCase().replace(/\.local$/, "").replace(/[^a-z0-9-]/g, "-");
const { gpu, memoryKind, gpuName, vramTotalGb } = await detectGpu();

// An open port is NOT evidence that the expected service is behind it. B5 had
// something listening on :8021 that answered no HTTP at all; drafting a
// Qwen-Image service from that would have put a service in the profile that
// does not exist, which is the exact failure the host profile is meant to end.
// Only ports that answer HTTP become services; the rest are reported for a
// human to identify.
const found = [];
const unidentified = [];
for (const svc of KNOWN) {
  if (!(await listening(svc.port))) continue;
  const health = await probeHealth(svc.port, svc.healthPath);
  if (health) found.push({ ...svc, health });
  else unidentified.push(svc);
}

const models = found.some((s) => s.id === "ollama") ? await ollamaModels() : [];

// ── Build the draft ─────────────────────────────────────────────────────────
const services = found.map((s) => {
  const entry = {
    id: s.id,
    name: s.name,
    localPort: s.port,
    localUrl: `http://localhost:${s.port}`,
    publicUrl: s.localOnly ? `http://127.0.0.1:${s.port}` : `https://${s.id}.\${PUBLIC_DOMAIN}`,
    healthPath: s.healthPath,
    category: s.category,
    authRequired: false,
  };
  if (s.localOnly) entry.localOnly = true;
  if (s.serves) {
    const serves = { ...s.serves };
    if (s.id === "ollama" && models.length) {
      const text = bestTextModel(models);
      if (text) serves.text = text;
      // A model that declares vision is worth naming separately: chatting with
      // a text-only model and asking it to look at a screenshot is a confusing
      // failure, and the profile is the only place that distinction can live.
      const vision = models.find((m) => m.capabilities.includes("vision") && !/thinking/i.test(m.name));
      if (vision) serves.vision = vision.name;
      const embed = models.find((m) => /embed/i.test(m.name));
      if (embed) serves.embedding = embed.name;
    }
    // Only keep capabilities we could name a real served-model for.
    for (const [k, v] of Object.entries(serves)) if (!v) delete serves[k];
    if (Object.keys(serves).length) entry.serves = serves;
    if (serves.text) entry.llm = { model: serves.text };
  }
  return entry;
});

const memory = memoryKind === "unified"
  ? { kind: "unified", totalGb: GB(os.totalmem()) }
  : { kind: "discrete", vramTotalGb: vramTotalGb ?? 0, ramTotalGb: GB(os.totalmem()) };

const profile = {
  _doc: `Host profile for ${machine}. Drafted by scripts/detect-host.mjs on ${new Date().toISOString().slice(0, 10)} from what was actually listening. Review before trusting it: ports were probed, INTENT was not.`,
  id,
  name: machine.replace(/\.local$/, ""),
  platform: process.platform,
  gpu,
  memory,
  logsDir: null,
  commandsFile: `service-commands.${id}.json`,
  services,
  workstreams: {},
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ ...profile, _unidentifiedPorts: unidentified.map((u) => u.port) }, null, 2));
} else {
  console.log(`machine      ${machine}   ->  profile id "${id}"`);
  console.log(`platform     ${process.platform}`);
  console.log(`accelerator  ${gpu}${gpuName ? ` (${gpuName})` : ""}`);
  console.log(`memory       ${memoryKind}${memoryKind === "unified" ? ` · ${memory.totalGb} GB one pool` : ` · ${memory.vramTotalGb} GB VRAM + ${memory.ramTotalGb} GB RAM`}`);
  console.log(`\nidentified (${found.length} of ${KNOWN.length} known ports):`);
  for (const s of found) {
    console.log(`  :${String(s.port).padEnd(5)} ${s.id.padEnd(12)} HTTP ${s.health.status}`);
  }
  if (unidentified.length) {
    console.log(`\nlistening but NOT identified — left out of the draft on purpose:`);
    for (const s of unidentified) {
      console.log(`  :${String(s.port).padEnd(5)} something is bound here, but ${s.healthPath} answered nothing.`);
      console.log(`         If it really is ${s.name}, add it by hand. An open port is not evidence.`);
    }
  }
  if (models.length) {
    console.log(`\nollama models: ${models.map((m) => m.name).join(", ")}`);
    const chat = models.filter((m) => !/embed/i.test(m.name));
    const picked = bestTextModel(models);
    if (picked && chat.length > 1) {
      console.log(
        `\n  drafted "${picked}" for text because it is the largest of ${chat.length} chat-capable\n` +
        `  models here. That is a GUESS — size is not preference, and two models can look\n` +
        `  identical from outside and behave differently (a "thinking" build can spend its\n` +
        `  whole budget reasoning and return an empty string). Change it in the profile if\n` +
        `  it is wrong, then prove whichever you choose:\n` +
        `      node scripts/doctor.mjs text --write`,
      );
    }
  }
  if (!found.length) console.log("  nothing — start your services first, or add them by hand.");
  console.log(`\nworkstreams are left EMPTY on purpose: which work this machine offers is a\njudgement about what it is FOR, not something a port scan can answer.\n`);
  console.log("--- draft profile ---");
  console.log(JSON.stringify(profile, null, 2));
}
