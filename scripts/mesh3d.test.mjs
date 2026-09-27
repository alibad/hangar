import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { applyMask } from "../src/lib/mesh3d-image.ts";
import { DETAIL, bodyGlb, capabilityFor, glbName, isJobId, lastNoun, latestByFile, meshWorkload, objectPrompt, orientGlb, personBox, personPrompt, resolutionFor, servableRel } from "../src/lib/mesh3d-shared.ts";

/**
 * The 3D Lab serves files straight off disk by a client-supplied path, and
 * finds its mesh services and their resource workloads by convention rather
 * than by name. Both are the kind of thing that fails silently — a traversal
 * that works, a Lab that lists a model the coordinator then refuses as an
 * unknown workload — so they are pinned here.
 */

const read = (rel) => JSON.parse(readFileSync(new URL(`../${rel}`, import.meta.url), "utf8"));

test("servableRel: only .png/.glb/.json directly inside a 3d job folder", () => {
  const job = "20260927-190000-drill-ab12";
  assert.equal(servableRel(`3d/${job}/cutout.png`), `3d/${job}/cutout.png`);
  assert.equal(servableRel(`3d/${job}/trellis-2-1024-s42.glb`), `3d/${job}/trellis-2-1024-s42.glb`);
  assert.equal(servableRel(`3d\\${job}\\meta.json`), `3d/${job}/meta.json`, "Windows separators are normalised");
  for (const bad of [
    `3d/${job}/../../.env`,
    `3d/../secrets.png`,
    `3d/${job}/sub/x.png`,
    `gallery/${job}/x.png`,
    `3d/${job}/x.exe`,
    `3d/not-a-job/x.png`,
    "",
    null,
  ]) {
    assert.equal(servableRel(bad), null, `refused: ${bad}`);
  }
});

test("isJobId: accepts what newJob mints, refuses anything path-like", () => {
  assert.ok(isJobId("20260927-190000-cartoon-fox-x9z1"));
  for (const bad of ["../x", "20260927-190000-", "20260927-190000-A", "20260927-190000-a/b", 42, null]) {
    assert.ok(!isJobId(bad), String(bad));
  }
});

test("lastNoun: the SAM 3 concept is the head noun, not the last word", () => {
  assert.equal(lastNoun("a cordless power drill"), "drill");
  assert.equal(lastNoun("a wooden windsor chair with thin turned spindles and splayed legs"), "chair");
  assert.equal(lastNoun("a gnarled old tree stump with exposed roots and patches of moss"), "stump");
  assert.equal(lastNoun("a cartoon fox, full body"), "fox", "clauses after a comma are styling, not the object");
  assert.equal(lastNoun("a knight standing on a rock"), "knight");
  assert.equal(lastNoun(""), "");
});

test("objectPrompt keeps the subject first and asks for an isolated single object", () => {
  const p = objectPrompt("  a brass desk lamp ");
  assert.ok(p.startsWith("a brass desk lamp,"));
  assert.match(p, /single object/);
  assert.match(p, /plain .* background/);
});

test("resolutionFor: TRELLIS-family voxels vs TripoSR marching-cubes grid", () => {
  assert.equal(resolutionFor("trellis-2", "standard"), 1024);
  assert.equal(resolutionFor("pixal3d", "high"), 1536);
  assert.equal(resolutionFor("pixal3d", "draft"), 1024, "Pixal3D has no 512 texture flow");
  assert.equal(resolutionFor("triposr", "draft"), 256, "TripoSR is ~2 s at any grid, so Draft is the measured 256");
  assert.deepEqual(DETAIL.map((d) => d.id), ["draft", "standard", "high"]);
});

/** A minimal valid GLB: one scene, two root nodes, a 4-byte BIN chunk. */
function tinyGlb() {
  const json = new TextEncoder().encode(JSON.stringify({ asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0, 1] }], nodes: [{ name: "a" }, { name: "b" }] }));
  const jl = Math.ceil(json.length / 4) * 4;
  const out = new Uint8Array(12 + 8 + jl + 8 + 4);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, out.length, true);
  dv.setUint32(12, jl, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.fill(0x20, 20, 20 + jl);
  out.set(json, 20);
  dv.setUint32(20 + jl, 4, true);
  dv.setUint32(24 + jl, 0x004e4942, true); // "BIN\0"
  out.set([1, 2, 3, 4], 28 + jl);
  return out;
}

