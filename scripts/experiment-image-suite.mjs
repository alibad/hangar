// Runs the fixed image evaluation suite (experiments/image-eval/suite.json)
// through the console's normal endpoints, so every image lands in the gallery
// and the Image Studio's Eval tab can lay them out side by side.
//
//   node scripts/experiment-image-suite.mjs generate [--models a,b] [--prompts x,y] [--seeds 1,2] [--run id]
//   node scripts/experiment-image-suite.mjs cloud --models gpt-image-2 [--run id]
//   node scripts/experiment-image-suite.mjs edits [--models flux2-klein-4b,qwen-image-edit] [--run id]
//   node scripts/experiment-image-suite.mjs resolution [--run id]
//   node scripts/experiment-image-suite.mjs warm [--models ...]      (direct to ComfyUI, no unload between runs)
//
// Resumable: a cell already in the run manifest with an image is skipped, so a
// run interrupted by a busy GPU can simply be started again.
//
// GPU etiquette: several sessions share this card. Before a measured batch the
// runner writes its claim into AI/logs/gpu-claim.txt and refuses to start if
// another session's claim is under 30 minutes old (override: --ignore-claim).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { buildComfyImageWorkflow } from "../src/lib/comfy-image-workflows.ts";

const exec = promisify(execFile);
const CONSOLE = process.env.CONSOLE_URL || "http://localhost:8003";
const COMFY = process.env.COMFY_URL || "http://127.0.0.1:8188";
const ROOT = path.resolve(import.meta.dirname, "..");
const SUITE = JSON.parse(await readFile(path.join(ROOT, "experiments/image-eval/suite.json"), "utf8"));
const RUNS = path.join(ROOT, "experiments/image-eval/runs");
const GEN = process.env.QWEN_OUTPUT_DIR || path.join(ROOT, "generated");
const CLAIM ="C:\\Users\\Admin\\Code\\AI\\logs\\gpu-claim.txt";
const LOCAL_DEFAULT = ["flux2-klein-4b", "z-image-turbo", "hidream-o1-dev", "hidream-o1", "qwen-image-2.1", "ideogram-4", "ming-image", "qwen-image"];
const STEPS = { "flux2-klein-4b": 4, "z-image-turbo": 8, "hidream-o1-dev": 28, "hidream-o1": 40, "qwen-image-2.1": 25, "ideogram-4": 20, "ming-image": 12, "qwen-image": 28 };

const [mode = "generate", ...rest] = process.argv.slice(2);
const opt = (name) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
const list = (name, fallback) => (opt(name) ? opt(name).split(",").map((s) => s.trim()).filter(Boolean) : fallback);
const runId = opt("run") || `${SUITE.created}`;
const manifestPath = path.join(RUNS, `${runId}.json`);
const folder = `Image Eval/${runId}`;

// ── measurement ──────────────────────────────────────────────────────────────
async function gpuUsedMiB() {
  const { stdout } = await exec("nvidia-smi", ["--query-gpu=memory.used", "--format=csv,noheader,nounits"], { windowsHide: true });
  return Number(stdout.trim()) || 0;
}
/** Whole-card VRAM sampled every 250 ms: includes the desktop and anything else running. */
function sampler() {
  let peak = 0, base = 0, busy = false;
  const tick = async () => { if (busy) return; busy = true; try { peak = Math.max(peak, await gpuUsedMiB()); } catch {} finally { busy = false; } };
  const ready = gpuUsedMiB().then((v) => { base = v; peak = v; }).catch(() => {});
  const timer = setInterval(() => void tick(), 250);
  return { ready, stop: () => { clearInterval(timer); return { baselineMiB: base, peakMiB: peak }; } };
}

