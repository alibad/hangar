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
 *
 * ── A PORT IS NOT AN IDENTITY ───────────────────────────────────────────────
 * This used to identify a service by two facts: the port matched its table, and
 * something answered. That is not enough, and it was caught in the act on
 * 2026-09-21 — this script reported `:4000 ai-router HTTP 200` on a Mac with no
 * router installed at all. Some other project's dev server held the port for a
 * few minutes and was duly written into a draft profile as the AI Router.
 *
 * The script was already careful about the opposite case, reporting a port that
 * answers NOTHING as unidentified, with the line "an open port is not
 * evidence". It then went on to treat any answer at all as conclusive. A wrong
 * identification is worse than a missing one: a missing service is a gap
 * someone fills, and a wrong one is a service the console reports as DOWN
 * forever while somebody debugs software they never installed.
 *
 * So every entry now declares what its answer should LOOK like, and a port that
 * answers with the wrong shape is reported as a mismatch rather than adopted.
 */

import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import os from "node:os";
import { promisify } from "node:util";
import { KNOWN, classifyAnswer, MAX_PROBE_BYTES } from "./detect-host.probe.mjs";

const run = promisify(execFile);
const GB = (bytes) => Math.round((bytes / 1024 ** 3) * 10) / 10;

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

/**
 * Ask a port what it is, and keep the answer — not just its status code.
 *
 * The body is what makes the difference between "something answered" and "the
 * expected service answered", so it is read and, where it parses, kept as JSON.
 *
 * PARSE THE WHOLE BODY, up to MAX_PROBE_BYTES. Clipping before parsing is what
 * made the first version of the shape check report the real service manager as
 * an impostor; see the constant's own note.
 */
async function probeHealth(port, path) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(2500) });
    const full = await res.text();
    if (full.length > MAX_PROBE_BYTES) {
      return { status: res.status, ok: res.ok, text: full.slice(0, 2048), json: undefined, oversized: true };
    }
    let json;
    try {
      json = JSON.parse(full);
    } catch {
      json = undefined;
    }
    // `text` is kept short for reporting; `json` is parsed from the whole body.
    return { status: res.status, ok: res.ok, text: full.slice(0, 2048), json };
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
// Three outcomes, not two. A port that answers with the WRONG shape is the
// case this script used to get silently wrong, and it is now its own bucket.
const found = [];
const unidentified = [];
const mismatched = [];
for (const svc of KNOWN) {
  if (!(await listening(svc.port))) continue;
  const health = await probeHealth(svc.port, svc.verifyPath ?? svc.healthPath);
  const verdict = classifyAnswer(svc, health);
  if (verdict.state === "identified") found.push({ ...svc, health, weak: verdict.weak });
  else if (verdict.state === "mismatch") mismatched.push({ ...svc, health, why: verdict.why });
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
  console.log(JSON.stringify({
    ...profile,
    _unidentifiedPorts: unidentified.map((u) => u.port),
    _mismatchedPorts: mismatched.map((m) => ({ port: m.port, expected: m.id, why: m.why })),
  }, null, 2));
} else {
  console.log(`machine      ${machine}   ->  profile id "${id}"`);
  console.log(`platform     ${process.platform}`);
  console.log(`accelerator  ${gpu}${gpuName ? ` (${gpuName})` : ""}`);
  console.log(`memory       ${memoryKind}${memoryKind === "unified" ? ` · ${memory.totalGb} GB one pool` : ` · ${memory.vramTotalGb} GB VRAM + ${memory.ramTotalGb} GB RAM`}`);
  console.log(`\nidentified (${found.length} of ${KNOWN.length} known ports):`);
  for (const s of found) {
    console.log(`  :${String(s.port).padEnd(5)} ${s.id.padEnd(12)} HTTP ${s.health.status}${s.weak ? "   (shape not verified — only that it speaks JSON)" : ""}`);
  }
  if (mismatched.length) {
    console.log(`\nSOMETHING ELSE is on these ports — left out of the draft:`);
    for (const s of mismatched) {
      console.log(`  :${String(s.port).padEnd(5)} expected ${s.name}, but ${s.why}.`);
      console.log(`         Whatever is holding this port, it is not ${s.name}. Adding it anyway would`);
      console.log(`         make the console report ${s.id} as DOWN forever while you debug software`);
      console.log(`         you never installed.`);
    }
  }
  if (unidentified.length) {
    console.log(`\nlistening but NOT identified — left out of the draft on purpose:`);
    for (const s of unidentified) {
      console.log(`  :${String(s.port).padEnd(5)} something is bound here, but ${s.verifyPath ?? s.healthPath} answered nothing.`);
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
