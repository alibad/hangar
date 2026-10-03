import assert from "node:assert/strict";
import test from "node:test";
import { ancestors, folderRows, inFolder, isLabStorage, LAB_STORAGE_ROOTS, subtreeCounts, treeOrder } from "../src/lib/gallery-folders.ts";

// The real tree from the screenshot that prompted this: the 3D Lab's job folders
// rendered under "3d-bench" because '-' sorts before '/'.
const FOLDERS = [
  "3d", "3d-bench", "3d/20260927-190100-bench-stump-b1", "3d/20260928-231317-a-street-dancer-mid-move-41rm",
  "Compare", "RTS AI", "RTS AI/china", "RTS AI/china/r2qilin", "RTS AI/yemen", "RTS AI/yemen/r2technical", "Empty One",
];
const DIRECT = new Map([["", 18], ["3d-bench", 9], ["Compare", 6], ["RTS AI/china/r2qilin", 6], ["RTS AI/yemen/r2technical", 10]]);

test("children follow their own parent, not a sibling that sorts between them", () => {
  const order = treeOrder(FOLDERS);
  assert.deepEqual(order.slice(0, 4), ["3d", "3d/20260927-190100-bench-stump-b1", "3d/20260928-231317-a-street-dancer-mid-move-41rm", "3d-bench"]);
  assert.ok(order.indexOf("RTS AI/china/r2qilin") < order.indexOf("RTS AI/yemen"));
});

test("a parent counts everything beneath it", () => {
  const c = subtreeCounts(FOLDERS, DIRECT);
  assert.equal(c.get("RTS AI"), 16);
  assert.equal(c.get("RTS AI/china"), 6);
  assert.equal(c.get("3d"), 0);
  assert.equal(c.has(""), false, "Unfiled is not a folder row");
});

test("empty folders are hidden by default and counted", () => {
  const { rows, hiddenEmpty } = folderRows({ folders: FOLDERS, direct: DIRECT, expanded: new Set(), showEmpty: false });
  assert.deepEqual(rows.map((r) => r.path), ["3d-bench", "Compare", "RTS AI"]);
  assert.equal(hiddenEmpty, 4, "3d, its two jobs, and Empty One");
  assert.equal(rows.find((r) => r.path === "RTS AI").hasChildren, true);
  assert.equal(rows.find((r) => r.path === "RTS AI").expanded, false);
});

test("expanding shows children; showEmpty shows everything", () => {
  const expanded = new Set(["RTS AI", "RTS AI/china"]);
  const { rows } = folderRows({ folders: FOLDERS, direct: DIRECT, expanded, showEmpty: false });
  assert.deepEqual(rows.map((r) => [r.path, r.depth]), [["3d-bench", 0], ["Compare", 0], ["RTS AI", 0], ["RTS AI/china", 1], ["RTS AI/china/r2qilin", 2], ["RTS AI/yemen", 1]]);
  const all = folderRows({ folders: FOLDERS, direct: DIRECT, expanded: new Set(["3d"]), showEmpty: true });
  assert.equal(all.hiddenEmpty, 0);
  assert.ok(all.rows.some((r) => r.path === "3d/20260927-190100-bench-stump-b1"));
});

test("the selected or just-created folder stays visible, with its ancestors opened", () => {
  const { rows } = folderRows({ folders: [...FOLDERS, "RTS AI/new"], direct: DIRECT, expanded: new Set(), showEmpty: false, keep: ["RTS AI/new"] });
  const paths = rows.map((r) => r.path);
  assert.ok(paths.includes("RTS AI/new"));
  assert.equal(rows.find((r) => r.path === "RTS AI").expanded, true);
  assert.ok(!paths.includes("Empty One"));
});

test("helpers", () => {
  assert.deepEqual(ancestors("a/b/c"), ["a", "a/b"]);
  assert.deepEqual(ancestors("a"), []);
  assert.equal(inFolder("RTS AI/china", "RTS AI"), true);
  assert.equal(inFolder("RTS AIx", "RTS AI"), false);
  assert.equal(inFolder("3d-bench", "3d"), false);
});

test("a folder with images on disk but not indexed is not 'empty', and says how many", () => {
  // RTS AI's images were written straight to disk with sidecars, never through the gallery.
  const onDisk = new Map([["RTS AI/china/r2qilin", 6], ["Compare", 6]]);
  const { rows } = folderRows({ folders: FOLDERS, direct: new Map([["Compare", 6]]), onDisk, expanded: new Set(), showEmpty: false });
  const rts = rows.find((r) => r.path === "RTS AI");
  assert.ok(rts, "RTS AI stays listed");
  assert.equal(rts.count, 0);
  assert.equal(rts.unindexed, 6);
  assert.equal(rows.find((r) => r.path === "Compare").unindexed, 0);
});

test("lab storage roots match the labs' own constants", async () => {
  const { MESH_ROOT } = await import("../src/lib/mesh3d-shared.ts");
  assert.ok(LAB_STORAGE_ROOTS.includes(MESH_ROOT));
  assert.equal(isLabStorage("3d/20260927-190100-bench-stump-b1"), true);
  assert.equal(isLabStorage("video/sources"), true);
  assert.equal(isLabStorage("3d-bench"), false);
  assert.equal(isLabStorage("videos"), false);
});