// ── manifest ─────────────────────────────────────────────────────────────────
async function loadManifest() {
  if (existsSync(manifestPath)) return JSON.parse(await readFile(manifestPath, "utf8"));
  return { run: runId, suiteVersion: SUITE.version, host: process.env.COMPUTERNAME || "unknown", folder, started: new Date().toISOString(), cells: [] };
}
// Cells and denials this process produced. save() merges only these into what
// is on disk, so a cloud study (no GPU) can run beside a local one without the
// two processes overwriting each other's results.
const mine = new Map();
const myDenials = new Set();
const myExtras = {};
async function save(m) {
  await mkdir(RUNS, { recursive: true });
  const disk = existsSync(manifestPath) ? JSON.parse(await readFile(manifestPath, "utf8")) : m;
  for (const cell of mine.values()) upsert(disk, cell, false);
  disk.denials = [...(disk.denials ?? []), ...[...myDenials].filter((d) => !(disk.denials ?? []).some((x) => x.at === d.at && x.cell === d.cell))];
  Object.assign(disk, myExtras);
  disk.updated = new Date().toISOString();
  // Write-then-rename: a process killed mid-write once left this file as
  // 11 KB of zero bytes, losing the whole run's measurements.
  await writeFile(manifestPath + ".tmp", JSON.stringify(disk, null, 2) + "\n");
  await rename(manifestPath + ".tmp", manifestPath);
  Object.assign(m, disk);
}
const key = (c) => [c.study, c.model, c.promptId, c.seed ?? "", c.variant ?? ""].join("|");
function upsert(m, cell, track = true) {
  if (track) mine.set(key(cell), cell);
  const i = m.cells.findIndex((c) => key(c) === key(cell));
  if (i >= 0) m.cells[i] = cell; else m.cells.push(cell);
}
const done = (m, probe) => m.cells.some((c) => key(c) === key(probe) && c.savedPath);

// ── GPU claim ────────────────────────────────────────────────────────────────
async function claim(what) {
  if (rest.includes("--ignore-claim")) return;
  // Another session's fresh claim is waited out (up to an hour), not overridden:
  // its measurements are as easy to spoil as ours.
  const deadline = Date.now() + 60 * 60_000;
  for (;;) {
    const text = existsSync(CLAIM) ? (await readFile(CLAIM, "utf8")).trim() : "";
    const ts = text.match(/\d{4}-\d\d-\d\dT[\d:.]+Z?/)?.[0];
    const foreign = text && !text.startsWith("Image") && ts && Date.now() - Date.parse(ts) < 30 * 60_000;
    if (!foreign) break;
    if (Date.now() > deadline) throw new Error(`GPU is still claimed by another session: "${text}". Pass --ignore-claim to override.`);
    console.log(`waiting: GPU claimed by "${text}"`);
    await new Promise((r) => setTimeout(r, 20_000));
  }
  await writeFile(CLAIM, `Image exploration (01) ${new Date().toISOString()} ${what}\n`);
}
async function release() { if (!rest.includes("--ignore-claim")) await writeFile(CLAIM, "").catch(() => {}); }

// ── calls ────────────────────────────────────────────────────────────────────
async function post(route, body) {
  const started = Date.now();
  const r = await fetch(CONSOLE + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(1_500_000) });
  const json = await r.json().catch(() => ({ error: `HTTP ${r.status} with no JSON` }));
  return { status: r.status, json, wallMs: Date.now() - started };
}
/**
 * Where the image landed, relative to the gallery root (what
 * /api/qwen/images/file serves). /api/image/generate and /api/qwen/edit return
 * an absolute `savedPath`; /api/image/edit returns only `saved`, which is
 * already gallery-relative and already includes the folder.
 */
function relSaved(meta) {
  if (meta.savedPath) return path.relative(GEN, meta.savedPath).replace(/\\/g, "/");
  if (!meta.saved) return null;
  const s = String(meta.saved).replace(/\\/g, "/");
  return s.includes("/") ? s : `${folder}/${s}`;
}

