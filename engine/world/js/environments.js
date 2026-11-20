// One continuous environment per view. Categories never become platforms.
import * as THREE from "three";
import { hash, rng } from "./util.js";
import { groundHeight, isLandscape, compositionEdges } from "./composition.js";

export function disposeEnvironment(group) {
  if (!group) return;
  const geometries = new Set(), materials = new Set();
  group.traverse(object => { if (object.geometry) geometries.add(object.geometry); for (const material of [].concat(object.material || [])) materials.add(material); });
  geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); group.removeFromParent();
}

/** Kept as a public helper for tests and live-catalog reconciliation. */
export const environmentKey = (island, style) => JSON.stringify([style, island.spot.cells.map(c => [c.repo.id, !!c.repo.hidden])]);
export function dressIsland(island, style) {
  const classic = style === "buildings";
  for (const object of [island.rock, island.plots, island.scenery, island.sheds]) if (object) object.visible = classic;
  if (island.environment) { disposeEnvironment(island.environment); island.environment = null; }
}

export function createEnvironment(world, plan, composition) {
  const { style, extent } = composition, group = new THREE.Group(), rand = rng(hash(style));
  group.name = `environment:${style}`; group.userData.style = style; world.scene.add(group);
  if (style === "buildings") return group;
  const mat = (color, metalness = 0) => new THREE.MeshStandardMaterial({ color, roughness: 0.9 - metalness * 0.4, metalness, side: THREE.DoubleSide });
  const mesh = (geo, material, x = 0, y = 0, z = 0) => { const m = new THREE.Mesh(geo, material); m.position.set(x, y, z); m.receiveShadow = !world.isLite; group.add(m); return m; };
  const line = (points, color, opacity = 0.4) => {
    const object = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points.map(p => new THREE.Vector3(...p))), new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false })); group.add(object); return object;
  };
  const boxGeo = new THREE.BoxGeometry(1, 1, 1), boxMats = new Map();
  const box = (x, y, z, w, h, d, color) => { if (!boxMats.has(color)) boxMats.set(color, mat(color)); const m = mesh(boxGeo, boxMats.get(color), x, y, z); m.scale.set(w, h, d); return m; };
  const colors = { airplanes: "#2e4d46", forest: "#466b50", reef: "#3f7f86", mountains: "#667d73", garden: "#8a9a73", mechanical: "#242c34", museum: "#b7b0a2" };
  if (isLandscape(style)) {
    // A ground plane extends beyond the camera horizon. There is no visible disk or rim.
    const size = Math.max(320, extent * 5), segments = Math.min(200, Math.max(72, Math.ceil(size / 8)));
    const horizon = mesh(new THREE.PlaneGeometry(40000, 40000).rotateX(-Math.PI / 2), mat(new THREE.Color(colors[style]).multiplyScalar(0.92)), 0, -12.1, 0);
    horizon.userData.ground = true;
    const geo = new THREE.PlaneGeometry(size, size, segments, segments).rotateX(-Math.PI / 2), p = geo.attributes.position;
    const color = new THREE.Color(colors[style]), values = [];
    const valley = new THREE.Color("#425f68"), hillside = new THREE.Color("#a6987d");
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i);
      const edge = Math.max(Math.abs(x), Math.abs(z)) / (size / 2), blend = Math.min(1, Math.max(0, (1 - edge) / 0.4));
      const height = groundHeight(style, x, z);
      const fade = blend * blend * (3 - 2 * blend), y = -12 + (height + 12) * fade - 0.08;
      p.setY(i, y);
      const ridge = Math.sin(x * 0.023 + z * 0.017) * 0.11 + Math.cos(z * 0.041) * 0.08;
      const grain = Math.sin(x * 0.18 + z * 0.16) * Math.cos(z * 0.15) * 0.025;
      const c = color.clone();
      if (style === "mountains") {
        const accent = height < 0 ? valley : hillside;
        c.lerp(accent, Math.min(0.8, Math.abs(height) / 12) * fade);
      }
      c.multiplyScalar(0.92 + fade * (ridge + grain));
      values.push(c.r, c.g, c.b);
    }
    geo.setAttribute("color", new THREE.Float32BufferAttribute(values, 3)); geo.computeVertexNormals();
    const ground = mat("#ffffff"); ground.vertexColors = true; mesh(geo, ground).userData.ground = true;
  }
  if (style === "airplanes") {
    const gates = plan.islands.flatMap(s => s.cells.map(c => {
      const g = composition.groups.get(s.id), p = composition.projects.get(c.repo.id);
      return { x: g.x + p.x, z: g.z + p.z };
    }));
    if (!gates.length) return group;
    const minZ = Math.min(...gates.map(p => p.z)) - 32, maxZ = Math.max(...gates.map(p => p.z)) + 32;
    const center = (minZ + maxZ) / 2, length = maxZ - minZ, runwayX = composition.axisX;
    const right = Math.max(...gates.map(p => p.x)) + 13;
    // Separate the operational runway from the grouped terminal aprons.
    box((runwayX - 14 + right) / 2, -0.05, center, right - runwayX + 14, 0.12, length + 12, "#637980");
    box(runwayX, -0.01, center, 22, 0.1, length, "#202733");
    box(runwayX + 19, -0.002, center, 8, 0.09, length, "#303d49");
    box(runwayX + 19, 0.055, center, 0.26, 0.02, length, "#eabc56");
    for (let z = minZ + 12; z < maxZ - 10; z += 14) box(runwayX, 0.06, z, 0.72, 0.04, 7, "#f3f2e7");
    for (const side of [-1, 1]) {
      box(runwayX + side * 10, 0.06, center, 0.28, 0.04, length - 7, "#f3f2e7");
      for (const z of [minZ + 9, maxZ - 9]) for (let i = 1; i <= 4; i++) {
        box(runwayX + side * i * 1.75, 0.06, z, 0.8, 0.04, 7, "#f3f2e7");
      }
    }
    for (const s of plan.islands) {
      const g = composition.groups.get(s.id);
      const cells = s.cells.map(c => composition.projects.get(c.repo.id));
      for (const row of new Set(cells.map(p => Math.round(p.z / 36)))) {
        const rowZ = g.z + row * 36;
        const members = cells.filter(p => Math.round(p.z / 36) === row);
        const west = g.x + Math.min(...members.map(p => p.x)) - 7;
        const east = g.x + Math.max(...members.map(p => p.x)) + 7;
        const mid = (west + east) / 2, span = east - west;
        box(mid, 0.015, rowZ, span + 4, 0.05, 31, "#435664");
        box(mid, 1.4, rowZ, span, 2.8, 4.8, "#9babaa");
        box(mid, 2.96, rowZ, span + 1, 0.32, 6.4, "#d5e2df");
        box(mid, 3.17, rowZ, span - 1, 0.18, 1.4, "#536b7c");
        for (const side of [-1, 1]) {
          box(mid, 1.52, rowZ + side * 2.45, span - 1, 1.45, 0.1, "#3a7282");
          box(mid, 0.075, rowZ + side * 15, span + 1, 0.03, 0.22, "#e5b662");
        }
      }
      for (const p of cells) {
        const x = g.x + p.x, z = g.z + p.z, rowZ = g.z + Math.round(p.z / 36) * 36;
        box(x - 2.2, 1.05, rowZ + Math.sign(z - rowZ) * 3.8, 0.75, 0.65, 3.1, "#a5b6bc");
        line([[x - 5.8, 0.1, z - 4.8], [x + 5.8, 0.1, z - 4.8], [x + 5.8, 0.1, z + 4.8]], "#bdc9c9", 0.65);
        line([[x, 0.11, rowZ], [x, 0.11, z]], "#e4be65", 0.9);
      }
    }
  } else if (style === "garden") {
    for (const s of plan.islands) {
      const g = composition.groups.get(s.id), cols = Math.ceil(Math.sqrt(s.cells.length * 1.7));
      for (let i = 0; i < s.cells.length; i += cols) {
        const cells = s.cells.slice(i, i + cols).map(c => composition.projects.get(c.repo.id));
        if (cells.length < 2) continue;
        const points = cells.map(p => new THREE.Vector3(g.x + p.x, 0.03, g.z + p.z + 3));
        const path = new THREE.CatmullRomCurve3(points).getPoints(points.length * 6);
        line(path.map(p => p.toArray()), "#d8ba89", 0.55);
      }
    }
  } else if (style === "reef") {
    const points = [];
    for (let i = 0; i < 600; i++) points.push((rand() - 0.5) * extent * 3, rand() * extent * 0.8, (rand() - 0.5) * extent * 3);
    const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
    group.add(new THREE.Points(geo, new THREE.PointsMaterial({ color: "#9bd7d9", size: 0.3, transparent: true, opacity: 0.35, depthWrite: false })));
    // Broken ribbons of light suggest water caustics on the continuous sea floor.
    for (let i = 0; i < 22; i++) {
      const x = (rand() - 0.5) * extent * 3, z = (rand() - 0.5) * extent * 3;
      line(Array.from({ length: 24 }, (_, j) => { const px = x + j * 4, pz = z + Math.sin(j * 0.6) * 3; return [px, groundHeight(style, px, pz) + 0.02, pz]; }), "#8bd0bc", 0.16);
    }
  } else if (style === "mechanical") {
    const step = 12, size = extent * 2;
    for (let k = -size; k <= size; k += step) { line([[-size, 0.1, k], [size, 0.1, k]], "#8295a3", 0.09); line([[k, 0.1, -size], [k, 0.1, size]], "#8295a3", 0.09); }
    for (const s of plan.islands) {
      const g = composition.groups.get(s.id);
      for (const c of s.cells) { const p = composition.projects.get(c.repo.id); line([[g.x + p.x, 0.15, g.z + p.z], [g.x + p.x + 5, 0.15, g.z + p.z], [g.x + p.x + 5, 0.15, g.z]], "#b9945e", 0.55); }
    }
  } else if (style === "museum") {
    for (const s of plan.islands) {
      const g = composition.groups.get(s.id), points = s.cells.map(c => composition.projects.get(c.repo.id));
      const width = Math.max(...points.map(p => Math.abs(p.x))) * 2 + 18, depth = Math.max(...points.map(p => Math.abs(p.z))) * 2 + 18;
      box(g.x, -0.01, g.z, width, 0.08, depth, "#dfd7c8");
      box(g.x, 3.5, g.z - depth / 2, width, 7, 0.45, "#d3cbbc");
      for (const side of [-1, 1]) box(g.x + side * width / 2, 2.4, g.z, 0.4, 4.8, depth * 0.65, "#c3bcad");
      box(g.x, 7.3, g.z - depth / 2 + 1, width, 0.12, 0.3, "#fff2d6");
    }
  } else if (!isLandscape(style)) {
    const positions = [], col = [], a = style === "galaxy" ? 2400 : 1100;
    const dust = new THREE.Color(style === "neural" ? "#6caaa7" : style === "galaxy" ? "#b5a1ed" : "#adb9d0");
    for (let i = 0; i < a; i++) {
      const angle = rand() * Math.PI * 2, d = Math.sqrt(rand()) * extent * 2.1;
      const arm = style === "galaxy" ? Math.floor(rand() * 3) * Math.PI * 2 / 3 + d * 0.028 + (rand() - 0.5) * 0.42 : angle;
      positions.push(Math.cos(arm) * d, (rand() - 0.5) * extent * (style === "galaxy" ? 0.13 : 1.1), Math.sin(arm) * d);
      const k = 0.3 + rand() * 0.7; col.push(dust.r * k, dust.g * k, dust.b * k);
    }
    const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3)); geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    group.add(new THREE.Points(geo, new THREE.PointsMaterial({ vertexColors: true, size: style === "galaxy" ? 1.7 : 0.55, transparent: true, opacity: 0.65, depthWrite: false })));
    if (style === "constellation" || style === "neural") {
      const edges = compositionEdges(plan, composition); group.userData.edges = edges;
      const edgeMeshes = [];
      for (const reason of ["category", "shared topic"]) {
        const points = edges.filter(e => e.reason === reason).flatMap(e => [e.from.x, e.from.y, e.from.z, e.to.x, e.to.y, e.to.z]);
        const geometry = new THREE.BufferGeometry(); geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
        const base = new THREE.Color(reason === "shared topic" ? "#ccaae8" : style === "neural" ? "#76b8b2" : "#b9b2a0");
        geometry.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(points.length), 3));
        const object = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false }));
        group.add(object); edgeMeshes.push({ object, base, edges: edges.filter(e => e.reason === reason) });
      }
      group.userData.focus = (id, includes = () => true) => {
        const active = edges.filter(edge => includes(edge.a) && includes(edge.b));
        const visible = new Set(active);
        const neighbors = new Set(id ? [id] : []);
        const incident = active.filter(edge => edge.a === id || edge.b === id)
          .sort((a, b) => Number(b.reason === "shared topic") - Number(a.reason === "shared topic"))
          .slice(0, 14);
        const chosen = new Set(incident);
        for (const edge of incident) { neighbors.add(edge.a); neighbors.add(edge.b); }
        for (const row of edgeMeshes) {
          const geometry = row.object.geometry;
          const positions = geometry.attributes.position;
          const colors = geometry.attributes.color;
          let cursor = 0;
          for (const edge of row.edges) {
            if (!visible.has(edge) || id && !chosen.has(edge)) continue;
            const strength = id ? 2.4 : edge.reason === "shared topic" ? 1 : style === "constellation" ? 0.85 : 0.54;
            for (const p of [edge.from, edge.to]) {
              positions.setXYZ(cursor, p.x, p.y, p.z);
              colors.setXYZ(cursor++, row.base.r * strength, row.base.g * strength, row.base.b * strength);
            }
          }
          positions.needsUpdate = colors.needsUpdate = true;
          geometry.setDrawRange(0, cursor);
        }
        if (!incident.length) neighbors.clear();
        return neighbors;
      };
      group.userData.focus(null);
    } else if (style === "fleet") {
      for (const g of composition.groups.values()) line([[g.x, g.y - 3, g.z - 15], [g.x, g.y - 3, g.z + g.radius]], "#5c8da7", 0.2);
    }
  }
  if (!group.children.some(m => m.geometry === boxGeo)) boxGeo.dispose();
  return group;
}
