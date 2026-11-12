// Family-sized scenery. Connections mean shared family membership, never dependencies.
import * as THREE from "three";
import { hash, rng } from "./util.js";
import { SPACE_STYLES } from "./world-styles.js";

export function disposeEnvironment(group) {
  if (!group) return;
  group.traverse(object => {
    object.geometry?.dispose();
    for (const material of [].concat(object.material || [])) material.dispose();
  });
  group.removeFromParent();
}

export function environmentKey(island, style) {
  return JSON.stringify([style, island.spot.radius, island.spot.cells.filter(c => !c.repo.hidden).map(c => [c.repo.id, c.x, c.z])]);
}

export function dressIsland(island, style) {
  const classic = style === "buildings" || style === "airplanes";
  for (const object of [island.rock, island.plots, island.scenery, island.sheds]) if (object) object.visible = classic;
  const key = environmentKey(island, style);
  if (island.environmentKey === key) return;
  island.environmentKey = key;
  disposeEnvironment(island.environment);
  island.environment = new THREE.Group();
  island.group.add(island.environment);
  if (classic) return;
  const group = island.environment, spot = island.spot, radius = spot.radius;
  const rand = rng(hash(`${spot.id}:${style}`)), color = island.color;
  const mat = (hex, metalness = 0, glow = 0) => new THREE.MeshStandardMaterial({ color: hex, emissive: hex, emissiveIntensity: glow, metalness, roughness: metalness ? 0.45 : 0.9, flatShading: true });
  const mesh = (geo, material, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(geo, material); m.position.set(x, y, z); m.receiveShadow = !!island.shadows; group.add(m); return m;
  };
  // A small set of shared resources within this family; disposed as a group on rebuild.
  const discGeo = new THREE.CylinderGeometry(1, 1, 1, 64);
  const lineGeo = r => new THREE.BufferGeometry().setFromPoints(Array.from({ length: 97 }, (_, i) => new THREE.Vector3(Math.cos(i / 96 * Math.PI * 2) * r, 0, Math.sin(i / 96 * Math.PI * 2) * r)));
  const circle = (r, y, hex, alpha = 0.4) => {
    const line = new THREE.Line(lineGeo(r), new THREE.LineBasicMaterial({ color: hex, transparent: true, opacity: alpha, depthWrite: false }));
    line.position.y = y; group.add(line);
  };
  const disc = (r, y, depth, material) => {
    const m = mesh(discGeo, material, 0, y, 0); m.scale.set(r, depth, r); return m;
  };
  if (SPACE_STYLES.has(style)) {
    for (const k of [0.62, 0.83, 1]) circle(radius * k, -1.5, color, k === 1 ? 0.35 : 0.13);
    const count = style === "galaxy" ? 320 : 90, points = [];
    for (let i = 0; i < count; i++) {
      const a = rand() * Math.PI * 2, d = Math.sqrt(rand()) * radius;
      points.push(Math.cos(a) * d, -1 + rand() * 2.5, Math.sin(a) * d);
    }
    const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
    group.add(new THREE.Points(geo, new THREE.PointsMaterial({ color: style === "neural" ? "#85c9bc" : "#b6c4f4", size: style === "galaxy" ? 0.48 : 0.24, transparent: true, opacity: 0.65 })));
    if (style === "constellation" || style === "neural") {
      // A deterministic spanning tree, at most n-1 edges, connects family members.
      // Minimal nearby links keep large catalogs readable and do not imply activity.
      const cells = spot.cells.filter(c => !c.repo.hidden), links = [];
      for (let i = 1; i < cells.length; i++) {
        const c = cells[i]; let near = cells[0], d = Infinity;
        for (let j = 0; j < i; j++) { const n = cells[j], next = Math.hypot(c.x - n.x, c.z - n.z); if (next < d) { near = n; d = next; } }
        links.push(near.x, 0.85, near.z, c.x, 0.85, c.z);
      }
      const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.Float32BufferAttribute(links, 3));
      group.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: style === "neural" ? "#83dbc7" : "#e1c791", transparent: true, opacity: 0.32 })));
    }
  } else {
    const colors = { forest: "#365f49", reef: "#26667a", mountains: "#627a81", garden: "#526e4b", mechanical: "#353c46", museum: "#b8aa99" };
    disc(radius, -2.4, 4.2, mat(colors[style]));
    if (style === "forest" || style === "garden") {
      disc(radius * 0.98, -0.25, 0.5, mat(style === "forest" ? "#68866a" : "#98a57d"));
      const bed = mat(style === "forest" ? "#516b50" : "#62533f");
      for (const cell of spot.cells.filter(c => !c.repo.hidden)) { const m = mesh(discGeo, bed, cell.x, 0.05, cell.z); m.scale.set(4.6, 0.18, 4.6); }
      circle(radius * 0.96, 0.1, "#c1cca2", 0.6);
    } else if (style === "reef") {
      disc(radius * 0.98, -0.25, 0.6, mat("#8aabac"));
      for (const k of [0.9, 1, 1.1]) circle(radius * k, -0.7, "#70d3eb", 0.3);
      const stoneGeo = new THREE.IcosahedronGeometry(1, 0), stone = mat("#4f8990");
      for (let i = 0; i < 32; i++) {
        const a = i / 32 * Math.PI * 2, d = radius * (0.92 + rand() * 0.06), r = 1 + rand() * 1.8;
        const m = mesh(stoneGeo, stone, Math.cos(a) * d, 0, Math.sin(a) * d); m.scale.set(r, r * 0.4, r);
      }
    } else if (style === "mountains") {
      for (let i = 0; i < 4; i++) disc(radius * (1 - i * 0.025), -1.5 + i * 0.45, 0.4, mat(i % 2 ? "#82958e" : "#72877f"));
      for (const k of [0.4, 0.62, 0.82, 0.98]) circle(radius * k, 0.15, "#d2d7be", 0.5);
    } else if (style === "mechanical") {
      disc(radius * 0.98, -0.15, 0.35, mat("#464d56", 0.6));
      for (const k of [0.45, 0.72, 0.98]) circle(radius * k, 0.1, "#d8b06a", 0.65);
      const tickGeo = new THREE.BoxGeometry(0.6, 0.16, radius * 0.05), brass = mat("#bc955b", 0.65);
      for (let i = 0; i < 48; i++) { const a = i / 48 * Math.PI * 2; const m = mesh(tickGeo, brass, Math.sin(a) * radius * 0.93, 0.2, Math.cos(a) * radius * 0.93); m.rotation.y = a; }
    } else if (style === "museum") {
      disc(radius * 0.99, -0.15, 0.4, mat("#ded5c6"));
      const edge = mat("#8c7c68", 0.35), railGeo = new THREE.TorusGeometry(radius * 0.97, 0.15, 5, 96);
      const rail = mesh(railGeo, edge, 0, 0.3, 0); rail.rotation.x = Math.PI / 2;
      const plinth = mat("#c8bda9");
      for (const cell of spot.cells.filter(c => !c.repo.hidden)) { const m = mesh(discGeo, plinth, cell.x, 0.12, cell.z); m.scale.set(4.2, 0.25, 4.2); }
    }
  }
  // Empty families create no discs; free the unused base geometry too.
  if (!group.children.some(child => child.geometry === discGeo)) discGeo.dispose();
}
