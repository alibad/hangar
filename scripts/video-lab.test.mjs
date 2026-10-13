// Tests for the Video Lab's model table and ComfyUI graphs.
//
// Both modules are import-type-only TypeScript, loaded here through Node's own
// type stripping, so these check the exact files the console runs.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  VIDEO_MODELS,
  getVideoModel,
  framesFor,
  clampSeconds,
  resolutionFor,
  requiredFiles,
  videoSecondsPerMinute,
} from "../src/lib/video-models.ts";
import { buildVideoWorkflow, graphProblems } from "../src/lib/comfy-video-workflows.ts";
import { smallestRelease } from "../src/lib/gpu-holders.ts";

test("model ids are unique slugs", () => {
  const ids = VIDEO_MODELS.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[a-z0-9][a-z0-9.-]*$/);
});

test("frame counts land on each family's latent grid", () => {
  const wan5b = getVideoModel("wan2.2-ti2v-5b");
  assert.equal(framesFor(wan5b, 5), 121); // the template's default
  assert.equal((framesFor(wan5b, 10) - 1) % 4, 0);
  const wan14 = getVideoModel("wan2.2-14b");
  assert.equal(framesFor(wan14, 5), 81); // 16 fps × 5 + 1, as the template computes
  const ltx = getVideoModel("ltx-2.5");
  assert.equal(framesFor(ltx, 5), 121);
  for (const s of [3, 5, 7, 10, 15]) assert.equal((framesFor(ltx, s) - 1) % 8, 0, `ltx ${s}s`);
  const h3 = getVideoModel("minimax-h3");
  // Reproduces max(5, round(d*24)) + (5 - x % 17) % 17 from the H3 template.
  for (const s of [2, 5, 10, 15]) {
    const x = Math.max(5, Math.round(s * 24));
    assert.equal(framesFor(h3, s), x + (((5 - (x % 17)) % 17) + 17) % 17);
  }
});

test("LTX resolutions halve cleanly for the draft stage", () => {
  const ltx = getVideoModel("ltx-2.5");
  for (const r of ltx.resolutions) {
    assert.equal((r.width / 2) % 32, 0, `${r.label} width/2`);
    assert.equal((r.height / 2) % 32, 0, `${r.label} height/2`);
  }
});

test("every local resolution is a multiple of 16", () => {
  for (const m of VIDEO_MODELS.filter((x) => x.local)) {
    for (const r of m.resolutions) {
      assert.equal(r.width % 16, 0, `${m.id} ${r.label}`);
      assert.equal(r.height % 16, 0, `${m.id} ${r.label}`);
    }
  }
});

test("cloud lengths snap to what the API accepts", () => {
  const veo = getVideoModel("veo-3.1-fast");
  assert.equal(clampSeconds(veo, 10), 8);
  assert.equal(clampSeconds(veo, 5), 4); // ties go to the first allowed value
  assert.equal(clampSeconds(veo, 7), 6);
  const wan = getVideoModel("wan2.2-14b");
  assert.equal(clampSeconds(wan, 40), wan.maxSeconds);
  assert.equal(clampSeconds(wan, 0), 1);
});

test("resolutionFor falls back to the best a model has", () => {
  const hy = getVideoModel("hunyuanvideo-1.5");
  assert.equal(resolutionFor(hy, "high").tier, "low");
});

test("every local model builds a well-formed graph in every mode it claims", () => {
  for (const m of VIDEO_MODELS.filter((x) => x.local)) {
    for (const mode of m.modes) {
      const res = resolutionFor(m, "low");
      const g = buildVideoWorkflow(m, {
        mode,
        prompt: "a lighthouse at dusk, waves rolling in",
        image: mode === "i2v" ? "betenshi-video-src.png" : undefined,
        width: res.width,
        height: res.height,
        frames: framesFor(m, 5),
        seed: 7,
        prefix: "video/test",
      });
      assert.deepEqual(graphProblems(g), [], `${m.id} ${mode}`);
      // Every weight file the graph names is one the model declares.
      const declared = new Set(requiredFiles(m).map((f) => f.file));
      for (const node of Object.values(g)) {
        for (const key of ["unet_name", "clip_name", "clip_name1", "clip_name2", "vae_name", "lora_name", "model_name"]) {
          const v = node.inputs[key];
          if (typeof v === "string" && v.endsWith(".safetensors")) assert.ok(declared.has(v), `${m.id} ${mode}: ${v} not in files`);
        }
      }
      // i2v graphs load the image; t2v graphs must not.
      const loads = Object.values(g).some((n) => n.class_type === "LoadImage");
      assert.equal(loads, mode === "i2v", `${m.id} ${mode} LoadImage`);
    }
  }
});

test("audio models wire a soundtrack into the video", () => {
  for (const m of VIDEO_MODELS.filter((x) => x.local)) {
    const res = resolutionFor(m, "low");
    const g = buildVideoWorkflow(m, { mode: "t2v", prompt: "x", width: res.width, height: res.height, frames: framesFor(m, 5), seed: 1, prefix: "p" });
    const create = Object.values(g).find((n) => n.class_type === "CreateVideo");
    assert.equal("audio" in create.inputs, m.audio, m.id);
  }
});

test("i2v without an image is refused before any work is queued", () => {
  const m = getVideoModel("wan2.2-ti2v-5b");
  assert.throws(() => buildVideoWorkflow(m, { mode: "i2v", prompt: "x", width: 832, height: 480, frames: 81, seed: 1, prefix: "p" }), /source image/);
});

test("smallestRelease picks the fewest things to stop, then the least disruptive", () => {
  const h = (id, vramGb, ramGb) => ({ id, kind: "service", label: id, detail: "", vramGb, ramGb });
  const vllm = h("vllm", 18, 2);
  const qwen = h("qwen", 0, 28);
  const bonsai = h("bonsai", 14, 2);
  const ollama = h("gemma4", 20, 0);
  const all = [vllm, qwen, bonsai, ollama];
  assert.deepEqual(smallestRelease(all, 0, 0), []);
  // One VRAM holder is enough; the smaller of the sufficient ones is chosen.
  assert.deepEqual(smallestRelease(all, 15, 0).map((x) => x.id), ["vllm"]);
  // VRAM and RAM both short: two things, and not three.
  assert.deepEqual(smallestRelease(all, 15, 20).map((x) => x.id).sort(), ["qwen", "vllm"]);
  // More than everything together can give: null, so the Lab says it is held elsewhere.
  assert.equal(smallestRelease(all, 60, 0), null);
  // Holders that free nothing are never suggested.
  assert.deepEqual(smallestRelease([h("comfyui", 0, 0), bonsai], 10, 0).map((x) => x.id), ["bonsai"]);
});

test("seconds per minute", () => {
  assert.equal(videoSecondsPerMinute(5, 60_000), 5);
  assert.equal(videoSecondsPerMinute(10, 300_000), 2);
  assert.equal(videoSecondsPerMinute(5, 0), null);
});
