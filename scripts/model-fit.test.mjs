import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateFit,
  estimateFromParams,
  bestPrecisionFor,
  precisionLadderFor,
  BYTES_PER_PARAM,
  PRECISION_LADDER,
} from "../src/lib/model-fit.ts";

/**
 * The fit arithmetic decides whether a 20 GB download is worth starting, and it
 * runs in three places (the API, the browser, this file). Node strips the types
 * and imports the same module the app does — a second copy of these sums in
 * CommonJS would be the one thing worse than no test.
 *
 * TWO machines are pinned here, because three of this module's assumptions
 * turned out to be facts about the first one rather than about hardware.
 */

/** The Windows box, as measured 2026-08-19: RTX 5090, discrete, sm_120. */
const BOX = {
  gpuName: "NVIDIA GeForce RTX 5090",
  runtime: "cuda",
  memoryModel: "discrete",
  computeCapability: "12.0",
  vramTotalGb: 31.8,
  vramFreeGb: 31.8,
  ramTotalGb: 63.3,
  ramFreeGb: 60,
  weightsDiskFreeGb: 1180,
  weightsDiskLabel: "D:\\",
};

/**
 * B5 — the Apple silicon machine the console also runs on, per
 * config/hosts/b5.json: M5 Max, 128 GB unified.
 *
 * vramTotalGb and ramTotalGb are NOT two pools here. They are the same silicon
 * seen through two limits: how much memory exists, and how much of it the GPU
 * is allowed to hold at once. sysinfo.gpuReading() reports the whole pool for
 * both, so they are equal on this host — the separate ceiling only bites where
 * someone has pinned iogpu.wired_limit_mb, which one test below covers.
 */
const B5 = {
  gpuName: "Apple M5 Max",
  runtime: "metal",
  memoryModel: "unified",
  vramTotalGb: 128,
  vramFreeGb: 96,
  ramTotalGb: 128,
  ramFreeGb: 96,
  weightsDiskFreeGb: 900,
  weightsDiskLabel: "/",
};

test("a cloud model costs no local memory and says so", () => {
  const fit = evaluateFit({ requirement: {}, machine: BOX });
  assert.equal(fit.verdict, "off-box");
  assert.equal(fit.vramNeededGb, 0);
});

test("a small model fits with room to spare", () => {
  const fit = evaluateFit({ requirement: { vramGb: 6, ramGb: 1 }, machine: BOX });
  assert.equal(fit.verdict, "fits");
  assert.ok(fit.headroomGb > 20, `expected plenty of headroom, got ${fit.headroomGb}`);
});

test("a model that nearly fills the card reads as 'tight', not 'fits'", () => {
  // FLUX.1-schnell measured 31.7 GB of a 31.8 GB card — the case that taught us
  // a boolean "does it fit" is the wrong answer shape.
  const fit = evaluateFit({ requirement: { vramGb: 30, ramGb: 28 }, machine: BOX });
  assert.equal(fit.verdict, "tight");
  assert.match(fit.headline, /whole card/);
});

test("a model larger than the card never reads as fitting", () => {
  const fit = evaluateFit({ requirement: { vramGb: 48, ramGb: 2 }, machine: BOX });
  assert.equal(fit.verdict, "no");
  assert.deepEqual(fit.displaces, []);
});

test("host RAM is checked independently of VRAM", () => {
  // The collision that has actually killed a service on this box: VRAM looked
  // healthy the whole time.
  const fit = evaluateFit({ requirement: { vramGb: 2, ramGb: 62 }, machine: BOX });
  assert.equal(fit.verdict, "no");
  assert.match(fit.headline, /host RAM/);
});

test("a busy machine yields 'swap' and names the shortest list to stop", () => {
  const busy = { ...BOX, vramFreeGb: 8, ramFreeGb: 20 };
  const fit = evaluateFit({
    requirement: { vramGb: 22, ramGb: 2 },
    machine: busy,
    occupants: [
      { serviceId: "qwen", name: "Qwen-Image", vramGb: 20.3, ramGb: 28 },
      { serviceId: "tts", name: "Kokoro TTS", vramGb: 0.4, ramGb: 0.5 },
    ],
  });
  assert.equal(fit.verdict, "swap");
  // Stopping Kokoro would free 0.4 GB and change nothing; only the big holder
  // is worth naming.
  assert.deepEqual(fit.displaces, ["qwen"]);
  assert.match(fit.headline, /Qwen-Image/);
});