function resultCell(base, res, vram) {
  const { image, ...meta } = res.json;
  const savedPath = res.status === 200 ? relSaved(meta) : null;
  return {
    ...base,
    ok: !!savedPath,
    httpStatus: res.status,
    latencyMs: meta.latency ?? res.wallMs,
    wallMs: res.wallMs,
    ...vram,
    savedPath,
    width: meta.width, height: meta.height,
    ...(res.status === 200 ? {} : { error: meta.error ?? meta.message, coordinator: meta.resourceBlocked ? meta.details ?? meta.error : undefined }),
    at: new Date().toISOString(),
  };
}

/**
 * Run one measured call, riding out resource-coordinator refusals.
 *
 * Other sessions share this card, so "gpu-heavy is busy" or "VRAM needs N GB
 * more" is a normal event, not a result. Every refusal is recorded verbatim in
 * the manifest's `denials` (that record is itself a finding: it is what the
 * coordinator says when two models cannot be resident together) and the same
 * cell is retried, for up to 45 minutes, rather than filed as a failure.
 */
async function measured(m, label, call) {
  const deadline = Date.now() + 45 * 60_000;
  for (;;) {
    const s = sampler(); await s.ready;
    const res = await call();
    const vram = s.stop();
    const blocked = res.json.resourceBlocked || res.status === 409 || res.status === 503;
    if (!blocked || Date.now() > deadline || rest.includes("--no-wait")) return { res, vram };
    myDenials.add({ at: new Date().toISOString(), cell: label, status: res.status, error: res.json.error, details: res.json.details, wholeCardMiB: vram.baselineMiB });
    await save(m);
    console.log(`refused ${label}: ${res.json.error} — retrying in 30 s`);
    await new Promise((r) => setTimeout(r, 30_000));
  }
}

async function runGenerate(models, prompts, seeds, study = "suite", extra = {}) {
  const m = await loadManifest();
  for (const model of models) {
    for (const p of prompts) {
      for (const seed of seeds) {
        const base = { study, model, promptId: p.id, seed, variant: extra.variant };
        if (done(m, base)) continue;
        const width = extra.width ?? SUITE.size.width, height = extra.height ?? SUITE.size.height;
        const { res, vram } = await measured(m, key(base), () =>
          post("/api/image/generate", { model, prompt: p.prompt, width, height, seed, steps: STEPS[model], folder, requestId: `eval-${runId}-${model}-${p.id}-${seed}` }));
        const cell = resultCell({ ...base, steps: STEPS[model], requested: `${width}x${height}` }, res, vram);
        upsert(m, cell); await save(m);
        console.log(`${cell.ok ? "ok " : "ERR"} ${model.padEnd(16)} ${p.id.padEnd(20)} ${String(seed).padEnd(9)} ${(cell.latencyMs / 1000).toFixed(1)}s peak ${cell.peakMiB} MiB${cell.ok ? "" : "  " + cell.error}`);
      }
    }
  }
  return m;
}

// ── studies ──────────────────────────────────────────────────────────────────
const byId = (ids) => ids.map((id) => { const p = SUITE.prompts.find((q) => q.id === id); if (!p) throw new Error(`Unknown prompt ${id}`); return p; });

async function studyGenerate() {
  const models = list("models", LOCAL_DEFAULT);
  const prompts = byId(list("prompts", SUITE.prompts.map((p) => p.id)));
  const seeds = list("seeds", SUITE.seeds.map(String)).map(Number);
  await claim(`image suite: ${models.join(",")}`);
  try { await runGenerate(models, prompts, seeds); } finally { await release(); }
}

async function studyCloud() {
  const models = list("models", ["gpt-image-2"]);
  const prompts = byId(list("prompts", SUITE.cloudSubset.prompts));
  // Cloud calls use no local GPU, so no claim. Seed is ignored by hosted APIs.
  await runGenerate(models, prompts, [SUITE.seeds[0]], "suite");
}

