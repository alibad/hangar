import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { WORLD_STYLES, isWorldStyle, worldStyleById } from "../engine/world/js/world-styles.js";
globalThis.location = { search: "", pathname: "/" };
const { buildProjectForm, createFormGeometry, formLevel } = await import("../engine/world/js/project-forms.js");
const { dressIsland, environmentKey } = await import("../engine/world/js/environments.js");
const styles = WORLD_STYLES.filter(style => !["buildings", "airplanes"].includes(style.id));

test("ten new worlds use the same persisted registry as the viewer and host", () => {
  assert.equal(styles.length, 10);
  assert.equal(new Set(WORLD_STYLES.map(s => s.id)).size, 12);
  assert.equal(isWorldStyle("stale-value"), false);
  assert.equal(isWorldStyle(null), false);
  assert.equal(worldStyleById("stale-value").id, "buildings");
  for (const style of WORLD_STYLES) { assert.ok(isWorldStyle(style.id)); assert.ok(style.growth && style.object); }
});

const forms = createFormGeometry();
const box = new THREE.BoxGeometry(1, 1, 1);
function project(style, stage = "tower", t = 0.5) {
  const b = { style, stage, t, repo: { id: "example" }, island: { color: new THREE.Color("#8fbf7a") }, shared: { forms, geo: { box } }, group: new THREE.Group(), base: new THREE.Color() };
  b.add = (geo, mat, x, y, z, sx, sy, sz) => { const mesh = new THREE.Mesh(geo, mat); mesh.position.set(x, y, z); mesh.scale.set(sx, sy, sz); b.group.add(mesh); return mesh; };
  b.height = buildProjectForm(b, false);
  return b;
}
for (const style of styles) test(`${style.name}: every stage stays finite, pickable and inside its plot`, () => {
  for (const stage of ["lot", "tent", "house", "midrise", "tower", "skyscraper", "warehouse", "unknown"]) for (const t of [0, 1]) {
    const b = project(style.id, stage, t), bounds = new THREE.Box3().setFromObject(b.group, true);
    assert.ok(b.group.children.length >= 2);
    assert.ok(Number.isFinite(b.height) && b.height > 0);
    assert.ok(bounds.max.y <= b.height + 0.01, `${stage} marker intersects its form`);
    assert.ok(bounds.max.x <= 3.11 && bounds.min.x >= -3.11 && bounds.max.z <= 3.11 && bounds.min.z >= -3.11, `${stage} spills outside the plot: ${bounds.min.toArray()} / ${bounds.max.toArray()}`);
    b.visualMaterials.forEach(({ material }) => material.dispose());
    b.formGeometries.forEach(geometry => geometry.dispose());
    assert.ok(b.group.children.length <= 5, "procedural parts should be batched for large catalogs");
  }
});

test("size levels are bounded and increase with project evidence", () => {
  const levels = ["lot", "tent", "house", "midrise", "tower", "skyscraper"].map(stage => formLevel(stage, 0));
  assert.deepEqual(levels, [0, 1, 2, 3, 4, 5]);
  assert.equal(formLevel("skyscraper", 100), 6);
});

test("world changes and catalog updates preserve family anchors and release old scenery", () => {
  const island = { spot: { id: "example", radius: 30, cells: [{ x: 0, z: 0, repo: { id: "one" } }, { x: 12, z: 0, repo: { id: "two" } }] }, color: new THREE.Color("#8fbf7a"), group: new THREE.Group(), rock: new THREE.Mesh(), plots: new THREE.Mesh(), scenery: new THREE.Group(), sheds: new THREE.Group() };
  island.group.position.set(14, 5, 20);
  for (const style of styles) {
    dressIsland(island, style.id);
    assert.equal(island.rock.visible, false);
    assert.deepEqual(island.group.position.toArray(), [14, 5, 20]);
    const old = island.environment;
    dressIsland(island, style.id);
    assert.equal(island.environment, old, "unchanged scenes must be reused");
    const key = environmentKey(island, style.id);
    island.spot.cells[0].repo.hidden = true;
    assert.notEqual(environmentKey(island, style.id), key);
    let disposed = 0;
    old.traverse(o => o.geometry?.addEventListener("dispose", () => disposed++));
    dressIsland(island, style.id);
    assert.equal(old.parent, null);
    assert.ok(disposed > 0);
    island.spot.cells[0].repo.hidden = false;
  }
  dressIsland(island, "buildings");
  assert.equal(island.rock.visible, true);
  assert.equal(island.plots.visible, true);
  assert.equal(island.sheds.visible, true);
});
