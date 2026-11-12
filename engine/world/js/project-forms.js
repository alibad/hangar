// Procedural project forms: all geometry is shared, all variation is seeded by repo ID.
// No network assets, synthetic activity, inferred dependencies or background animation.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { clamp, hash, rng } from "./util.js";
import { PLOT } from "./layout.js";

export function createFormGeometry() {
  const gear = new THREE.Shape();
  const teeth = 12;
  for (let i = 0; i <= teeth * 4; i++) {
    const a = i / (teeth * 4) * Math.PI * 2, r = i % 4 < 2 ? 1 : 0.79;
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    if (!i) gear.moveTo(x, y); else gear.lineTo(x, y);
  }
  const hole = new THREE.Path(); hole.absarc(0, 0, 0.25, 0, Math.PI * 2, true); gear.holes.push(hole);
  return {
    orb: new THREE.IcosahedronGeometry(1, 1),
    smooth: new THREE.SphereGeometry(1, 16, 10),
    ring: new THREE.TorusGeometry(1, 0.045, 5, 40),
    cylinder: new THREE.CylinderGeometry(1, 1, 1, 12),
    cone: new THREE.ConeGeometry(1, 1, 7),
    crystal: new THREE.OctahedronGeometry(1, 0),
    gear: new THREE.ExtrudeGeometry(gear, { depth: 0.2, bevelEnabled: false, steps: 1, curveSegments: 12 }).translate(0, 0, -0.1),
    leaf: new THREE.SphereGeometry(1, 8, 6),
  };
}

const LEVELS = { lot: 0, tent: 1, house: 2, midrise: 3, tower: 4, skyscraper: 5, warehouse: 3 };
export function formLevel(stage, t) { return clamp((LEVELS[stage] ?? 2) + t, 0, 6); }

