import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The music gallery serves files by id (/api/music/tracks/file?id=…), so the
 * one thing it must never do is turn an id into a path outside its folder.
 * Also: a track round-trips through its sidecar, and the list is newest first.
 */
const dir = mkdtempSync(path.join(tmpdir(), "music-store-"));
process.env.MUSIC_OUTPUT_DIR = dir;
const store = await import("../src/lib/music-store.ts");

const meta = (seed) => ({ task: "text2music", seed, dit: "acestep-v15-xl-turbo", lm: null, latency_ms: 1000, audio_seconds: 30, peaks: [0, 1] });
const info = (caption, seed) => ({ caption, lyrics: "", instrumental: true, requestedDuration: 30, meta: meta(seed) });

test.after(() => rmSync(dir, { recursive: true, force: true }));

test("saveTrack writes audio + sidecar and readTrack round-trips it", async () => {
  const t = await store.saveTrack(Buffer.from("fLaC-fake"), "flac", info("lo-fi beat, Rhodes", 11));
  assert.match(t.id, /^[A-Za-z0-9._-]+$/);
  assert.ok(existsSync(path.join(dir, t.file)));
  const back = await store.readTrack(t.id);
  assert.equal(back.caption, "lo-fi beat, Rhodes");
  assert.equal(back.meta.seed, 11);
  assert.equal(back.bytes, 9);
  const p = await store.trackAudioPath(t.id);
  assert.equal(p.path, path.join(dir, t.file));
  assert.equal(p.format, "flac");
});

test("ids that could escape the folder are refused, not resolved", async () => {
  // A sidecar planted one level up must be unreachable by id.
  writeFileSync(path.join(dir, "..", "escape.json"), JSON.stringify({ id: "x", file: "x.flac", format: "flac" }));
  for (const bad of ["../escape", "..\\escape", "a/b", "", "x y", "%2e%2e"]) {
    assert.equal(await store.readTrack(bad), null, bad);
    assert.equal(await store.trackAudioPath(bad), null, bad);
    assert.equal(await store.deleteTrack(bad), false, bad);
  }
  rmSync(path.join(dir, "..", "escape.json"), { force: true });
});

test("listTracks is newest first and deleteTrack removes both files", async () => {
  await new Promise((r) => setTimeout(r, 1100)); // ids are stamped to the second
  const newer = await store.saveTrack(Buffer.from("b"), "mp3", info("second", 22));
  const list = await store.listTracks();
  assert.equal(list[0].id, newer.id);
  assert.ok(list.length >= 2);
  assert.equal(await store.deleteTrack(newer.id), true);
  assert.equal(await store.readTrack(newer.id), null);
  assert.ok(!existsSync(path.join(dir, newer.file)));
});
