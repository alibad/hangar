import assert from "node:assert/strict";
import test from "node:test";
import { evaluateFit, estimateFromParams, BYTES_PER_PARAM } from "../src/lib/model-fit.ts";

/**
 * The fit arithmetic decides whether a 20 GB download is worth starting, and it
 * runs in three places (the API, the browser, this file). Node strips the types
 * and imports the same module the app does — a second copy of these sums in
 * CommonJS would be the one thing worse than no test.
 *
 * The machine is this box, as measured 2026-08-19: RTX 5090, 31.8 GB VRAM,
 * 63.3 GB RAM, 1180 GB free on D:.
 */
const BOX = {
  gpuName: "NVIDIA GeForce RTX 5090",
  vramTotalGb: 31.8,
  vramFreeGb: 31.8,
  ramTotalGb: 63.3,
  ramFreeGb: 60,
  weightsDiskFreeGb: 1180,
  weightsDiskLabel: "D:\\",
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

test("4-bit schemes are not priced at a clean half byte", () => {
  // AWQ and GPTQ keep fp16 scales per group; 0.5 understated local-coder by ~1.5 GB.
  for (const p of ["awq4", "gptq4", "nvfp4", "int4"]) {
    assert.ok(BYTES_PER_PARAM[p] > 0.5, `${p} should cost more than 0.5 B/param`);
  }
  assert.equal(BYTES_PER_PARAM.fp16, 2);
});