async function studyResolution() {
  const prompts = byId(list("prompts", SUITE.resolutionSubset.prompts));
  const seed = SUITE.seeds[0];
  await claim("image resolution study");
  try {
    await runGenerate(["hidream-o1-dev"], prompts, [seed], "resolution", { width: 2048, height: 2048, variant: "native-2048" });
    await runGenerate(list("models", ["flux2-klein-4b", "z-image-turbo", "qwen-image"]), prompts, [seed], "resolution", { width: 2048, height: 2048, variant: "direct-2048" });
  } finally { await release(); }
  // 1024 → 2048 Lanczos from the suite run's own images: the cheap alternative to native 2K.
  const sharp = (await import("sharp")).default;
  const m = await loadManifest();
  const gen = process.env.QWEN_OUTPUT_DIR || path.join(ROOT, "generated");
  for (const model of ["flux2-klein-4b", "z-image-turbo", "qwen-image", "hidream-o1-dev"]) {
    for (const p of prompts) {
      const src = m.cells.find((c) => c.study === "suite" && c.model === model && c.promptId === p.id && c.seed === seed && c.savedPath);
      if (!src) continue;
      const rel = src.savedPath.replace(/\.png$/, "-lanczos2048.png");
      const t = Date.now();
      await sharp(path.join(gen, src.savedPath)).resize(2048, 2048, { kernel: "lanczos3" }).png().toFile(path.join(gen, rel));
      upsert(m, { study: "resolution", model, promptId: p.id, seed, variant: "upscaled-1024-lanczos", ok: true, savedPath: rel, latencyMs: src.latencyMs + (Date.now() - t), upscaleMs: Date.now() - t, requested: "1024x1024 → 2048x2048", at: new Date().toISOString() });
    }
  }
  await save(m);
}

async function toDataUrl(rel) {
  const gen = process.env.QWEN_OUTPUT_DIR || path.join(ROOT, "generated");
  return `data:image/png;base64,${(await readFile(path.join(gen, rel))).toString("base64")}`;
}

async function studyEdits() {
  // "qwen-image-edit" is the Qwen service's separate edit checkpoint (Edit-2511 since 3 Oct, Edit-2509 before); the
  // rest edit through ComfyUI reference images on /api/image/edit.
  const models = list("models", ["flux2-klein-4b", "qwen-image-2.1", "hidream-o1", "ming-image", "qwen-image-edit"]);
  const sharp = (await import("sharp")).default;
  const gen = process.env.QWEN_OUTPUT_DIR || path.join(ROOT, "generated");
  const E = SUITE.edits;
  await claim("image edit study");
  try {
    const m = await runGenerate([E.source.model], [{ id: E.source.id, prompt: E.source.prompt }], [E.source.seed], "edit-source");
    const src = m.cells.find((c) => c.study === "edit-source" && c.savedPath);
    if (!src) throw new Error("Could not produce the edit source image");
    for (const model of models) {
      for (const ins of E.instructions) {
        const base = { study: "edit", model, promptId: ins.id, seed: E.source.seed };
        if (done(m, base)) continue;
        let image = await toDataUrl(src.savedPath), width = 1024, height = 1024;
        if (ins.outpaint) {
          // Canvas extension: pad with neutral grey and ask the model to fill it.
          // Neither path has a mask input here, so this tests instruction-driven outpainting.
          const buf = await sharp(path.join(gen, src.savedPath)).extend({ right: ins.outpaint.right ?? 0, left: ins.outpaint.left ?? 0, background: { r: 128, g: 128, b: 128 } }).png().toBuffer();
          image = `data:image/png;base64,${buf.toString("base64")}`;
          width += (ins.outpaint.right ?? 0) + (ins.outpaint.left ?? 0);
        }
        const { res, vram } = await measured(m, key(base), () => model === "qwen-image-edit"
          ? post("/api/qwen/edit", { prompt: ins.prompt, images: [image], seed: E.source.seed, steps: 28, cfg: 4, folder, requestId: `eval-edit-${ins.id}` })
          : post("/api/image/edit", { model, prompt: ins.prompt, images: [image], width, height, seed: E.source.seed, folder, requestId: `eval-edit-${model}-${ins.id}` }));
        const cell = resultCell({ ...base, kind: ins.kind, source: src.savedPath, requested: `${width}x${height}` }, res, vram);
        upsert(m, cell); await save(m);
        console.log(`${cell.ok ? "ok " : "ERR"} ${model.padEnd(16)} ${ins.id.padEnd(16)} ${(cell.latencyMs / 1000).toFixed(1)}s peak ${cell.peakMiB} MiB${cell.ok ? "" : "  " + cell.error}`);
      }
    }
  } finally { await release(); }
}

