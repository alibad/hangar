import test from "node:test";
import assert from "node:assert/strict";
globalThis.location = { search: "", pathname: "/" };
const { layout, reconcileLayout, PLOT } = await import("../engine/world/js/layout.js");

const catalog = () => ({ families: [{ id: "studio", name: "Studio" }, { id: "tools", name: "Tools" }], repos: [
  { id: "a", name: "Alpha", family: "studio", recency: "live" },
  { id: "b", name: "Beta", family: "studio", recency: "quiet" },
  { id: "c", name: "Gamma", family: "tools", recency: "recent" },
] });
const positions = plan => plan.islands.map(s => ({ id: s.id, x: s.x, z: s.z, radius: s.radius, cells: s.cells.map(c => [c.repo.id, c.x, c.z]) }));

test("hide and restore preserve island, cell and terrain positions", () => {
  const doc = catalog(), plan = layout(doc), before = positions(plan);
  const original = plan.islands[0];
  doc.repos[0] = { ...doc.repos[0], hidden: true };
  reconcileLayout(plan, doc);
  assert.deepEqual(positions(plan), before);
  assert.equal(plan.islands[0], original);
  assert.equal(plan.islands.flatMap(s => s.cells).find(c => c.repo.id === "a").repo.hidden, true);
  doc.repos[0].hidden = false;
  reconcileLayout(plan, doc);
  assert.deepEqual(positions(plan), before);
});

test("hiding an entire island and renaming another does not repack either", () => {
  const doc = catalog(), plan = layout(doc), before = positions(plan);
  doc.repos = doc.repos.map(r => ({ ...r, hidden: r.family === "studio" }));
  doc.families = [{ id: "tools", name: "New name" }];
  reconcileLayout(plan, doc);
  assert.deepEqual(positions(plan), before);
  assert.equal(plan.islands.find(s => s.id === "tools").family.name, "New name");
  assert.ok(plan.islands.find(s => s.id === "studio").cells.every(c => c.repo.hidden));
});

test("category moves, new categories and repeat delivery keep unrelated plots stable", () => {
  const doc = catalog(), plan = layout(doc);
  const before = positions(plan).find(s => s.id === "studio");
  doc.repos[1].family = "tools";
  doc.families.push({ id: "new", name: "New category" });
  doc.repos.push({ id: "d", name: "Delta", family: "new", recency: "live" });
  reconcileLayout(plan, doc);
  const studio = plan.islands.find(s => s.id === "studio");
  assert.equal(studio.x, before.x); assert.equal(studio.z, before.z);
  assert.deepEqual(studio.cells.map(c => [c.repo.id, c.x, c.z]), before.cells.filter(c => c[0] === "a"));
  assert.equal(plan.islands.find(s => s.id === "tools").cells.filter(c => c.repo.id === "b").length, 1);
  const next = positions(plan);
  reconcileLayout(plan, structuredClone(doc));
  assert.deepEqual(positions(plan), next);
});

test("restored and newly discovered projects have unique plots inside nonoverlapping islands", () => {
  const doc = catalog(); doc.repos[0].hidden = true;
  const plan = layout(doc);
  doc.repos[0].hidden = false;
  for (let n = 0; n < 30; n++) doc.repos.push({ id: `new-${n}`, name: `New ${n}`, family: "studio", recency: "live" });
  reconcileLayout(plan, doc);
  for (const island of plan.islands) {
    for (const cell of island.cells) {
      assert.ok(Math.hypot(cell.x, cell.z) + PLOT / 2 < island.radius);
      for (const other of island.cells) if (other !== cell) assert.ok(Math.hypot(cell.x - other.x, cell.z - other.z) >= PLOT - 0.01);
    }
    for (const other of plan.islands) if (other !== island) assert.ok(Math.hypot(island.x - other.x, island.z - other.z) >= island.radius + other.radius);
  }
  assert.equal(new Set(plan.islands.flatMap(s => s.cells.map(c => c.repo.id))).size, doc.repos.length);
});

test("deleted projects disappear without disturbing remaining plot coordinates", () => {
  const doc = catalog(), plan = layout(doc), before = positions(plan);
  doc.repos = doc.repos.filter(r => r.id !== "a");
  reconcileLayout(plan, doc);
  assert.deepEqual(positions(plan), before);
  assert.equal(plan.islands.flatMap(s => s.cells).find(c => c.repo.id === "a").repo.hidden, true);
});
