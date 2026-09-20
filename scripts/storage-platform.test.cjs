const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");

const {
  assertDestination,
  assertManageable,
  isInside,
  isStorageRoot,
  normalizeAbsolute,
  rootOf,
} = require("./storage-indexer.cjs");

test("storage paths use the host platform instead of Windows paths everywhere", () => {
  if (process.platform === "win32") {
    assert.equal(normalizeAbsolute("c:\\Users\\Ali"), "c:\\Users\\Ali");
    assert.equal(isStorageRoot("C:\\"), true);
    assert.equal(isInside("C:\\", "C:\\Users\\Ali"), true);
    assert.equal(rootOf("C:\\Users\\Ali"), "C:\\");
    return;
  }

  assert.equal(normalizeAbsolute("/Users/Ali/../Ali"), "/Users/Ali");
  assert.equal(isStorageRoot("/"), process.platform === "darwin");
  assert.equal(isStorageRoot("/Volumes/Models"), process.platform === "darwin");
  assert.equal(isStorageRoot("/Users"), false);
  assert.equal(isInside("/", "/Users/Ali"), true);
  assert.equal(isInside("/Volumes/Models", "/Volumes/Models/qwen/model.gguf"), true);
  assert.equal(isInside("/Volumes/Models", "/Volumes/Other/model.gguf"), false);
  assert.equal(rootOf("/Users/Ali"), "/");
  assert.equal(rootOf("/Volumes/Models/qwen"), "/Volumes/Models");
});

test("storage moves keep system paths protected on macOS", { skip: process.platform !== "darwin" }, () => {
  assert.throws(() => assertManageable("/"), /drive root/i);
  assert.throws(() => assertManageable("/System/Library/CoreServices"), /protected system/i);
  assert.throws(() => assertDestination("/Applications"), /protected system/i);
  assert.equal(assertManageable(path.join("/Users", "Ali", "Downloads", "model.gguf")), "/Users/Ali/Downloads/model.gguf");
  assert.equal(assertDestination(path.join("/Users", "Ali", "Models")), "/Users/Ali/Models");
});