// Warm timing, straight to ComfyUI. The console frees ComfyUI's weights after
// every idle-queue job (src/lib/flux.ts) so the resource coordinator's numbers
// stay honest; that means no console request is ever truly warm. This measures
// what warm WOULD be: the same graph queued twice with no /free between.
async function studyWarm() {
  const models = list("models", ["flux2-klein-4b", "z-image-turbo", "hidream-o1-dev", "hidream-o1", "qwen-image-2.1", "ideogram-4", "ming-image"]);
  const prompt = SUITE.prompts.find((p) => p.id === "illus-paper-fox").prompt;
  const out = [];
  await claim("image warm-vs-cold timing (direct ComfyUI)");
  try {
    for (const model of models) {
      await fetch(`${COMFY}/free`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ unload_models: true, free_memory: true }) });
      for (const run of ["cold", "warm", "warm"]) {
        const size = 1024;
        const graph = buildComfyImageWorkflow(model, { prompt, width: size, height: size, seed: 11 + out.length, steps: STEPS[model] });
        const s = sampler(); await s.ready;
        const t = Date.now();
        const { prompt_id } = await (await fetch(`${COMFY}/prompt`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: graph }) })).json();
        let status;
        for (;;) {
          await new Promise((r) => setTimeout(r, 200));
          const h = await (await fetch(`${COMFY}/history/${prompt_id}`)).json();
          if (h[prompt_id]?.status?.completed || h[prompt_id]?.status?.status_str === "error") { status = h[prompt_id].status.status_str; break; }
        }
        const v = s.stop();
        out.push({ model, run, ms: Date.now() - t, status, ...v });
        console.log(`${model.padEnd(16)} ${run.padEnd(5)} ${((Date.now() - t) / 1000).toFixed(1)}s peak ${v.peakMiB} MiB (baseline ${v.baselineMiB})`);
      }
    }
    await fetch(`${COMFY}/free`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ unload_models: true, free_memory: true }) });
  } finally { await release(); }
  const m = await loadManifest();
  myExtras.warm = { note: "Direct ComfyUI /prompt, 1024x1024, cold = after /free (weights still in OS file cache), warm = immediately repeated with weights resident. Whole-card VRAM.", results: out };
  await save(m);
}

