#!/usr/bin/env node
/**
 * The video benchmark behind docs/video-model-experiment-2026-09-27.md.
 *
 * Drives the console's own queue (POST /api/video/jobs) rather than ComfyUI
 * directly, so every number here went through the same resource lease,
 * measurement and runs record as a click in the Video Lab — the benchmark is
 * also the end-to-end test.
 *
 *   node scripts/video-bench.mjs --models wan2.2-ti2v-5b,wan2.2-14b --plan speed
 *   node scripts/video-bench.mjs --plan quality
 *   node scripts/video-bench.mjs --plan cloud          # Veo, costs money
 *
 * One job at a time. Between jobs it checks AI\logs\gpu-claim.txt — the
 * convention the parallel explorations agreed on — and waits while another
 * session holds a fresh claim, so a measured run never shares the card with
 * someone else's measured run. Results append to --out as JSON lines.
 */
import fs from "node:fs";
import path from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]?.startsWith("--") ? "1" : all[i + 1] ?? "1"]] : acc), []),
);
const CONSOLE = args.console ?? process.env.CONSOLE_URL ?? "http://localhost:8003";
const OUT = args.out ?? "video-bench.jsonl";
const CLAIM = args.claim ?? "C:\\Users\\Admin\\Code\\AI\\logs\\gpu-claim.txt";
const ME = "Video explorations (04)";
const LOCAL = ["wan2.2-ti2v-5b", "wan2.2-14b", "ltx-2.5", "hunyuanvideo-1.5", "minimax-h3"];
const models = (args.models ?? LOCAL.join(",")).split(",");

// A Globe Quest destination, read as a fixture (globe_quest/src/lib/data/cities.ts:
// Lisbon, "Sun-soaked European base for the remote-work crowd."). Nothing in
// that project is wired to this box.
export const CITY_STILL =
  "Lisbon, Portugal: aerial view over the Alfama district's terracotta rooftops down to the Tagus river at golden hour, a yellow tram on a steep cobbled street, whitewashed houses, warm low sun, photorealistic travel photograph";
export const PROMPTS = {
  city: "Slow cinematic aerial push-in over Lisbon's terracotta rooftops toward the Tagus river at golden hour. A yellow tram climbs the steep street below, gulls glide across the frame, warm sunlight and light haze. Sound of distant tram bells and gulls.",
  waves: "Ocean waves crash against dark volcanic rocks at sunset, spray catching the orange light, the camera slowly tracks left along the shore. Sound of surf.",
  musician: "A street musician in a denim jacket plays acoustic guitar on a cobblestone square, fingers moving on the frets, passers-by walking behind him, handheld camera, natural daylight.",
  cyclist: "A cyclist in a red jersey speeds down a winding mountain road; a drone camera follows from behind and above, pine forest on both sides, dust kicking up on the bends.",
  barista: "Close-up of a barista pouring latte art into a white ceramic cup on a wooden café counter, steam rising, shallow depth of field, a chalkboard in the background reading CAFE.",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(p, init) {
  const res = await fetch(`${CONSOLE}${p}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${p}: ${body.error ?? res.status}`);
  return body;
}

/** Someone else's claim younger than 30 minutes. */
function otherClaim() {
  try {
    const text = fs.readFileSync(CLAIM, "utf8").trim();
    if (!text || text.startsWith(ME)) return null;
    const at = /(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)/.exec(text)?.[1];
    if (at && Date.now() - new Date(at.endsWith("Z") ? at : `${at}Z`).getTime() > 30 * 60_000) return null;
    return text;
  } catch {
    return null;
  }
}
const claim = (what) => fs.writeFileSync(CLAIM, `${ME} ${new Date().toISOString()} ${what}\n`);
const unclaim = () => {
  try {
    if (fs.readFileSync(CLAIM, "utf8").startsWith(ME)) fs.writeFileSync(CLAIM, "");
  } catch {
    /* no claim file */
  }
};

async function sourceStill() {
  if (args.source) return args.source;
  const cache = path.join(path.dirname(OUT), "video-bench-source.txt");
  if (fs.existsSync(cache)) return fs.readFileSync(cache, "utf8").trim();
  console.log("making the Lisbon still locally (z-image-turbo)…");
  const img = await api("/api/image/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: CITY_STILL, model: "z-image-turbo", width: 1280, height: 720, seed: 20260927 }),
  });
  const src = await api("/api/video/source", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ galleryRel: img.saved }),
  });
  console.log(`  still ${img.saved} in ${(img.latency / 1000).toFixed(1)} s → ${src.path}`);
  fs.writeFileSync(cache, src.path);
  return src.path;
}