test("no disk for the weights outranks a comfortable memory fit", () => {
  const fullDisk = { ...BOX, weightsDiskFreeGb: 5 };
  const fit = evaluateFit({ requirement: { vramGb: 6, ramGb: 1, diskGb: 40 }, machine: fullDisk });
  assert.equal(fit.verdict, "no");
  assert.match(fit.reasons.join(" "), /D:/);
});

test("estimateFromParams marks itself as an estimate and shows its working", () => {
  const req = estimateFromParams({ paramsB: 27.4, precision: "nvfp4", contextK: 32, kind: "llm" });
  assert.equal(req.estimated, true);
  assert.match(req.basis, /Estimated, not measured/);
  // 27.4 x 0.55 = 15.07 GB of weights, x1.15 overhead, + ~11 GB of KV for 32k.
  assert.ok(req.vramGb > 15 && req.vramGb < 32, `implausible estimate: ${req.vramGb} GB`);
  assert.equal(evaluateFit({ requirement: req, machine: BOX }).verdict !== "no", true);
});

test("a diffusion model's host RAM cost is counted, an LLM's is not", () => {
  const diffusion = estimateFromParams({ paramsB: 20, precision: "fp8", kind: "diffusion" });
  const llm = estimateFromParams({ paramsB: 20, precision: "fp8", contextK: 32, kind: "llm" });
  // Qwen-Image's measured 28 GB of standing host RAM is the whole reason this
  // distinction exists — an LLM server keeps its weights on the card.
  assert.ok(diffusion.ramGb > 15, `expected a real RAM cost, got ${diffusion.ramGb}`);
  assert.equal(llm.ramGb, 1);
  // ...and only the LLM pays for context.
  assert.ok(llm.vramGb > diffusion.vramGb);
});

test("the KV estimate matches published GQA geometry within a factor of two", () => {
  // Qwen2.5-7B: 28 layers x 4 kv heads x 128 dims x 2 (K,V) x 2 bytes
  //   = 56 KB/token -> 0.9 GB at 16k. The estimator must land near that, since
  //   an over-reservation here is what pushed 32B models onto Q3 quantisation.
  const weights7b = 7 * BYTES_PER_PARAM.awq4 * 1.15;
  const kv7b = estimateFromParams({ paramsB: 7, precision: "awq4", contextK: 16 }).vramGb - weights7b;
  assert.ok(kv7b > 0.45 && kv7b < 1.8, `7B @16k KV estimate off: ${kv7b.toFixed(2)} GB vs ~0.9 measured`);

  // Qwen3-32B: 64 layers x 8 kv heads x 128 x 2 x 2 = 256 KB/token -> 8.0 GB at 32k.
  const weights32b = 32 * BYTES_PER_PARAM.nvfp4 * 1.15;
  const kv32b = estimateFromParams({ paramsB: 32, precision: "nvfp4", contextK: 32 }).vramGb - weights32b;
  assert.ok(kv32b > 4 && kv32b < 16, `32B @32k KV estimate off: ${kv32b.toFixed(2)} GB vs ~8.0 measured`);
});

test("a 32B runs on this card at 4-bit, not only at Q3", () => {
  // The regression that motivated re-deriving the KV constant: a 32B at NVFP4
  // is roughly 20 GB of weights plus 6 GB of KV, which fits a 31.8 GB card with
  // room. Reporting it as Q3-only understates the machine by a whole tier.
  const { best } = bestPrecisionFor({ paramsB: 32, machine: BOX, contextK: 32 });
  assert.ok(best, "a 32B must be runnable here at some precision");
  assert.ok(
    ["bf16", "fp8", "nvfp4", "awq4"].includes(best.precision),
    `expected 4-bit or better, got ${best.precision}`,
  );
});

