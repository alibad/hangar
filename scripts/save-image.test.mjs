import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";

registerHooks({ resolve(specifier, context, next) {
  return next(specifier === "@/lib/db" ? new URL("../src/lib/db.ts", import.meta.url).href : specifier, context);
} });
const { saveImage, safeFolder } = await import("../src/lib/save-image.ts");

test("generated and edited images persist to Unfiled or the chosen nested gallery", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "betenshi-image-test-"));
  const previousOutput = process.env.QWEN_OUTPUT_DIR;
  const previousDb = globalThis.__bDb;
  const rows = [];
  process.env.QWEN_OUTPUT_DIR = root;
  globalThis.__bDb = Promise.resolve({ run: async (sql, values) => rows.push({ sql, values }) });
  t.after(async () => {
    if (previousOutput === undefined) delete process.env.QWEN_OUTPUT_DIR;
    else process.env.QWEN_OUTPUT_DIR = previousOutput;
    globalThis.__bDb = previousDb;
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("betenshi-image-test-"));
    await rm(root, { recursive: true });
  });
  for (const [kind, folder] of [["generate", ""], ["edit", "Studio Verification/Edits"]]) {
    const saved = await saveImage(Buffer.from("png-bytes"), { kind, folder, seed: 7, prompt: "test", model: "test-model" });
    assert.ok(saved);
    assert.equal(saved.dir, path.join(root, folder));
    assert.equal(await readFile(saved.path, "utf8"), "png-bytes");
    const meta = JSON.parse(await readFile(saved.path.replace(/\.png$/, ".json"), "utf8"));
    assert.equal(meta.folder, folder);
    assert.equal(rows.at(-1).values[1], saved.file);
    assert.equal(rows.at(-1).values[2], folder);
    assert.equal(rows.at(-1).values[4], kind);
  }
});

test("gallery traversal is rejected before inference", () => {
  for (const folder of ["../outside", "safe/../../outside", "C:\\outside"]) assert.equal(safeFolder(folder), null);
  assert.equal(safeFolder("Studio Verification/Edits"), "Studio Verification/Edits");
});
