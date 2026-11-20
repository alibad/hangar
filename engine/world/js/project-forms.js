// Procedural project forms: all geometry is shared, all variation is seeded by repo ID.
// No network assets, synthetic activity, inferred dependencies or background animation.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { clamp, hash, rng } from "./util.js";
import { PLOT } from "./layout.js";
import { createMountainGeometry } from "./mountain-forms.js";

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
    mountains: createMountainGeometry(),
    gear: new THREE.ExtrudeGeometry(gear, { depth: 0.2, bevelEnabled: false, steps: 1, curveSegments: 12 }).translate(0, 0, -0.1),
    leaf: new THREE.SphereGeometry(1, 8, 6),
  };
}

const LEVELS = { lot: 0, tent: 1, house: 2, midrise: 3, tower: 4, skyscraper: 5, warehouse: 3 };
export function formLevel(stage, t) { return clamp((LEVELS[stage] ?? 2) + t, 0, 6); }
const TREES = [
  { crown: "#2b785f", light: "#71b27b" },
  { crown: "#589339", light: "#a6c55c" },
  { crown: "#a65234", light: "#f6bd55" },
  { crown: "#397f68", light: "#88c4a0" },
];
const CORALS = [
  { body: "#e94f84", tips: "#ffd5b0" },
  { body: "#e5993f", tips: "#fff4b0" },
  { body: "#8963d3", tips: "#dbabef" },
  { body: "#36bca8", tips: "#a6f1d5" },
];