/** Populate an existing project wrapper, so selection, lenses and live markers keep one implementation. */
export function buildProjectForm(b, shadows) {
  const g = b.shared.forms, rand = rng(hash(b.repo.id) ^ 0x327af), level = formLevel(b.stage, b.t);
  const family = b.island.color.clone();
  b.visualMaterials = [];
  const material = (color, glow = 0, metalness = 0) => {
    const c = new THREE.Color(color);
    const m = new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: glow, roughness: metalness ? 0.35 : 0.7, metalness, flatShading: true });
    b.visualMaterials.push({ material: m, color: c.clone(), glow });
    return m;
  };
  const palette = { forest: "#4c985e", reef: "#edaf75", mountains: "#849da4", garden: "#b78ac4", mechanical: "#8fa8b0" };
  const main = material((palette[b.style] ? new THREE.Color(palette[b.style]) : family.clone()).offsetHSL((rand() - 0.5) * 0.16, 0.12, 0.02));
  b.base.copy(main.color);
  const light = material("#fff0ca", 0.18), dark = material("#304355"), stem = material("#6e6949");
  const mint = material("#7ac7aa"), coral = material("#f18ca7", 0.08), gold = material("#d8ac63", 0.03, 0.65);
  const put = (geo, mat, x, y, z, sx = 1, sy = sx, sz = sx) => b.add(geo, mat, x, y, z, sx, sy, sz, shadows);
  const orb = (mat, x, y, z, r = 1) => put(g.orb, mat, x, y, z, r);
  const rod = (a, c, radius, mat) => {
    const from = new THREE.Vector3(...a), to = new THREE.Vector3(...c), delta = to.clone().sub(from);
    const mid = from.clone().add(to).multiplyScalar(0.5);
    const mesh = put(g.cylinder, mat, mid.x, mid.y, mid.z, radius, delta.length(), radius);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
    return mesh;
  };
  const ring = (mat, x, y, z, r, tilt = Math.PI / 2) => {
    const mesh = put(g.ring, mat, x, y, z, r); mesh.rotation.x = tilt; return mesh;
  };
  const box = (mat, x, y, z, sx, sy, sz) => put(b.shared.geo.box, mat, x, y, z, sx, sy, sz);
  let top;
  switch (b.style) {
    case "galaxy": {
      const r = 1.1 + level * 0.28, y = r + 1.3;
      put(g.smooth, main, 0, y, 0, r);
      // Latitude bands distinguish planets from the constellation's starbursts.
      for (const f of [-0.45, 0.15]) ring(light, 0, y + r * f, 0, r * Math.sqrt(1 - f * f), Math.PI / 2);
      if (level >= 2) ring(gold, 0, y, 0, r * 1.55, 1.1);
      if (level >= 4) ring(main, 0, y, 0, r * 1.75, 1.1);
      for (let i = 0; i < Math.floor(level / 2); i++) {
        const a = i * 2.4 + 0.6;
        orb(light, Math.cos(a) * 4, y + Math.sin(a) * 1.2, Math.sin(a) * 3, 0.3 + i * 0.08);
      }
      top = y + r + 1;
      break;
    }
    case "forest": {
      const h = 2.6 + level * 1.15;
      rod([0, 0, 0], [0, h * 0.8, 0], 0.24 + level * 0.035, stem);
      for (let i = 0; i < 3 + Math.floor(level); i++) {
        const a = i * 2.4, reach = 1 + level * 0.2, y = h * (0.45 + i / (9 + level) * 0.55);
        const x = Math.cos(a) * reach, z = Math.sin(a) * reach;
        rod([0, y * 0.75, 0], [x, y, z], 0.1, stem);
        put(g.orb, i % 2 ? main : mint, x, y + 0.8, z, 1.1 + level * 0.13, 1.2 + level * 0.18, 1.1 + level * 0.13);
      }
      top = h + 2;
      break;
    }
    case "reef": {
      const h = 2.6 + level * 0.85;
      orb(dark, 0, 0.35, 0, 1.1);
      for (let i = 0; i < 3 + Math.floor(level); i++) {
        const a = i * 2.4, x = Math.cos(a) * (1.2 + level * 0.19), z = Math.sin(a) * (1.2 + level * 0.19), y = h * (0.55 + rand() * 0.45);
        const mat = i % 2 ? coral : main;
        rod([0, 0.4, 0], [x * 0.45, y * 0.6, z * 0.45], 0.2, mat);
        rod([x * 0.45, y * 0.6, z * 0.45], [x, y, z], 0.15, mat);
        rod([x * 0.45, y * 0.6, z * 0.45], [x * 0.3, y + 0.7, z * 0.3], 0.13, mat);
        orb(light, x, y, z, 0.24);
        orb(mat, x * 0.3, y + 0.7, z * 0.3, 0.3);
      }
      top = h + 1;
      break;
    }
    case "mountains": {
      const h = 3 + level * 1.45, r = 2 + level * 0.27;
      put(g.cone, main, 0, h / 2, 0, r, h, r);
      put(g.cone, light, 0, h * 0.88, 0, r * 0.28, h * 0.28, r * 0.28);
      put(g.cone, dark, -r * 0.8, h * 0.19, r * 0.4, r * 0.6, h * 0.45, r * 0.6);
      if (level > 2) put(g.cone, main, r * 0.7, h * 0.28, -r * 0.3, r * 0.65, h * 0.6, r * 0.65);
      ring(light, 0, 0.12, 0, r * 1.25);
      top = h * 1.03;
      break;
    }
    case "fleet": {
      const k = 0.8 + level * 0.13, y = 2.2;
      b.group.rotation.y = -Math.PI / 4;
      put(g.crystal, main, 0, y, 0, 0.9 * k, 0.7 * k, 3.6 * k);
      box(dark, 0, y + 0.5 * k, 0.6 * k, k, 0.5 * k, 2 * k);
      for (const s of [-1, 1]) {
        const wing = box(main, s * 1.35 * k, y, k, 2.2 * k, 0.18 * k, 1.9 * k); wing.rotation.y = s * 0.4;
        box(dark, s * 1.7 * k, y, 1.3 * k, 0.65 * k, 0.65 * k, 2.5 * k);
        orb(mint, s * 1.7 * k, y, 2.65 * k, 0.32 * k);
        if (level >= 3) box(light, s * 0.65 * k, y + 0.3 * k, 0, 0.12, 0.16, 2 * k);
      }
      top = y + k * 1.5;
      break;
    }
    case "garden": {
      const h = 2.4 + level * 0.8;
      put(g.cylinder, gold, 0, 0.35, 0, 1.3, 0.7, 1.3);
      rod([0, 0.5, 0], [0, h, 0], 0.12, mint);
      for (let i = 0; i < 2 + Math.floor(level); i++) {
        const a = i * 2.4, y = 1 + i * (h - 1) / (3 + level);
        const leaf = put(g.leaf, mint, Math.cos(a) * 0.9, y, Math.sin(a) * 0.9, 1.3, 0.16, 0.55); leaf.rotation.set(0.3, -a, 0.4);
      }
      const petals = 5 + Math.floor(level / 2), reach = 0.85 + level * 0.1;
      for (let i = 0; i < petals; i++) {
        const a = i / petals * Math.PI * 2;
        const petal = put(g.leaf, i % 2 ? coral : main, Math.cos(a) * reach, h, Math.sin(a) * reach, 1.1, 0.3, 0.6); petal.rotation.y = -a;
      }
      orb(light, 0, h + 0.12, 0, 0.65);
      if (level > 3) {
        rod([0, 1, 0], [1.8, h * 0.7, 0.7], 0.1, mint);
        orb(coral, 1.8, h * 0.7 + 0.3, 0.7, 0.65);
      }
      top = h + 0.8;
      break;
    }
    case "constellation": {
      const y = 3 + level * 0.35, r = 0.7 + level * 0.1;
      orb(light, 0, y, 0, r);
      for (let i = 0; i < 6; i++) {
        const a = i / 6 * Math.PI * 2, reach = 1.8 + level * 0.18;
        rod([Math.cos(a) * r, y + Math.sin(a) * r, 0], [Math.cos(a) * reach, y + Math.sin(a) * reach, 0], 0.065, gold);
      }
      ring(main, 0, y, 0, 2.6 + level * 0.15, 0.3);
      for (let i = 0; i < 2 + Math.floor(level / 2); i++) {
        const a = i * 2.4;
        orb(main, Math.cos(a) * 3, y + Math.sin(a) * 2, Math.sin(a) * 1.3, 0.22);
      }
      top = y + 3;
      break;
    }
    case "mechanical": {
      const h = 1.5 + level * 0.85;
      put(g.cylinder, dark, 0, 0.3, 0, 2.4, 0.6, 2.4);
      rod([0, 0.3, 0], [0, h + 0.5, 0], 0.22, gold);
      for (let i = 0; i < 2 + Math.floor(level / 2); i++) {
        const y = 1 + i * 1.25, r = 1.5 + (i % 2) * 0.5;
        const gear = put(g.gear, i % 2 ? main : gold, 0, y, 0, r, r, 1.4); gear.rotation.x = Math.PI / 2;
        if (i % 2 === 0) { const side = put(g.gear, gold, 1.7, y + 1.1, 0, 0.9); side.rotation.y = 0.25; }
      }
      ring(light, 0, h + 0.6, 0, 1, 0);
      top = Math.max(h + 1.7, 2 + Math.floor(level / 2) * 1.25);
      break;
    }
    case "neural": {
      const y = 3.3 + level * 0.3;
      orb(mint, 0, y, 0, 0.85 + level * 0.07);
      for (let i = 0; i < 4 + Math.floor(level); i++) {
        const a = i * 2.4, reach = 2 + rand() * 1.6;
        const p = [Math.cos(a) * reach, 1.5 + rand() * (y + 1.5), Math.sin(a) * reach];
        rod([0, y, 0], p, 0.055, main); orb(i % 2 ? main : light, ...p, 0.25 + rand() * 0.2);
        if (i > 2) { const q = [p[0] * 1.2, p[1] + 0.8, p[2] * 1.2]; rod(p, q, 0.035, mint); orb(mint, ...q, 0.14); }
      }
      top = y + 3;
      break;
    }
    case "museum": {
      const h = 2.1 + level * 0.65;
      box(light, 0, 0.4, 0, 3.2, 0.8, 3.2);
      box(dark, 0, 1.1, 0, 1.7, 0.7, 1.7);
      const variant = hash(b.repo.id) % 3;
      if (variant === 0) for (let i = 0; i < 2 + Math.floor(level / 2); i++) ring(i % 2 ? gold : main, 0, 2.5 + i * 0.65, 0, 1.2 + i * 0.22, i * 0.6);
      else if (variant === 1) { const sculpture = put(g.crystal, main, 0, 1.5 + h / 2, 0, 1.5, h / 2, 1.5); sculpture.rotation.z = 0.28; }
      else for (let i = 0; i < 2 + Math.floor(level / 2); i++) { const slab = box(i % 2 ? gold : main, 0, 1.8 + i * 0.7, 0, 2, 0.5, 1.2); slab.rotation.y = i * 0.65; }
      box(gold, 0, 0.9, 1.62, 0.9, 0.35, 0.06);
      top = Math.max(h + 2, 4.5 + Math.floor(level / 2) * 0.65);
      break;
    }
    default: throw new Error(`Unknown project form: ${b.style}`);
  }
  // Fit even tilted rings and long starships inside the existing seven-unit plots.
  // Scale whole meshes uniformly so branch endpoints and rotated gear teeth stay aligned.
  const bounds = new THREE.Box3().setFromObject(b.group), origin = b.group.position;
  const reach = Math.max(Math.abs(bounds.min.x - origin.x), Math.abs(bounds.max.x - origin.x), Math.abs(bounds.min.z - origin.z), Math.abs(bounds.max.z - origin.z));
  const fit = Math.min(1, (PLOT / 2 - 0.4) / reach);
  for (const mesh of b.group.children) { mesh.position.multiplyScalar(fit); mesh.scale.multiplyScalar(fit); }
  // Include all branch tips in marker placement and camera framing.
  top = Math.max(top * fit, new THREE.Box3().setFromObject(b.group).max.y - origin.y);
  // Batch branches, petals and gear teeth by material. A large catalog draws a few
  // meshes per project rather than a draw call for every small procedural part.
  const buckets = new Map();
  for (const mesh of [...b.group.children]) {
    mesh.updateMatrix();
    const geometry = (mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone()).applyMatrix4(mesh.matrix);
    if (!buckets.has(mesh.material)) buckets.set(mesh.material, []);
    buckets.get(mesh.material).push(geometry);
    mesh.removeFromParent();
  }
  b.pickables = [];
  b.formGeometries = [];
  for (const [mat, parts] of buckets) {
    const geometry = mergeGeometries(parts);
    parts.forEach(part => part.dispose());
    b.formGeometries.push(geometry);
    b.add(geometry, mat, 0, 0, 0, 1, 1, 1, shadows);
  }
  b.formHeight = top;
  return top;
}
