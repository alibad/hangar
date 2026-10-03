import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { buildComfyImageWorkflow, buildIdeogramCaptionGraph, repairIdeogramCaption } from "../src/lib/comfy-image-workflows.ts";
import { getImageModel, isImageModelId } from "../src/lib/image-models.ts";

const params = { prompt: "test", width: 1024, height: 1024, seed: 7, steps: 4 };
/** Every [nodeId, slot] reference points at a node that exists. */
function assertWired(graph) {
  for (const node of Object.values(graph)) for (const value of Object.values(node.inputs)) {
    if (Array.isArray(value)) assert.ok(graph[value[0]], `Missing node ${value[0]}`);
  }
  assert.ok(Object.values(graph).some(n => n.class_type === "SaveImage"));
}

for (const model of ["flux2-klein-4b", "hidream-o1-dev", "hidream-o1", "z-image-turbo", "qwen-image-2.1", "ideogram-4", "ming-image"]) {
  test(`${model} has a complete native graph and a managed workload`, async () => {
    assert.ok(isImageModelId(model));
    const graph = buildComfyImageWorkflow(model, { ...params, caption: '{"high_level_description":"x"}' });
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

test("HiDream-O1 edits on a ~4 MP canvas at the source's aspect (a 1024² canvas returned noise)", () => {
  const canvas = (w, h, refs) => buildComfyImageWorkflow("hidream-o1", { ...params, width: w, height: h }, refs)["4"].inputs;
  assert.deepEqual([canvas(1024, 1024, ["a.png"]).width, canvas(1024, 1024, ["a.png"]).height], [2048, 2048]);
  const wide = canvas(1536, 1024, ["a.png"]);
  assert.ok(wide.width === 2048 && wide.height >= 1600 && wide.height % 32 === 0, `wide edit canvas ${wide.width}x${wide.height}`);
  assert.deepEqual([canvas(1024, 1024, []).width, canvas(1024, 1024, []).height], [1024, 1024], "generation keeps the asked size");
});
test("FLUX.1 schnell is retired: not a model, and no graph", () => {
  assert.equal(isImageModelId("flux-schnell"), false);
  assert.throws(() => buildComfyImageWorkflow("flux-schnell", params));
});
test("unknown model fallback stays Qwen, independently of picker order", () => {
  assert.equal(getImageModel("missing").id, "qwen-image");
  assert.throws(() => buildComfyImageWorkflow("missing", params));
});

test("Ideogram 4 samples two transformers on a caption it is given; the caption is its own seeded job", () => {
  const caption = '{"aspect_ratio":"2:3","high_level_description":"A sign"}';
  const graph = buildComfyImageWorkflow("ideogram-4", { ...params, width: 1000, height: 1500, caption });
  assertWired(graph);
  const unets = Object.values(graph).filter(n => n.class_type === "UNETLoader").map(n => n.inputs.unet_name);
  assert.deepEqual(unets.sort(), ["ideogram4_fp8_scaled.safetensors", "ideogram4_unconditional_fp8_scaled.safetensors"]);
  assert.ok(Object.values(graph).find(n => n.class_type === "DualModelGuider").inputs.model_negative, "the unconditional model is the negative branch");
  assert.equal(Object.values(graph).find(n => n.class_type === "CLIPTextEncode").inputs.text, caption);
  assert.ok(!Object.values(graph).some(n => n.class_type === "TextGenerate"), "no LLM inside the image graph");
  assert.equal(Object.values(graph).find(n => n.class_type === "EmptyFlux2LatentImage").inputs.width, 1008);
  assert.throws(() => buildComfyImageWorkflow("ideogram-4", params), /structured caption/);
  assert.throws(() => buildComfyImageWorkflow("ideogram-4", { ...params, caption }, ["ref.png"]), /generation only/);

  const writer = buildIdeogramCaptionGraph(
    { prompt: 'A sign reading "مرحبا"', width: 1000, height: 1500, seed: 7 },
    { system: "RULES", user: "TARGET IMAGE ASPECT RATIO: {{ratio}} (width:height).\nUser idea: {{original_prompt}}" },
  );
  const gen = Object.values(writer).find(n => n.class_type === "TextGenerate");
  assert.equal(gen.inputs.system_prompt, "RULES");
  assert.equal(gen.inputs.prompt, 'TARGET IMAGE ASPECT RATIO: 2:3 (width:height).\nUser idea: A sign reading "مرحبا"', "requested ratio, prompt verbatim");
  assert.equal(gen.inputs["sampling_mode.seed"], 7, "seeded, so a seed reproduces its caption");
  assert.ok(Object.values(writer).some(n => n.class_type === "PreviewAny"));

  // The transparent-background rule goes to the writer only when the idea asks for it.
  const rules = { system: "RULES", user: "{{ratio}} {{original_prompt}}", transparent: "TRANSPARENCY RULE" };
  const sys = (prompt) => Object.values(buildIdeogramCaptionGraph({ prompt, width: 1024, height: 1024, seed: 1 }, rules)).find(n => n.class_type === "TextGenerate").inputs.system_prompt;
  assert.equal(sys("Four friends at a café table"), "RULES");
  assert.equal(sys("A fox sticker, transparent background"), "RULES\n\nTRANSPARENCY RULE");
});

test("Ideogram captions are repaired the ways the 8B writer actually breaks them", () => {
  // Measured 3 Oct: split into two objects, and a transparent background nobody asked for.
  const split = '{"aspect_ratio":"1:1","high_level_description":"Four friends laughing at a café table, on a transparent background."}\n\n{"compositional_deconstruction":{"background":"transparent background","elements":[{"type":"obj","bbox":[200,150,800,850],"desc":"four friends"}]}}';
  const r = repairIdeogramCaption(split, "Candid photograph of four friends at a café table", 1024, 1024);
  assert.ok(r.ok);
  const c = JSON.parse(r.caption);
  assert.equal(c.high_level_description, "Four friends laughing at a café table.");
  assert.equal(c.compositional_deconstruction.background, "Four friends laughing at a café table.");
  assert.equal(c.compositional_deconstruction.elements.length, 1);
  assert.equal(c.aspect_ratio, "1:1");
  assert.ok(r.repairs.some(x => /merged 2/.test(x)));

  // Asked for: transparency is kept.
  const sticker = repairIdeogramCaption('{"high_level_description":"A fox sticker on a transparent background","compositional_deconstruction":{"background":"transparent background","elements":[]}}', "a fox sticker, transparent background", 1024, 1024);
  assert.equal(JSON.parse(sticker.caption).compositional_deconstruction.background, "transparent background");

  // Fenced, wrong ratio; and nothing usable.
  const fenced = repairIdeogramCaption('```json\n{"aspect_ratio":"16:9","high_level_description":"A poster","compositional_deconstruction":{"background":"off-white paper","elements":[]}}\n```', "a poster", 1024, 1536);
  assert.equal(JSON.parse(fenced.caption).aspect_ratio, "2:3");
  assert.equal(JSON.parse(fenced.caption).compositional_deconstruction.background, "off-white paper");
  assert.equal(repairIdeogramCaption("I cannot help with that.", "x", 1024, 1024).ok, false);
});

test("Ming-Image edits through its own encoder node with LCM, and generates with euler", () => {
  const gen = buildComfyImageWorkflow("ming-image", params);
  assertWired(gen);
  assert.ok(Object.values(gen).some(n => n.class_type === "CLIPTextEncode"));
  assert.ok(Object.values(gen).some(n => n.class_type === "KSamplerSelect"));
  const edit = buildComfyImageWorkflow("ming-image", params, ["one.png", "two.png"]);
  assertWired(edit);
  const enc = Object.values(edit).find(n => n.class_type === "TextEncodeMingImageEdit");
  assert.ok(enc.inputs["images.image_1"] && enc.inputs["images.image_2"] && enc.inputs.vae);
  assert.ok(Object.values(edit).some(n => n.class_type === "SamplerLCM"));
});
