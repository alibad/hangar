import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";
import {
  factionFor, isInside, kindOf, pickItems, pngText, promptFromComfy, promptFromSidecar, readReview, reviewStatus,
  spread, studioFor, yamlActors,
} from "../src/lib/library-classify.ts";

test("kinds by extension; .ply is left out beside its .glb", () => {
  assert.equal(kindOf("a.PNG"), "image");
  assert.equal(kindOf("clip.mp4"), "video");
  assert.equal(kindOf("boom.ogg"), "sound");
  assert.equal(kindOf("mesh.glb"), "model");
  assert.equal(kindOf("mesh.ply"), null);
  assert.equal(kindOf("meta.json"), null);
});

test("a 3D job shows its models with the cutout as poster, not its input pictures", () => {
  // The real layout of D:\Generated\Hangar\3d\<job>.
  const { items } = pickItems(["cutout.png", "meta.json", "pixal3d-1024-s42.glb", "source.png", "triposr-256-s42.glb"]);
  assert.deepEqual(items.map((i) => [i.name, i.kind, i.poster]), [
    ["pixal3d-1024-s42.glb", "model", "cutout.png"],
    ["triposr-256-s42.glb", "model", "cutout.png"],
  ]);
});

test("model-forge drafts use mesh_cutout as poster and skip the .ply", () => {
  const { items } = pickItems(["generation.log", "mesh.glb", "mesh.ply", "mesh_base.png", "mesh_cutout.png"]);
  assert.deepEqual(items.map((i) => [i.name, i.poster]), [["mesh.glb", "mesh_cutout.png"]]);
});

test("a clip's same-name still is its poster; art-desk previews are not candidates", () => {
  const clip = pickItems(["fight.mp4", "fight.jpg", "map.jpg"]);
  assert.deepEqual(clip.items.map((i) => [i.name, i.poster]), [["fight.mp4", "fight.jpg"], ["map.jpg", null]]);
  const desk = pickItems(["cameo.png", "master.png", "meta.json", "preview-cameo-x4.png", "preview-master.png"]);
  assert.deepEqual(desk.items.map((i) => i.name), ["cameo.png", "master.png"]);
});

test("studio from where Hangar's settings put each output", () => {
  const dirs = { gallery: "C:\\hangar\\generated", archive: "C:\\hangar\\archive", music: "C:\\hangar\\generated-music", effects: "C:\\hangar\\var\\audio-lab" };
  assert.equal(studioFor("C:\\hangar\\generated\\Misc\\a.png", "image", dirs), "image");
  assert.equal(studioFor("C:\\hangar\\generated\\video\\2026-10-01\\x.mp4", "video", dirs), "video");
  assert.equal(studioFor("C:\\hangar\\generated\\forge\\x.png", "image", dirs), "forge");
  assert.equal(studioFor("C:\\hangar\\generated-music\\x.flac", "sound", dirs), "music");
  assert.equal(studioFor("C:\\hangar\\archive\\2026-10-08\\x.png", "image", dirs), "image");
  // After the move the same layout lives on D:.
  const moved = { gallery: "D:\\Generated\\Hangar", archive: "D:\\Generated\\Hangar\\archive", music: "D:\\Generated\\Hangar\\music", effects: "D:\\Generated\\Hangar\\effects" };
  assert.equal(studioFor("D:\\Generated\\Hangar\\3d\\job\\m.glb", "model", moved), "3d");
  assert.equal(studioFor("D:\\Generated\\Hangar\\music\\x.flac", "sound", moved), "music");
  assert.equal(studioFor("D:\\Generated\\ComfyUI output\\betenshi-video\\v.mp4", "video", moved), "video");
  assert.equal(studioFor("D:\\Videos\\MoveQuest\\x.mp4", "video", moved), null);
});

test("isInside compares Windows paths whatever their case and slashes", () => {
  assert.ok(isInside("d:/generated/hangar/3d", "D:\\Generated"));
  assert.ok(!isInside("D:\\GeneratedOld\\x", "D:\\Generated"));
});

