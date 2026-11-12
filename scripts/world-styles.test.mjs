import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { WORLD_STYLES, isWorldStyle, worldStyleById } from "../engine/world/js/world-styles.js";
globalThis.location = { search: "", pathname: "/" };
const { buildProjectForm, createFormGeometry, formLevel } = await import("../engine/world/js/project-forms.js");
const { dressIsland, createEnvironment, disposeEnvironment } = await import("../engine/world/js/environments.js");
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
    assert.ok(b.group.children.length >= 1);
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

test("only the Buildings view retains island terrain and architecture", () => {
  const island = { rock: new THREE.Mesh(), plots: new THREE.Mesh(), scenery: new THREE.Group(), sheds: new THREE.Group() };
  for (const style of WORLD_STYLES) {
    dressIsland(island, style.id);
    assert.equal(island.rock.visible, style.id === "buildings");
    assert.equal(island.sheds.visible, style.id === "buildings");
  }
});

const { layout, reconcileLayout } = await import("../engine/world/js/layout.js");
const { composeWorld, compositionEdges, groundHeight, isLandscape } = await import("../engine/world/js/composition.js");
const { styleFixture } = await import("./world-style-fixture.mjs");

test("spatial views are deterministic, distinct and leave canonical organization untouched", () => {
  const doc = styleFixture(), plan = layout(doc), before = JSON.stringify(plan), signatures = new Set();
  for (const style of WORLD_STYLES) {
    const result = composeWorld(plan, style.id);
    assert.deepEqual(result, composeWorld(plan, style.id));
    assert.equal(result.projects.size, doc.repos.length);
    for (const p of result.projects.values()) assert.ok([p.x, p.y, p.z].every(Number.isFinite));
    assert.ok(result.extent >= 1);
    signatures.add(JSON.stringify([...result.projects]));
    assert.equal(JSON.stringify(plan), before);
  }
  assert.equal(signatures.size, 12, "each world must have its own spatial arrangement");
});

test("airport gates alternate headings along a common terminal without island seats", () => {
  const view = composeWorld(layout(styleFixture()), "airplanes"), points = [...view.projects.values()];
  assert.equal(points[0].heading, -Math.PI / 2);
  assert.equal(points[1].heading, Math.PI / 2);
  assert.equal(points[0].x, points[1].x);
  assert.ok(points[0].z < 0 && points[1].z > 0);
});

test("hide and restore retain view coordinates, including force-directed positions", () => {
  for (const style of WORLD_STYLES) {
    const doc = styleFixture(), plan = layout(doc), before = composeWorld(plan, style.id);
    doc.repos[1].hidden = true; reconcileLayout(plan, doc);
    assert.deepEqual(composeWorld(plan, style.id).projects, before.projects, style.id);
    doc.repos[1].hidden = false; reconcileLayout(plan, doc);
    assert.deepEqual(composeWorld(plan, style.id).projects, before.projects, style.id);
  }
});

test("constellations and networks occupy depth and height; topics explain cross-category edges", () => {
  const doc = styleFixture();
  doc.families.push({ id: "other", name: "Other", repos: 1 });
  doc.repos[0].family = "other"; doc.repos[0].topics = ["visualization"]; doc.repos[1].topics = ["visualization"];
  const plan = layout(doc);
  for (const style of ["constellation", "neural"]) {
    const view = composeWorld(plan, style), heights = [...view.projects.values()].map(p => p.y);
    assert.ok(Math.max(...heights) - Math.min(...heights) > 5);
    const edges = compositionEdges(plan, view);
    const cross = edges.filter(e => doc.repos.find(r => r.id === e.a).family !== doc.repos.find(r => r.id === e.b).family);
    assert.equal(cross.length, style === "neural" ? 1 : 0);
    assert.ok(cross.every(e => e.reason === "shared topic"));
  }
});

test("each new world owns one global environment and releases its resources once", () => {
  const plan = layout(styleFixture()), world = { scene: new THREE.Scene(), isLite: true };
  for (const style of WORLD_STYLES.slice(1)) {
    const view = composeWorld(plan, style.id), group = createEnvironment(world, plan, view);
    assert.ok(group.children.length);
    assert.equal(group.children.some(o => o.userData.ground), isLandscape(style.id));
    if (group.userData.focus) {
      const edge = group.userData.edges[0], related = group.userData.focus(edge.a);
      assert.ok(related.has(edge.a) && related.has(edge.b));
      assert.equal(group.userData.focus("unknown-project").size, 0);
    }
    const unique = new Set(); let disposed = 0;
    group.traverse(o => { if (o.geometry) unique.add(o.geometry); });
    unique.forEach(g => g.addEventListener("dispose", () => disposed++));
    disposeEnvironment(group);
    assert.equal(disposed, unique.size);
    assert.equal(group.parent, null);
  }
});
