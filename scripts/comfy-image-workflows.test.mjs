import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { buildComfyImageWorkflow } from "../src/lib/comfy-image-workflows.ts";
import { getImageModel, isImageModelId } from "../src/lib/image-models.ts";

const params = { prompt: "test", width: 1024, height: 1024, seed: 7, steps: 4 };
for (const model of ["flux2-klein-4b", "hidream-o1-dev", "z-image-turbo"]) {
  test(`${model} has a complete native graph and a managed workload`, async () => {
    assert.ok(isImageModelId(model));
    const graph = buildComfyImageWorkflow(model, params);
    for (const node of Object.values(graph)) for (const value of Object.values(node.inputs)) {
      if (Array.isArray(value)) assert.ok(graph[value[0]], `Missing node ${value[0]}`);
    }
    assert.ok(Object.values(graph).some(n => n.class_type === "SaveImage"));
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
test("unknown model fallback stays Qwen, independently of picker order", () => {
  assert.equal(getImageModel("missing").id, "qwen-image");
  assert.throws(() => buildComfyImageWorkflow("missing", params));
});