// Clean cold footprints, for config/model-meta.json. The suite's own VRAM
// figures are whole-card peaks over whatever was resident before — and
// ComfyUI's /free is lazy, so that was often the previous model. Here each
// model starts from a settled card: /free, wait until memory stops falling,
// then one generation through the console, sampling VRAM and free host RAM.
async function studyFootprint() {
  const os = await import("node:os");
  const models = list("models", ["flux2-klein-4b", "z-image-turbo", "hidream-o1-dev", "hidream-o1", "qwen-image-2.1", "ideogram-4", "ming-image"]);
  const out = [];
  await claim("image footprint measurement (one cold run per model)");
  try {
    for (const model of models) {
      // 2K too where it is offered: Klein at 2048² used 21 GiB against a 15 GB declaration.
      for (const size of ["z-image-turbo", "qwen-image-2.1", "ideogram-4", "ming-image"].includes(model) ? [1024] : [1024, 2048]) {
        await fetch(`${COMFY}/free`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ unload_models: true, free_memory: true }) }).catch(() => {});
        // /free takes effect when ComfyUI next idles; wait for the card to settle.
        let prev = Infinity, settled = await gpuUsedMiB();
        for (let i = 0; i < 30 && prev - settled > 100; i++) { await new Promise((r) => setTimeout(r, 1000)); prev = settled; settled = await gpuUsedMiB(); }
        const ramFreeBefore = os.freemem();
        let ramFreeMin = ramFreeBefore;
        const ramTimer = setInterval(() => { ramFreeMin = Math.min(ramFreeMin, os.freemem()); }, 250);
        const prompt = SUITE.prompts.find((p) => p.id === "photo-fisherman").prompt;
        const m = await loadManifest();
        const { res, vram } = await measured(m, `footprint|${model}|${size}`, () =>
          post("/api/image/generate", { model, prompt, width: size, height: size, seed: 11, steps: STEPS[model], folder: `${folder}/footprint`, requestId: `eval-footprint-${model}-${size}` }));
        clearInterval(ramTimer);
        const row = { model, size, ok: res.status === 200, latencyMs: res.json.latency ?? res.wallMs, settledBaselineMiB: vram.baselineMiB, peakMiB: vram.peakMiB, vramDeltaGiB: +((vram.peakMiB - vram.baselineMiB) / 1024).toFixed(2), hostRamDropGiB: +((ramFreeBefore - ramFreeMin) / 2 ** 30).toFixed(2), error: res.status === 200 ? undefined : res.json.error };
        out.push(row);
        console.log(`${model.padEnd(16)} ${size} ${(row.latencyMs / 1000).toFixed(1)}s  VRAM +${row.vramDeltaGiB} GiB over ${(vram.baselineMiB / 1024).toFixed(1)}  host RAM -${row.hostRamDropGiB} GiB${row.error ? "  " + row.error : ""}`);
      }
    }
  } finally { await release(); }
  const m = await loadManifest();
  myExtras.footprint = { at: new Date().toISOString(), note: "One cold console generation per model after /free and a settled card. VRAM delta = whole-card peak minus the settled baseline (nvidia-smi, 250 ms). Host RAM drop = largest fall in system free memory during the run; other processes on the box add noise.", results: [...(m.footprint?.results ?? []).filter((r) => !out.some((o) => o.model === r.model && o.size === r.size)), ...out] };
  await save(m);
}

// Can two image models be resident together? Ask the resource coordinator
// directly: hold a lease for A, request B with no wait, record verbatim what it
// says, release both. No image is generated. Run it once with only ComfyUI up
// and once with the Qwen service loaded; the snapshot records which was which.
async function studyCoresidency() {
  const MANAGER = process.env.MANAGER_URL || "http://127.0.0.1:8099";
  // waitMs 0 means "queue forever", not "answer now" — a first version of this
  // probe reported a pair as co-resident when the second request had merely
  // outlived the first lease's TTL. A few seconds lets the queue drain once and
  // come back with the coordinator's own denial.
  const acquire = async (workload) => {
    const r = await fetch(`${MANAGER}/resources/leases/acquire`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workload, owner: `eval:coresidency:${workload}`, lane: "interactive", waitMs: 4000, ttlMs: 300_000 }) });
    return { status: r.status, body: await r.json() };
  };
  const release = (lease) => lease && fetch(`${MANAGER}/resources/leases/${lease.id}/release`, { method: "POST" });
  const snap = await (await fetch(`${MANAGER}/resources`)).json();
  const services = snap.activeServices ?? [];
  const pairs = [["flux2-klein-generate", "z-image-generate"], ["flux2-klein-generate", "hidream-o1-generate"], ["qwen-generate", "flux2-klein-generate"], ["qwen-generate", "qwen-image-21-generate"]];
  const results = [];
  for (const [a, b] of pairs) {
    const first = await acquire(a);
    const second = first.status === 201 ? await acquire(b) : null;
    results.push({ hold: a, holdResult: first.status === 201 ? "granted" : first.body, request: b, requestResult: second ? (second.status === 201 ? "granted" : second.body) : "not attempted" });
    await release(second?.body?.lease);
    await release(first.body?.lease);
    console.log(`${a} + ${b}: ${second ? (second.status === 201 ? "granted" : second.body.error) : "first refused: " + first.body.error}`);
  }
  // Separately: can each be admitted ALONE right now, given what is resident?
  const alone = [];
  for (const w of ["flux2-klein-generate", "z-image-generate", "hidream-o1-generate", "hidream-o1-full-generate", "qwen-image-21-generate", "ideogram-4-generate", "ming-image-generate", "qwen-generate"]) {
    const r = await acquire(w);
    alone.push({ workload: w, result: r.status === 201 ? "granted" : r.body });
    await release(r.body?.lease);
    console.log(`${w} alone: ${r.status === 201 ? "granted" : r.body.error}`);
  }
  const m = await loadManifest();
  myExtras.coresidency = [...(m.coresidency ?? []), { at: new Date().toISOString(), runningServices: services, capacity: snap.capacity ?? null, modeledUsage: snap.usage ?? null, pairs: results, alone }];
  await save(m);
}