function readGlb(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const jl = dv.getUint32(12, true);
  return { total: dv.getUint32(8, true), jl, json: JSON.parse(new TextDecoder().decode(u8.subarray(20, 20 + jl))), bin: u8.subarray(20 + jl) };
}

test("orientGlb wraps the scene in one rotated root and leaves the binary untouched", () => {
  const src = tinyGlb();
  const out = orientGlb(src, "-z");
  const a = readGlb(src);
  const b = readGlb(out);
  assert.equal(b.total, out.length, "header length is the file length");
  assert.equal(b.jl % 4, 0, "JSON chunk stays 4-byte aligned");
  const root = b.json.nodes[b.json.scenes[0].nodes[0]];
  assert.deepEqual(b.json.scenes[0].nodes, [2]);
  assert.deepEqual(root.children, [0, 1]);
  assert.deepEqual(root.rotation.map((v) => Math.round(v * 1e4) / 1e4), [0.7071, 0, 0, 0.7071], "+90° about X turns -Z up into +Y");
  assert.deepEqual([...b.bin], [...a.bin], "BIN chunk byte-identical");
  assert.equal(orientGlb(new Uint8Array([1, 2, 3]), "-z").length, 3, "not a GLB: returned as-is");
});

test("applyMask: the cutout really carries SAM 3's mask as alpha, cropped square", async () => {
  // Regression: removeAlpha() + joinChannel() in one sharp pipeline stripped the
  // mask again, and the 3-channel "cutout" went unnoticed because every mesh
  // model quietly mattes an image that has no alpha.
  const W = 200, H = 100;
  const image = await sharp({ create: { width: W, height: H, channels: 3, background: "#3366cc" } }).png().toBuffer();
  const mask = await sharp({ create: { width: W, height: H, channels: 3, background: "#000" } })
    .composite([{ input: await sharp({ create: { width: 40, height: 40, channels: 3, background: "#fff" } }).png().toBuffer(), left: 80, top: 30 }])
    .png()
    .toBuffer();
  const out = await applyMask(image, mask, [80, 30, 120, 70]);
  const meta = await sharp(out).metadata();
  assert.equal(meta.channels, 4, "RGBA");
  assert.equal(meta.width, 1024);
  assert.equal(meta.height, 1024);
  const { data } = await sharp(out).extractChannel(3).raw().toBuffer({ resolveWithObject: true });
  assert.equal(data[512 * 1024 + 512], 255, "the object (centre) is opaque");
  assert.equal(data[5 * 1024 + 5], 0, "the margin (corner) is transparent");
});

test("bodyGlb: a valid GLB, turned Y-up facing the viewer, with normals", () => {
  // A tetrahedron in SAM 3D Body's camera frame (y down, z away from camera).
  const verts = [[0, 0, 1], [1, 0, 1], [0, -1, 1], [0, 0, 2]];
  const faces = [[0, 1, 2], [0, 3, 1], [0, 2, 3], [1, 3, 2]];
  const glb = bodyGlb(verts, faces);
  const { total, json, bin } = readGlb(glb);
  assert.equal(total, glb.length);
  const binLen = new DataView(bin.buffer, bin.byteOffset).getUint32(0, true);
  assert.equal(binLen, json.buffers[0].byteLength, "BIN chunk length matches buffers[0]");
  assert.equal(json.accessors[0].count, 4);
  assert.equal(json.accessors[2].count, 12);
  const pos = new Float32Array(bin.buffer.slice(bin.byteOffset + 8, bin.byteOffset + 8 + 48));
  assert.deepEqual([...pos.slice(6, 9)], [0, 1, -1], "(0,-1,1) -> (0,1,-1): 180° about X");
  assert.deepEqual(json.accessors[0].min, [0, 0, -2]);
  assert.ok(json.meshes[0].primitives[0].attributes.NORMAL === 1, "has normals");
});

