import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

// Exercise the production modules in Node, resolving their bundler-style TS imports.
const scratch = await mkdtemp(path.join(tmpdir(), "hangar-audio-test-"));
process.env.AUDIO_LAB_DIR = path.join(scratch, "library");
for (const file of ["audio-project", "audio-store", "audio-origin", "labs", "workstreams"]) {
  const source = await readFile(new URL(`../src/lib/${file}.ts`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replaceAll('"./audio-project"', '"./audio-project.mjs"').replaceAll('"./labs"', '"./labs.mjs"');
  await writeFile(path.join(scratch, `${file}.mjs`), compiled);
}
const model = await import(pathToFileURL(path.join(scratch, "audio-project.mjs")));
const store = await import(pathToFileURL(path.join(scratch, "audio-store.mjs")));
const { sameAudioOrigin } = await import(pathToFileURL(path.join(scratch, "audio-origin.mjs")));
const { WORKSTREAMS, SYSTEM_LINKS } = await import(pathToFileURL(path.join(scratch, "workstreams.mjs")));
const { BUILTIN_TABS, LABS } = await import(pathToFileURL(path.join(scratch, "labs.mjs")));
const pilot = JSON.parse(await readFile(new URL("../public/audio-lab/pilot/project.json", import.meta.url), "utf8"));
test.after(async () => { await rm(scratch, { recursive: true, force: true }); });

test("all existing tools and registered Labs remain reachable through workstreams or system navigation", () => {
  const ids = [...WORKSTREAMS.flatMap(g => g.links.map(l => l.id)), ...SYSTEM_LINKS.map(l => l.id)];
  assert.equal(new Set(ids).size, ids.length);
  for (const id of BUILTIN_TABS.filter(id => !["stack", "speech"].includes(id))) assert.ok(ids.includes(id), `${id} is unreachable`);
  for (const lab of LABS) assert.ok(ids.includes(`lab-${lab.id}`));
});
test("pilot recipes accept only bounded finite controls and local audio assets", () => {
  const r = pilot.events[0].recipe;
  assert.ok(model.validateAudioRecipe(r));
  for (const patch of [{ start: -1 }, { end: 0 }, { gainDb: Infinity }, { pitch: 100 }, { url: "https://attacker.example/audio.wav" }, { url: "/api/audio-lab/asset/../../secret.wav" }]) {
    assert.equal(model.validateAudioRecipe({ ...r, layers: [{ ...r.layers[0], ...patch }] }), false);
  }
  assert.equal(model.validateAudioRecipe({ ...r, length: 999 }), false);
});
test("renders persist as separate immutable revisions; measurements come from saved PCM", async () => {
  const recipe = { ...pilot.events[0].recipe, length: .1 };
  const wav = Buffer.from(model.encodeAudioWav([new Float32Array(4800).fill(.25), new Float32Array(4800).fill(-.25)], 48000));
  const input = { event: "main-gun", name: "Tank test", recipe, peakDb: 999, rmsDb: 999, notes: "Keep the body" };
  const [a, b] = await Promise.all([store.saveAudioRevision(wav, input), store.saveAudioRevision(wav, { ...input, name: "Other variation" })]);
  assert.notEqual(a.id, b.id); assert.ok(Math.abs(a.peakDb + 12.04) < .02);
  const before = await readFile(store.audioFile(`${a.id}.wav`));
  await store.reviewAudioRevision(a.id, "approved", "Ready for a context audition");
  assert.deepEqual(await readFile(store.audioFile(`${a.id}.wav`)), before);
  const library = await store.audioLibrary();
  assert.equal(library.revisions.length, 2); assert.equal(library.revisions.find(r => r.id === a.id).status, "approved");
  assert.equal(library.revisions.find(r => r.id === b.id).status, "draft");
  await assert.rejects(store.saveAudioRevision(wav, { ...input, recipe: { ...recipe, length: 1 } }), /duration/);
  await assert.rejects(store.saveAudioRevision(Buffer.from("not a wave"), input), /Invalid/);
});
test("audio filenames cannot traverse outside the library and cross-origin writes are refused", () => {
  for (const filename of ["../secret.wav", "..\\secret.wav", "C:/secret.wav", "x.wav", "../../.env"]) assert.equal(store.audioFile(filename), null);
  assert.equal(sameAudioOrigin("http://127.0.0.1:8003", "127.0.0.1:8003"), true);
  assert.equal(sameAudioOrigin("http://attacker.example", "127.0.0.1:8003"), false);
  assert.equal(sameAudioOrigin("null", "127.0.0.1:8003"), false);
});
test("bundled pilot sources have public provenance and no commercial listening references", async () => {
  assert.equal(pilot.actor, "r2m1a2s"); assert.equal(pilot.provenance.license, "CC0 1.0");
  assert.ok(pilot.events.some(e => e.id === "engine"));
  for (const source of pilot.provenance.sources) {
    for (const s of source.sources) { assert.match(s.license, /CC0/); assert.ok(s.sha256); assert.match(s.source, /^https:\/\//); }
  }
  assert.doesNotMatch(JSON.stringify(pilot.provenance), /D:\\\\|ra2-ref|Westwood/);
});