/** Populate an existing project wrapper, so selection, lenses and live markers keep one implementation. */
export function buildProjectForm(b, shadows) {
  const g = b.shared.forms, seed = hash(b.repo.id), rand = rng(seed ^ 0x327af), level = formLevel(b.stage, b.t);
  const family = b.island.color.clone();
  b.visualMaterials = [];
  const material = (color, glow = 0, metalness = 0) => {
    const c = new THREE.Color(color);
    const m = new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: glow, roughness: metalness ? 0.35 : 0.7, metalness, flatShading: true });
    b.visualMaterials.push({ material: m, color: c.clone(), glow });
    return m;
  };
  const variant = (seed >>> 5) % 4;
  const tree = TREES[variant], coralPaint = CORALS[variant];
  const palette = { forest: tree.crown, reef: coralPaint.body, mountains: "#ffffff", garden: "#b78ac4", mechanical: "#8fa8b0" };
  const paint = palette[b.style] ? new THREE.Color(palette[b.style]) : family;
  if (["forest", "reef"].includes(b.style)) paint.offsetHSL((rand() - 0.5) * 0.06, 0.06, 0.02);
  else if (b.style !== "mountains") paint.offsetHSL((rand() - 0.5) * 0.16, 0.12, 0.02);
  const main = material(paint);
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
      const r = 0.86 + level * 0.23, y = r + 1.3;
      put(g.smooth, main, 0, y, 0, r);
      // Latitude bands distinguish planets from the constellation's starbursts.
      for (const f of [-0.45, 0.15]) ring(light, 0, y + r * f, 0, r * Math.sqrt(1 - f * f), Math.PI / 2);
      if (level >= 2) ring(gold, 0, y, 0, Math.min(2.8, r * 1.4), 1.1);
      if (level >= 4) ring(main, 0, y, 0, Math.min(2.95, r * 1.57), 1.1);
      for (let i = 0; i < Math.floor(level / 2); i++) {
        const a = i * 2.4 + 0.6;
        orb(light, Math.cos(a) * 2.55, y + Math.sin(a) * 1.2, Math.sin(a) * 2.55, 0.22 + i * 0.05);
      }
      top = y + r + 1;
      break;
    }
    case "forest": {
      const h = 3 + level * 1.25, width = 1.4 + level * 0.15, foliage = material(tree.light);
      rod([0, -.22, 0], [0, h * .85, 0], .22 + level * .043, stem);
      if (variant === 0) {
        for (let i = 0; i < 4; i++) {
          const r = width * (1.12 - i * .21), layer = h * (.4 + i * .164);
          const crown = put(g.cone, i % 2 ? foliage : main, 0, layer, 0, r, h * .39, r);
          crown.rotation.y = i * .32;
        }
      } else {
        const reach = width * (variant === 3 ? .89 : .68);
        for (let i = 0; i < 5; i++) {
          const a = i * 2.4 + rand() * .3, y = h * (.48 + i * .074);
          const x = Math.cos(a) * reach, z = Math.sin(a) * reach;
          rod([0, y * .67, 0], [x, y, z], .10 + level * .015, stem);
          const canopy = variant === 3 ? g.leaf : g.orb;
          const leaf = put(canopy, i % 2 ? foliage : main, x, y, z,
            width * .64, variant === 3 ? h * .26 : width * .79, width * .61);
          leaf.rotation.z = variant === 3 ? -.38 * Math.cos(a) : 0;
        }
        put(g.orb, foliage, 0, h * .83, 0, width * .72, width * .73, width * .72);
      }
      top = h;
      break;
    }
    case "reef": {
      const h = 2 + level * .94, rim = material(coralPaint.tips, .035);
      put(g.orb, dark, 0, .1, 0, 1.3, .55, 1.15);
      if (variant === 1) {
        // Plate corals grow overlapping, scalloped shelves.
        for (let i = 0; i < 4; i++) {
          const y = h * (.31 + i * .2), r = 1.98 - i * .23 + level * .10, a = i * 2.4;
          put(g.orb, i % 2 ? main : rim, Math.cos(a) * .42, y, Math.sin(a) * .37, r, .24, r * .79).rotation.z = Math.cos(a) * .16;
        }
        rod([0, 0, 0], [0, h * .92, 0], .55, main);
      } else if (variant === 3) {
        // Tubes with a dark opening on each pale rim.
        for (let i = 0; i < 5; i++) {
          const a = i * 2.4, reach = (i === 0 ? .16 : 1.35), x = Math.cos(a) * reach, z = Math.sin(a) * reach;
          const y = h * (.5 + rand() * .48), radius = .39 + rand() * .22;
          rod([x * .6, .15, z * .6], [x, y, z], radius, main);
          ring(rim, x, y, z, radius, Math.PI / 2);
          put(g.smooth, dark, x, y + .01, z, radius * .85, .055, radius * .85);
        }
      } else {
        const fan = variant === 2, count = 5 + Math.floor(level * .7);
        const turn = (rand() - .5) * .84, largest = 1.6 + level * .14;
        for (let i = 0; i < count; i++) {
          const a = fan ? turn : i * 2.4, spread = fan ? (i / (count - 1) * 2 - 1) * largest : largest;
          const x = Math.cos(a) * spread, z = Math.sin(a) * spread;
          const y = h * (fan ? 1 - Math.abs(i / (count - 1) - .5) * .68 : .52 + rand() * .48);
          const fork = [x * .54, y * .55, z * .54], tip = [x, y, z], bud = [x * .73, y + .51, z * .73 + .15];
          rod([0, .15, 0], fork, .29, main);
          rod(fork, tip, .17, main);
          rod(fork, bud, .12, main);
          orb(rim, ...tip, .24);
          orb(rim, ...bud, .17);
        }
      }
      top = h;
      break;
    }
    case "mountains": {
      const h = 2.4 + level * 1.48, r = 2.34 + level * .37;
      main.vertexColors = true;
      const profile = g.mountains[(seed >>> 9) % g.mountains.length];
      put(profile, main, 0, 0, 0, r, h, r).rotation.y = rand() * Math.PI * 2;
      top = h;
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
      const r = 0.42 + level * 0.12;
      b.visualMaterials.find(row => row.material === light).glow = 1.2;
      orb(light, 0, 1, 0, r);
      top = 1 + r;
      break;
    }
    case "mechanical": {
      const h = 1.5 + level * 0.85;
      put(g.cylinder, dark, 0, 0.3, 0, 2.4, 0.6, 2.4);
      rod([0, 0.3, 0], [0, h + 0.5, 0], 0.22, gold);
      const gears = 2 + Math.floor(level / 2);
      for (let i = 0; i < gears; i++) {
        const y = 0.8 + h * (i + 1) / (gears + 1), r = 1.1 + level * .12 + (i % 2) * 0.35;
        const gear = put(g.gear, i % 2 ? main : gold, 0, y, 0, r, r, 1.4); gear.rotation.x = Math.PI / 2;
        if (i % 2 === 0) { const side = put(g.gear, gold, 1.7, y + 1.1, 0, 0.9); side.rotation.y = 0.25; }
      }
      ring(light, 0, h + 0.6, 0, 1, 0);
      top = h + 1.7;
      break;
    }
    case "neural": {
      const r = 0.55 + level * 0.17;
      orb(main, 0, 1, 0, r);
      orb(light, 0, 1.1, r * 0.65, r * 0.35);
      for (let i = 0; i < 3; i++) {
        const a = i * 2.4, p = [Math.cos(a) * 2, 1 + Math.sin(a) * 0.6, Math.sin(a) * 2];
        rod([0, 1, 0], p, 0.035, main);
        orb(main, ...p, 0.13);
      }
      top = 2.3;
      break;
    }
    case "museum": {
      const h = 2.1 + level * 0.65;
      box(light, 0, 0.4, 0, 3.2, 0.8, 3.2);
      box(dark, 0, 1.1, 0, 1.7, 0.7, 1.7);
      const variant = hash(b.repo.id) % 3;
      const layers = 2 + Math.floor(level / 2);
      if (variant === 0) for (let i = 0; i < layers; i++) ring(i % 2 ? gold : main, 0, 2 + h * i / layers, 0, 0.95 + level * .11 + i * 0.16, i * 0.6);
      else if (variant === 1) { const sculpture = put(g.crystal, main, 0, 1.5 + h / 2, 0, 1.5, h / 2, 1.5); sculpture.rotation.z = 0.28; }
      else for (let i = 0; i < layers; i++) { const slab = box(i % 2 ? gold : main, 0, 1.8 + h * i / layers, 0, 1.5 + level * .2, 0.42 + level * .07, 1.2); slab.rotation.y = i * 0.65; }
      box(gold, 0, 0.9, 1.62, 0.9, 0.35, 0.06);
      top = Math.max(h + 2, 4.5 + Math.floor(level / 2) * 0.65);
      break;
    }
    default: throw new Error(`Unknown project form: ${b.style}`);
  }
  // Fit forms to their footprint. Mountain ranges have wider spacing for rocky shoulders.
  // Scale whole meshes uniformly so branch endpoints and rotated gear teeth stay aligned.
  const bounds = new THREE.Box3().setFromObject(b.group, b.style === "mountains"), origin = b.group.position;
  const reach = Math.max(Math.abs(bounds.min.x - origin.x), Math.abs(bounds.max.x - origin.x), Math.abs(bounds.min.z - origin.z), Math.abs(bounds.max.z - origin.z));
  const edge = b.style === "mountains" ? 4.65 : (PLOT / 2 - .4) * (.78 + .22 * level / 6);
  const fit = Math.min(1, edge / reach);
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
  if (["constellation", "neural"].includes(b.style) && b.shared.starlight) {
    const material = new THREE.SpriteMaterial({ map: b.shared.starlight, color: b.style === "constellation" ? "#ffe1a0" : b.base, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false });
    b.halo = new THREE.Sprite(material);
    b.halo.position.set(0, 1, 0); b.halo.scale.setScalar(3.5 + level * .57);
    b.group.add(b.halo);
  }
  b.formHeight = top;
  return top;
}