const REVIEW = readReview({
  r2qilin: { slots: { model: { chosen: "sprite-v6-prerender", rejected: [] }, icon: { chosen: "cameo-v3-render", rejected: ["cameo-v1"] }, concept: { chosen: null, rejected: [] } } },
});

test("review.json decides approved, rejected or draft for art-desk candidates", () => {
  const at = (c) => `C:\\Code\\RTSAI-Art\\units\\r2qilin\\candidates\\${c}\\cameo.png`;
  assert.equal(reviewStatus(at("cameo-v3-render"), REVIEW, null), "approved");
  assert.equal(reviewStatus(at("cameo-v1"), REVIEW, null), "rejected");
  assert.equal(reviewStatus(at("cameo-v10"), REVIEW, null), "draft");
});

test("everything in the drafts folder is a draft, and other folders have no status", () => {
  assert.equal(reviewStatus("D:\\Generated\\RTSAI\\art\\model-forge\\r2qilin\\mesh.glb", REVIEW, "D:\\Generated\\RTSAI"), "draft");
  assert.equal(reviewStatus("D:\\Generated\\Hangar\\Misc\\a.png", REVIEW, "D:\\Generated\\RTSAI"), null);
});

test("faction from a faction folder first, then from the unit", () => {
  const factions = new Set(["china", "yemen"]);
  const units = new Map([["r2qilin", "china"], ["r2technical", "yemen"]]);
  assert.equal(factionFor("D:\\Generated\\RTSAI\\yemen\\art\\x.png", factions, units), "yemen");
  assert.equal(factionFor("C:\\Code\\RTSAI-Art\\units\\r2qilin\\candidates\\c\\cameo.png", factions, units), "china");
  assert.equal(factionFor("D:\\Videos\\RTSAI\\campaign-footage\\black-platform\\a.mp4", factions, units), null);
});

test("actors are a rules file's top-level keys", () => {
  assert.deepEqual(yamlActors("R2QILIN:\n\tInherits: ^Tank\nR2ZBD:  # amphibious\n\tBuildable:\n"), ["r2qilin", "r2zbd"]);
});

test("prompts from each studio's sidecar", () => {
  assert.deepEqual(promptFromSidecar({ prompt: "a lone lighthouse", model: "hidream-o1" }), { prompt: "a lone lighthouse", model: "hidream-o1" });
  assert.deepEqual(promptFromSidecar({ caption: "cinematic ambient bed" }), { prompt: "cinematic ambient bed", model: null });
  assert.deepEqual(promptFromSidecar({ subject: "a plush toy dinosaur", meshes: [{ model: "triposr" }] }), { prompt: "a plush toy dinosaur", model: "triposr" });
});

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  return out;
}

test("ComfyUI's prompt graph read from a PNG's text chunks", () => {
  const graph = JSON.stringify({
    3: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "flux2-klein-4b.safetensors" } },
    6: { class_type: "CLIPTextEncode", inputs: { text: "a red fox in snow" } },
    7: { class_type: "CLIPTextEncode", inputs: { text: "" } },
  });
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", Buffer.alloc(13)),
    chunk("tEXt", Buffer.from(`prompt\0${graph}`, "latin1")),
    chunk("zTXt", Buffer.concat([Buffer.from("note\0\0", "latin1"), deflateSync("compressed words")])),
    chunk("IDAT", Buffer.alloc(4)),
  ]);
  const text = pngText(png);
  assert.equal(text.note, "compressed words");
  assert.deepEqual(promptFromComfy(text.prompt), { prompt: "a red fox in snow", model: "flux2-klein-4b.safetensors" });
});

test("collection samples are spread through the set, not its first frames", () => {
  const list = Array.from({ length: 1000 }, (_, i) => i);
  const picks = spread(list, 4);
  assert.equal(picks.length, 4);
  assert.ok(picks[0] > 50 && picks[3] > 800);
});
