import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { cellKey, PICK, summarize } from "../src/lib/image-eval.ts";
import { isImageModelId, localImageModelFor } from "../src/lib/image-models.ts";

const suite = JSON.parse(await readFile(new URL("../experiments/image-eval/suite.json", import.meta.url), "utf8"));

test("the suite is the size the brief asked for and every prompt is judgeable", () => {
  assert.ok(suite.prompts.length >= 10 && suite.prompts.length <= 14, "about a dozen prompts");
  assert.equal(suite.seeds.length, 2);
  const ids = new Set();
  for (const p of suite.prompts) {
    assert.ok(!ids.has(p.id), `duplicate prompt id ${p.id}`);
    ids.add(p.id);
    assert.ok(p.prompt.trim() && p.dimension, p.id);
    assert.ok(p.objective.length > 0, `${p.id} needs at least one objective check`);
  }
  // Arabic is a stated requirement: both a prompt written in Arabic and Arabic text to render.
  assert.ok(suite.prompts.some((p) => /[؀-ۿ]/.test(p.prompt) && !/[A-Za-z]{4}/.test(p.prompt)), "an Arabic-language prompt");
  assert.ok(suite.prompts.some((p) => p.dimension === "non-English text"));
  for (const id of [...suite.cloudSubset.prompts, ...suite.resolutionSubset.prompts]) assert.ok(ids.has(id), `subset names unknown prompt ${id}`);
  assert.ok(isImageModelId(suite.edits.source.model));
  assert.equal(suite.edits.instructions.length, 3);
});

test("summarize counts only judged checks and keeps picks separate", () => {
  const cells = [
    { study: "suite", model: "a", promptId: "p", seed: 1, ok: true, latencyMs: 1000, peakMiB: 100, savedPath: "x.png" },
    { study: "suite", model: "a", promptId: "p", seed: 2, ok: true, latencyMs: 3000, peakMiB: 300, savedPath: "y.png" },
    { study: "suite", model: "a", promptId: "q", seed: 1, ok: false, error: "refused" },
    { study: "suite", model: "b", promptId: "p", seed: 1, ok: true, latencyMs: 500, savedPath: "z.png" },
    { study: "edit", model: "a", promptId: "e", seed: 1, ok: true, latencyMs: 9, savedPath: "e.png" },
  ];
  const verdicts = {
    [cellKey(cells[0])]: { "five apples": true, "two pears": false, [PICK]: true },
    [cellKey(cells[1])]: { "five apples": true },
  };
  const [a, b] = summarize(cells, verdicts);
  assert.deepEqual(
    { model: a.model, images: a.images, failures: a.failures, judged: a.judged, passed: a.passed, picks: a.picks, median: a.medianLatencyMs, peak: a.maxPeakMiB },
    { model: "a", images: 2, failures: 1, judged: 3, passed: 2, picks: 1, median: 2000, peak: 300 },
  );
  assert.equal(b.judged, 0, "unjudged is unknown, not failed");
  assert.equal(b.maxPeakMiB, null);
  assert.equal(summarize(cells, verdicts, "edit").length, 1);
});

test("the Image Lab's model ids map to local models, and cloud aliases do not", () => {
  // ComfyUI's served names (host profile `serves`) are already local ids.
  for (const id of ["flux2-klein-4b", "z-image-turbo", "hidream-o1-dev", "flux-schnell"]) assert.equal(localImageModelFor(id), id);
  // The Qwen service is listed by its router alias.
  assert.equal(localImageModelFor("local-qwen-image"), "qwen-image");
  // A cloud alias must go to the router unchanged, never fall back to a local model.
  for (const id of ["gpt-image-2", "gemini-image-fast", "local-something-else"]) assert.equal(localImageModelFor(id), null);
});

test("cellKey distinguishes resolution variants of the same prompt and seed", () => {
  const base = { study: "resolution", model: "m", promptId: "p", seed: 1 };
  assert.notEqual(cellKey({ ...base, variant: "direct-2048" }), cellKey({ ...base, variant: "upscaled-1024-lanczos" }));
});
