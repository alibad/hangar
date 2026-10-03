import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { buildComfyImageWorkflow } from "../src/lib/comfy-image-workflows.ts";
import { getImageModel, isImageModelId } from "../src/lib/image-models.ts";

const params = { prompt: "test", width: 1024, height: 1024, seed: 7, steps: 4 };
/** Every [nodeId, slot] reference points at a node that exists. */
function assertWired(graph) {
  for (const node of Object.values(graph)) for (const value of Object.values(node.inputs)) {
    if (Array.isArray(value)) assert.ok(graph[value[0]], `Missing node ${value[0]}`);
  }
  assert.ok(Object.values(graph).some(n => n.class_type === "SaveImage"));
}

for (const model of ["flux2-klein-4b", "hidream-o1-dev", "hidream-o1", "z-image-turbo", "qwen-image-2.1"]) {
  test(`${model} has a complete native graph and a managed workload`, async () => {
    assert.ok(isImageModelId(model));
    const graph = buildComfyImageWorkflow(model, params);
    assertWired(graph);
    const policy = JSON.parse(await readFile(new URL("../config/resource-policy.json", import.meta.url)));
    const workload = Object.values(policy.workloads).find(w => w.aliases?.includes(model));
    assert.equal(workload?.service, "comfyui");
    assert.equal(workload?.slot, "gpu-heavy");
  });
}
test("Klein reference images condition the same generation checkpoint", () => {
  const graph = buildComfyImageWorkflow("flux2-klein-4b", params, ["one.png", "two.png"]);
  assert.equal(Object.values(graph).filter(n => n.class_type === "UNETLoader").length, 1);
  assert.equal(Object.values(graph).filter(n => n.class_type === "ReferenceLatent").length, 2);
  assert.deepEqual(graph[8].inputs.positive, ["25", 0]);
  assert.equal(getImageModel("flux2-klein-4b").supportsEdit, true);
  assert.equal(getImageModel("hidream-o1-dev").supportsEdit, false);
  assert.throws(() => buildComfyImageWorkflow("z-image-turbo", params, ["one.png"]));
});
test("Qwen-Image 2.1 edits by splicing references into its encoder and sampling on their latent", () => {
  const graph = buildComfyImageWorkflow("qwen-image-2.1", params, ["one.png", "two.png"]);
  assertWired(graph);
  const encode = Object.values(graph).find(n => n.class_type === "TextEncodeQwenImage21");
  assert.deepEqual(Object.keys(encode.inputs).filter(k => k.startsWith("images.")), ["images.image_1", "images.image_2"]);
  assert.ok(encode.inputs.vae, "references need the VAE to become latents");
  const sampler = Object.values(graph).find(n => n.class_type === "KSampler");
  assert.deepEqual(sampler.inputs.latent_image, ["5", 2], "the latent follows the first reference");
  // Plain generation uses its own empty latent and no VAE on the encoder.
  const t2i = buildComfyImageWorkflow("qwen-image-2.1", params);
  assert.equal(Object.values(t2i).find(n => n.class_type === "TextEncodeQwenImage21").inputs.vae, undefined);
  assert.equal(getImageModel("qwen-image-2.1").supportsEdit, true);
});
test("HiDream-O1 full edits through reference conditioning; Dev refuses references", () => {
  const graph = buildComfyImageWorkflow("hidream-o1", { ...params, steps: 40 }, ["one.png"]);
  assertWired(graph);
  const refs = Object.values(graph).find(n => n.class_type === "HiDreamO1ReferenceImages");
  assert.deepEqual(refs.inputs["images.image_1"], ["20", 0]);
  const sampler = Object.values(graph).find(n => n.class_type === "SamplerCustom");
  assert.equal(sampler.inputs.cfg, 5);
  assert.deepEqual(sampler.inputs.positive, ["12", 0]);
  assert.deepEqual(sampler.inputs.negative, ["12", 1]);
  assert.throws(() => buildComfyImageWorkflow("hidream-o1-dev", params, ["one.png"]), /generation only/);
});
test("FLUX.1 schnell is retired: not a model, and no graph", () => {
  assert.equal(isImageModelId("flux-schnell"), false);
  assert.throws(() => buildComfyImageWorkflow("flux-schnell", params));
});
test("unknown model fallback stays Qwen, independently of picker order", () => {
  assert.equal(getImageModel("missing").id, "qwen-image");
  assert.throws(() => buildComfyImageWorkflow("missing", params));
});