test("the precision ladder is ordered best-quality first and stops at the first fit", () => {
  // 45B is the interesting size on this card: too big for 4-bit once a 32k KV
  // cache is counted, small enough that a heavier quantisation rescues it. A
  // 70B does not fit here at ANY rung, which is the correct answer and a
  // useless test case.
  const { best, rungs } = bestPrecisionFor({ paramsB: 45, machine: BOX, contextK: 32 });
  assert.ok(best, "a 45B should be runnable at some quantisation on a 32 GB card");
  assert.equal(rungs.length, PRECISION_LADDER.length);
  // Every rung above the chosen one must genuinely not fit, or the ladder is
  // handing back a worse model than the machine can run.
  const at = rungs.findIndex((r) => r.precision === best?.precision);
  assert.ok(at >= 0);
  for (const r of rungs.slice(0, at)) assert.equal(r.fit.verdict, "no");
  // ...and each step down must actually be smaller.
  for (let i = 1; i < rungs.length; i++) {
    assert.ok(
      rungs[i].requirement.vramGb <= rungs[i - 1].requirement.vramGb,
      `${rungs[i].precision} is not smaller than ${rungs[i - 1].precision}`,
    );
  }
});

test("a frontier-scale model is unrunnable at every rung", () => {
  // 744B (GLM-5) is 260 GB even at Q2. There must be no precision that claims
  // otherwise — a false "fits" here would send someone after a 260 GB download.
  const { best, rungs } = bestPrecisionFor({ paramsB: 744, machine: BOX, contextK: 32 });
  assert.equal(best, null);
  assert.ok(rungs.every((r) => r.fit.verdict === "no"));
});

// ── The second machine ──────────────────────────────────────────────────────

test("weights built for the wrong runtime never fit, at any size", () => {
  // Edge0-35B-A3B: #2 trending on the Hub, Apache-2.0, 19.74 GB on disk, and
  // MLX. The size arithmetic says yes on both machines and is beside the point
  // on one of them — this is the verdict a leaderboard structurally cannot
  // reach, because every number it has says the model fits.
  const edge0 = { vramGb: 22.7, ramGb: 1, diskGb: 19.74, runtimes: ["metal"] };

  const onBox = evaluateFit({ requirement: edge0, machine: BOX });
  assert.equal(onBox.verdict, "no");
  assert.match(onBox.headline, /runtime/i);
  // It must not be refused for being too big, because it isn't.
  assert.ok(
    onBox.reasons.some((r) => /would otherwise have fit/i.test(r)),
    "a runtime refusal must say the size was never the problem",
  );

  assert.equal(evaluateFit({ requirement: edge0, machine: B5 }).verdict, "fits");
});

test("a portable checkpoint is not refused for lack of a runtimes field", () => {
  // Most repos are plain safetensors and declare nothing. Absent must mean
  // "portable", not "unknown, refuse" — otherwise every candidate disappears.
  const fit = evaluateFit({ requirement: { vramGb: 6, ramGb: 1 }, machine: B5 });
  assert.equal(fit.verdict, "fits");
});

test("unified memory counts one copy of the weights, not two", () => {
  // Qwen-Image's measured footprint: 20.3 GB VRAM peak, 28 GB standing host
  // RAM. On the discrete box those are two real costs — the offload is what
  // lets a 20B model share a 32 GB card. On unified memory there is nowhere to
  // offload TO, so charging both would be charging twice for one copy.
  const qwenImage = { vramGb: 20.3, ramGb: 28 };

  const fit = evaluateFit({ requirement: qwenImage, machine: B5 });
  assert.equal(fit.verdict, "fits");
  // Counted once: max(20.3, 28) = 28 against a 124 GB budget leaves 96.
  // Summed, it would charge 48.3 and leave 75.7.
  assert.equal(fit.headroomGb, 96);
  assert.ok(
    fit.reasons.some((r) => /same bytes/.test(r)),
    "the collapse must be explained, not silently applied",
  );

  // And the case where the difference decides the verdict: a 36 GB Mac has a
  // 32 GB budget. Counted once (28) it runs; summed (48.3) it would be refused
  // outright. It reads as "tight" rather than "fits", which is the honest
  // answer — 28 of 36 leaves nothing beside it — but "runs alone" and "cannot
  // run" are the two answers this whole distinction exists to separate.
  const small = { ...B5, ramTotalGb: 36, vramTotalGb: 27, ramFreeGb: 34, vramFreeGb: 27 };
  const onSmall = evaluateFit({ requirement: qwenImage, machine: small });
  assert.equal(onSmall.verdict, "tight");
  assert.match(onSmall.headline, /whole machine/);
});