// Contact sheets: one PNG per prompt, a row per seed, a column per model, each
// tile captioned. For reading a run outside the console (or sending it on).
async function studySheets() {
  const sharp = (await import("sharp")).default;
  const m = await loadManifest();
  const study = opt("study") || "suite";
  const tile = Number(opt("tile") || 512);
  const out = path.join(GEN, folder, "sheets");
  await mkdir(out, { recursive: true });
  const only = list("models", null);
  const cells = m.cells.filter((c) => c.study === study && c.ok && c.savedPath && (!only || only.includes(c.model)));
  const models = only ?? [...new Set(cells.map((c) => c.model))];
  const esc = (s) => String(s).replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[ch]);
  for (const promptId of [...new Set(cells.map((c) => c.promptId))]) {
    const rowOf = (c) => (study === "resolution" ? c.variant : String(c.seed));
    const rows = [...new Set(cells.filter((c) => c.promptId === promptId).map(rowOf))];
    const cap = 28;
    const layers = [];
    for (const [r, row] of rows.entries()) {
      for (const [i, model] of models.entries()) {
        const c = cells.find((x) => x.promptId === promptId && x.model === model && rowOf(x) === row);
        const top = r * (tile + cap), left = i * tile;
        const label = c ? `${model} · ${row} · ${(c.latencyMs / 1000).toFixed(1)}s` : `${model} · ${row} · not run`;
        layers.push({ input: Buffer.from(`<svg width="${tile}" height="${cap}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#111"/><text x="6" y="19" font-family="Arial" font-size="15" fill="#eee">${esc(label)}</text></svg>`), top, left });
        if (c) layers.push({ input: await sharp(path.join(GEN, c.savedPath)).resize(tile, tile, { fit: "contain", background: "#000" }).png().toBuffer(), top: top + cap, left });
      }
    }
    const file = path.join(out, `${study}-${promptId}.png`);
    await sharp({ create: { width: models.length * tile, height: rows.length * (tile + cap), channels: 3, background: "#000" } }).composite(layers).png().toFile(file);
    console.log(file);
  }
}

const studies = { footprint: studyFootprint, coresidency: studyCoresidency, sheets: studySheets, generate: studyGenerate, cloud: studyCloud, resolution: studyResolution, edits: studyEdits, warm: studyWarm };
if (!studies[mode]) { console.error(`Unknown mode ${mode}. One of: ${Object.keys(studies).join(", ")}`); process.exit(2); }
await studies[mode]();
console.log(`DONE ${mode}`);