test("personBox: normalised, grown by a margin, clamped to the image", () => {
  assert.deepEqual(personBox([100, 100, 300, 500], 1000, 1000, 0.1), [0.08, 0.06, 0.32, 0.54]);
  assert.deepEqual(personBox([0, 0, 1000, 1000], 1000, 1000), [0, 0, 1, 1]);
});

test("capabilityFor / personPrompt: Person mode draws on 3d-body and asks for a whole person", () => {
  assert.equal(capabilityFor("person"), "3d-body");
  assert.equal(capabilityFor("object"), "3d");
  assert.match(personPrompt("a dancer mid-leap"), /^a dancer mid-leap, one person only, full body/);
});

test("every host service that serves 3d-body has a guarding workload and a licensed model-meta entry", () => {
  const policy = read("config/resource-policy.json");
  const meta = read("config/model-meta.json");
  const profile = read("config/hosts/betenshi.json");
  const body = profile.services.filter((s) => s.serves?.["3d-body"]);
  assert.ok(body.length, "the 3D Lab's Person mode needs a 3d-body service on BeTenshi");
  for (const svc of body) {
    assert.ok(Object.values(policy.workloads).some((w) => w.service === svc.id), `${svc.id}: no workload guards it (workloadFor would find none)`);
    for (const model of [svc.serves["3d-body"]].flat()) {
      const m = meta[`local-${model}`] ?? meta[model];
      assert.ok(m?.license, `${model}: licence not declared`);
      assert.ok(m.footprint?.vramGb > 0, `${model}: no VRAM footprint, so the coordinator cannot plan around it`);
    }
  }
});

test("latestByFile: a re-run under the same name replaces the older record", () => {
  // Regression: two body runs without a pick both wrote sam-3d-body.glb and
  // the job listed the same body twice.
  const out = latestByFile([
    { file: "sam-3d-body.glb", latencyMs: 4450 },
    { file: "sam-3d-body-picked.glb", latencyMs: 1170 },
    { file: "sam-3d-body.glb", latencyMs: 2800 },
  ]);
  assert.deepEqual(out.map((m) => [m.file, m.latencyMs]), [
    ["sam-3d-body-picked.glb", 1170],
    ["sam-3d-body.glb", 2800],
  ]);
});

test("glbName is a safe, descriptive file name", () => {
  assert.equal(glbName("trellis-2", 1024, 42), "trellis-2-1024-s42.glb");
  assert.equal(glbName("Tripo SR", null, 7), "tripo-sr-default-s7.glb");
  assert.ok(servableRel(`3d/20260927-190000-x-1/${glbName("pixal3d", 1536, 3)}`));
});

test("every host service that serves 3d has a resource workload, a start command and model-meta", () => {
  const policy = read("config/resource-policy.json");
  const meta = read("config/model-meta.json");
  const commands = read("scripts/service-commands.json");
  for (const host of ["betenshi", "b5"]) {
    let profile;
    try {
      profile = read(`config/hosts/${host}.json`);
    } catch {
      continue;
    }
    for (const svc of profile.services.filter((s) => s.serves?.["3d"])) {
      const served = [svc.serves["3d"]].flat();
      const workload = policy.workloads[meshWorkload(svc.id)];
      assert.ok(workload, `${host}/${svc.id}: no "${meshWorkload(svc.id)}" workload — every mesh request would be refused as unknown`);
      assert.equal(workload.service, svc.id);
      if (host === "betenshi") assert.ok(commands[svc.id]?.cmd, `${svc.id}: no start command in service-commands.json`);
      for (const model of served) {
        const m = meta[`local-${model}`] ?? meta[model];
        assert.ok(m, `${svc.id}: no model-meta entry for "${model}"`);
        assert.ok(m.license, `${model}: licence not declared`);
        assert.ok(m.footprint?.vramGb > 0, `${model}: no VRAM footprint`);
      }
      if (served.length > 1) {
        for (const model of served) assert.ok(svc.modelParam?.[model], `${svc.id} hosts several models; modelParam must name "${model}"`);
      }
    }
  }
});
