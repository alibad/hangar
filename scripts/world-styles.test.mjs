import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { WORLD_STYLES, isWorldStyle, worldStyleById } from "../engine/world/js/world-styles.js";
import { projectMeasurement, projectMeasurementText } from "../engine/world/js/project-size.js";
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
function project(style, stage = "tower", t = 0.5, id = "example") {
  const b = { style, stage, t, repo: { id }, island: { color: new THREE.Color("#8fbf7a") }, shared: { forms, geo: { box } }, group: new THREE.Group(), base: new THREE.Color() };
  b.add = (geo, mat, x, y, z, sx, sy, sz) => { const mesh = new THREE.Mesh(geo, mat); mesh.position.set(x, y, z); mesh.scale.set(sx, sy, sz); b.group.add(mesh); return mesh; };
  b.height = buildProjectForm(b, false);
  return b;
}
for (const style of styles) test(`${style.name}: every stage stays finite, pickable and inside its footprint`, () => {
  for (const stage of ["lot", "tent", "house", "midrise", "tower", "skyscraper", "warehouse", "unknown"]) for (const t of [0, 1]) {
    const b = project(style.id, stage, t), bounds = new THREE.Box3().setFromObject(b.group, true);
    assert.ok(b.group.children.length >= 1);
    assert.ok(Number.isFinite(b.height) && b.height > 0);
    assert.ok(bounds.max.y <= b.height + 0.01, `${stage} marker intersects its form`);
    const edge = style.id === "mountains" ? 4.66 : 3.11;
    assert.ok(bounds.max.x <= edge && bounds.min.x >= -edge && bounds.max.z <= edge && bounds.min.z >= -edge, `${stage} spills outside its footprint: ${bounds.min.toArray()} / ${bounds.max.toArray()}`);
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

test("the selected size metric distinguishes a missing observation from zero", () => {
  const remote = { commitCount: null, sizeKB: 180000 };
  const local = { commitCount: 0, sizeKB: 0 };
  assert.equal(projectMeasurement(remote, "commits").value, null);
  assert.equal(projectMeasurement(remote, "megabytes").value, 180000);
  assert.deepEqual(projectMeasurement(local, "commits"), { value: 0, stage: "lot", t: 0 });
  assert.equal(projectMeasurement(local, "megabytes").value, null);
  assert.equal(projectMeasurement({ ...local, empty: true }, "megabytes").value, 0);
  assert.equal(projectMeasurementText(local, "commits"), "0 commits");
});

test("mountain profiles vary in silhouette and surface color at the same size", () => {
  const profiles = new Set(), palettes = new Set();
  for (let n = 0; n < 24; n++) {
    const id = `ridge-${n}`;
    const foothill = project("mountains", "tent", 0, id);
    const summit = project("mountains", "skyscraper", 1, id);
    const [surface] = foothill.formGeometries;
    const heights = surface.getAttribute("position").array.filter((_, i) => i % 3 === 1);
    profiles.add(JSON.stringify([...heights]));
    palettes.add(JSON.stringify([...surface.getAttribute("color").array]));
    assert.ok(summit.height > foothill.height * 2.5);
    assert.deepEqual(summit.formGeometries[0].getAttribute("color").array, surface.getAttribute("color").array);
    for (const b of [foothill, summit]) {
      b.formGeometries.forEach(geometry => geometry.dispose());
      b.visualMaterials.forEach(({ material }) => material.dispose());
    }
  }
  assert.equal(profiles.size, 5);
  assert.equal(palettes.size, 5);
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
const { fitWorld } = await import("../engine/world/js/camera-view.js");
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

test("airport and graph footprints fit a portrait camera", () => {
  const plan = layout(styleFixture());
  for (const style of ["airplanes", "constellation", "neural"]) {
    const { points, phi, theta } = composeWorld(plan, style);
    const camera = new THREE.PerspectiveCamera(40, 390 / 844, 1, 4000);
    const distance = fitWorld(points, theta, phi, camera.aspect, THREE.MathUtils.degToRad(camera.fov));
    camera.position.setFromSpherical(new THREE.Spherical(distance, phi, theta));
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    for (const { x, y, z } of points) {
      const point = new THREE.Vector3(x, y, z).project(camera);
      assert.ok(Math.abs(point.x) < 0.9 && Math.abs(point.y) < 0.9, style);
    }
  }
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

test("uncategorized projects do not acquire artificial graph connections", () => {
  const doc = styleFixture();
  doc.families = [{ id: "uncategorized", name: "Uncategorized", repos: doc.repos.length }];
  for (const repo of doc.repos) repo.family = "uncategorized";
  const plan = layout(doc);
  for (const style of ["constellation", "neural"]) {
    assert.deepEqual(compositionEdges(plan, composeWorld(plan, style)), []);
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
      assert.equal(group.userData.focus(edge.a, id => id === edge.a).size, 0);
      for (const lines of group.children.filter(object => object.isLineSegments)) assert.equal(lines.geometry.drawRange.count, 0);
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