async function runOne(spec) {
  const t0 = Date.now();
  let { job } = await api("/api/video/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...spec, origin: "bench" }),
  });
  let lastStage = "";
  while (["queued", "waiting", "running"].includes(job.status)) {
    await sleep(3000);
    job = (await api(`/api/video/jobs/${job.id}`)).job;
    const stage = `${job.status}/${job.stage}${job.stepsTotal ? ` ${job.stepsDone ?? 0}/${job.stepsTotal}` : ""}`;
    if (stage !== lastStage) {
      console.log(`  ${((Date.now() - t0) / 1000).toFixed(0).padStart(5)}s  ${stage}${job.block ? `  — ${job.block.message}` : ""}${job.etaSec != null ? `  eta ${job.etaSec}s` : ""}`);
      lastStage = stage;
    }
  }
  const row = { at: new Date().toISOString(), label: spec.label, ...job };
  fs.appendFileSync(OUT, JSON.stringify(row) + "\n");
  const vsm = job.status === "done" && job.latencyMs ? ((job.frames / job.fps) / (job.latencyMs / 60000)).toFixed(2) : "—";
  console.log(
    `${job.status.toUpperCase()} ${job.model} ${job.mode} ${job.width}x${job.height} ${job.seconds}s: ${((job.latencyMs ?? 0) / 1000).toFixed(0)} s, ${vsm} s/min, ` +
      `ComfyUI ${job.processPeakVramGb ?? "—"} GB VRAM / ${job.processPeakRamGb ?? "—"} GB RAM; card ${job.peakVramGb ?? "—"} (base ${job.baselineVramGb ?? "—"}), box RAM ${job.peakRamUsedGb ?? "—"} (base ${job.baselineRamUsedGb ?? "—"})${job.error ? ` — ${job.error}` : ""}`,
  );
  return job;
}

async function main() {
  const plan = args.plan ?? "speed";
  const seed = Number(args.seed ?? 20260927);
  const needsStill = plan !== "quality";
  const still = needsStill ? await sourceStill() : null;
  const jobs = [];
  for (const model of models) {
    if (plan === "speed") {
      // Seconds of video per minute: two resolutions × two lengths, image-to-video from the city still.
      // HunyuanVideo has only its 480p checkpoints here, so it has no second tier to measure.
      const tiers = model === "hunyuanvideo-1.5" ? ["low"] : ["low", "high"];
      for (const tier of tiers) for (const seconds of [5, 10]) jobs.push({ label: "speed", model, mode: "i2v", prompt: PROMPTS.city, sourceImage: still, tier, seconds, seed, local: true });
    }
    if (plan === "quality") {
      // Five prompts, one seed, text-to-video at the low tier: the side-by-side.
      const only = args.prompts ? new Set(args.prompts.split(",")) : null;
      for (const [name, prompt] of Object.entries(PROMPTS)) {
        if (only && !only.has(name)) continue;
        jobs.push({ label: `quality:${name}`, model, mode: "t2v", prompt, tier: "low", seconds: 5, seed, local: true });
      }
    }
    if (plan === "city") {
      // The use case: a 10 s clip for a city page, from a locally generated still.
      jobs.push({ label: "city", model, mode: "i2v", prompt: PROMPTS.city, sourceImage: still, tier: "high", seconds: 10, seed, local: true });
    }
  }
  if (plan === "cloud") {
    for (const model of (args.cloud ?? "veo-3.1-fast").split(",")) {
      jobs.push({ label: "cloud:city-i2v", model, mode: "i2v", prompt: PROMPTS.city, sourceImage: still, tier: "high", seconds: 8, seed, local: false });
      jobs.push({ label: "cloud:city-t2v", model, mode: "t2v", prompt: PROMPTS.city, tier: "high", seconds: 8, seed, local: false });
    }
  }
  console.log(`${jobs.length} job(s) against ${CONSOLE}, results → ${OUT}`);
  // One claim for the whole plan: releasing between jobs let other sessions'
  // measured runs land in the middle of a series.
  const anyLocal = jobs.some((j) => j.local);
  if (anyLocal) {
    for (let other = otherClaim(); other; other = otherClaim()) {
      console.log(`waiting: ${other}`);
      await sleep(60_000);
    }
    claim(`${args.plan ?? "speed"} plan, ${jobs.filter((j) => j.local).length} local job(s)`);
  }
  try {
    for (const j of jobs) {
      const { local, ...spec } = j;
      console.log(`\n▶ ${spec.label} ${spec.model} ${spec.mode} ${spec.tier} ${spec.seconds}s`);
      try {
        await runOne({ ...spec, local });
      } catch (e) {
        console.log(`  error: ${e.message}`);
      }
    }
  } finally {
    if (anyLocal && !args["keep-claim"]) unclaim();
  }
}

process.on("SIGINT", () => {
  unclaim();
  process.exit(130);
});
main().catch((e) => {
  unclaim();
  console.error(e);
  process.exit(1);
});