test("the GPU's share of the pool is a second, separate ceiling", () => {
  // The failure that looks impossible: tens of gigabytes free and the model
  // still will not load, because macOS caps what the GPU may wire. B5 reports
  // the whole pool for both figures, so this only bites once someone pins the
  // limit — which is exactly when a machine needs to be told about it.
  const pinned = {
    ...B5,
    vramTotalGb: 64,
    vramFreeGb: 64,
    vramBasis: "iogpu.wired_limit_mb is pinned to 65536 MB of the 128 GB shared pool.",
  };
  const fit = evaluateFit({ requirement: { vramGb: 80, ramGb: 80 }, machine: pinned });
  assert.equal(fit.verdict, "no");
  assert.match(fit.headline, /GPU's share/);
  // The pool itself was never the problem — 80 fits inside 128.
  assert.ok(fit.reasons.some((r) => /wire/.test(r)));
  // And the refusal repeats where the limit came from, rather than asserting it.
  assert.ok(fit.reasons.some((r) => /iogpu\.wired_limit_mb/.test(r)));

  // Unpinned, the same model is simply fine.
  assert.notEqual(evaluateFit({ requirement: { vramGb: 80, ramGb: 80 }, machine: B5 }).verdict, "no");
});

test("a diffusion model is charged for CPU offload only where offload exists", () => {
  const discrete = estimateFromParams({ paramsB: 20, precision: "fp8", kind: "diffusion" });
  const unified = estimateFromParams({
    paramsB: 20, precision: "fp8", kind: "diffusion", memoryModel: "unified",
  });
  assert.ok(discrete.ramGb > 15, `discrete offload should cost real RAM, got ${discrete.ramGb}`);
  assert.equal(unified.ramGb, 1);
  assert.match(unified.basis, /nowhere to offload/);
  // The GPU-side cost is identical; only the phantom second copy differs.
  assert.equal(discrete.vramGb, unified.vramGb);
});

test("the precision ladder offers only formats the machine can execute", () => {
  const cuda = precisionLadderFor(BOX).map((r) => r.id);
  const metal = precisionLadderFor(B5).map((r) => r.id);

  // NVFP4 is hardware on sm_120 and not a thing a Metal GPU can load at all.
  assert.ok(cuda.includes("nvfp4"));
  assert.ok(!metal.includes("nvfp4"), "NVFP4 must not be offered on Metal");
  // ...and the reverse: MLX on CUDA is not a lower-quality option, it is none.
  assert.ok(metal.includes("mlx4"));
  assert.ok(!cuda.includes("mlx4"), "MLX must not be offered on CUDA");

  // A pre-Blackwell CUDA card loses the rung its silicon does not have.
  const ada = { ...BOX, computeCapability: "8.9" };
  assert.ok(!precisionLadderFor(ada).includes("nvfp4"));
  assert.ok(precisionLadderFor(ada).map((r) => r.id).includes("awq4"));
});

test("bestPrecisionFor picks a rung the machine can actually load", () => {
  // The same 32B on both machines. Each must be offered a format its own stack
  // can run — recommending a download that cannot load is worse than "no".
  const onBox = bestPrecisionFor({ paramsB: 32, machine: BOX, contextK: 32 }).best;
  const onB5 = bestPrecisionFor({ paramsB: 32, machine: B5, contextK: 32 }).best;

  assert.ok(onBox && onB5, "a 32B must be runnable on both machines");
  assert.ok(["bf16", "fp8", "nvfp4", "awq4"].includes(onBox.precision));
  assert.ok(["bf16", "mlx8", "mlx4", "gguf-q4"].includes(onB5.precision));

  // B5 has twice the usable memory, so it must not land on a WORSE rung.
  const ladder = precisionLadderFor(B5).map((r) => r.id);
  assert.ok(ladder.indexOf(onB5.precision) <= ladder.indexOf("mlx4"));
});

test("4-bit schemes are not priced at a clean half byte", () => {
  // AWQ and GPTQ keep fp16 scales per group; 0.5 understated local-coder by ~1.5 GB.
  for (const p of ["awq4", "gptq4", "nvfp4", "int4"]) {
    assert.ok(BYTES_PER_PARAM[p] > 0.5, `${p} should cost more than 0.5 B/param`);
  }
  assert.equal(BYTES_PER_PARAM.fp16, 2);
});
