// Islands, plots and buildings. A repo's building says how far it got (empty lot, tent, house, mid-rise, tower,
// skyscraper); lit windows say how recently it was worked on; a rooftop beacon says it is live somewhere; small
// sheds around it are its extra local copies. Lenses recolour, dim or ghost buildings without rebuilding them.
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { clamp, hash, lerp, rng } from "./util.js";
import { PLOT } from "./layout.js";

const GROUND = {
  reading: "#a596cc", workshop: "#8fbf7a",
  attic: "#a8a48d", vendor: "#9ba3aa", offmap: "#b8785c", borrowed: "#cdbb88", focus: "#e7c35a", parked: "#98a2ad",
};
const AUTO = ["#86bb76", "#78b08f", "#d4b47a", "#6fb2b4", "#c690a2", "#a596cc", "#93bb6f", "#7ab5a2"];
export const familyColor = (id) => new THREE.Color(GROUND[id] || AUTO[hash(id) % AUTO.length]);

const SIZES = { tent: [1, 300], house: [300, 5000], midrise: [5000, 50000], tower: [50000, 500000], skyscraper: [500000, 5000000] };
const SHED_COLORS = { worktree: "#7aa7e8", copy: "#b9b4a8", release: "#e8c46a", derived: "#b28ae0", submodule: "#8fc1c9", vendor: "#9aa1a8", orphan: "#e07a5f", clone: "#b9b4a8" };
const LIT = { live: 3, recent: 2, quiet: 1, dormant: 0, unknown: 0 };
// What buildings are made of: houses are cream with terracotta roofs, mid-rises stone, towers and skyscrapers glass.
const STUFF = {
  lot: { facade: ["#d9cdb4"], roof: ["#c46b4e"] },
  tent: { facade: ["#f3ead8", "#efe3cc", "#f6efe2"], roof: ["#c46b4e"] },
  house: { facade: ["#f1e4cf", "#efd9c1", "#ebdfcb", "#f4ead9", "#e8d3bb"], roof: ["#c46b4e", "#b85c44", "#a9533e", "#c77a52"] },
  midrise: { facade: ["#e7e2d7", "#ddd6c9", "#efe9de", "#d9cfbf", "#e3dacb"], roof: ["#8a8f96", "#7c8188"], metal: 0.05, rough: 0.7 },
  tower: { facade: ["#cdd8e0", "#c3d1dc", "#d6dee4", "#bfcdd9"], roof: ["#6f7b88"], metal: 0.28, rough: 0.38 },
  skyscraper: { facade: ["#b4c6d5", "#a9bdcf", "#bfcfdc"], roof: ["#5f6b78"], metal: 0.42, rough: 0.26 },
  warehouse: { facade: ["#cbc6ba", "#bfbaae", "#c7c0b0"], roof: ["#7f8b96", "#8b939a"], metal: 0.1, rough: 0.8 },
};
const pickOf = (list, rand) => list[Math.floor(rand() * list.length) % list.length];
// ---------- model styles ----------
// The same project facts can be drawn as buildings (the default) or as aircraft in a hangar. For aircraft the
// stage sets the class, size the scale, the island colour the livery and recent work the lit cabin windows.
export const MODEL_STYLES = ["buildings", "airplanes"];
let modelStyle = "buildings";
export function setModelStyle(next) {
  if (!MODEL_STYLES.includes(next) || next === modelStyle) return false;
  modelStyle = next;
  return true;
}
export const currentModelStyle = () => modelStyle;

// What sets a building's size: its commit count (how much work went into it), or its size on GitHub in megabytes.
// A project with no checkout here has no commit count, so it keeps its size-based building.
const SIZE_BY = ["commits", "megabytes"];
let sizeBy = "commits";
export function setSizeBy(next) {
  if (!SIZE_BY.includes(next) || next === sizeBy) return false;
  sizeBy = next;
  return true;
}
export const currentSizeBy = () => sizeBy;
const COMMIT_STAGES = [[15, "tent"], [60, "house"], [250, "midrise"], [1000, "tower"]];
const COMMIT_SIZES = { tent: [1, 15], house: [15, 60], midrise: [60, 250], tower: [250, 1000], skyscraper: [1000, 10000] };
/** The building class and where it sits inside that class (0 smallest, 1 largest). */
export function sizing(repo) {
  const n = repo.commitCount;
  if (sizeBy === "commits" && Number.isFinite(n) && repo.stage !== "warehouse") {
    const stage = n <= 0 ? "lot" : (COMMIT_STAGES.find(([limit]) => n < limit) || [0, "skyscraper"])[1];
    return { stage, t: stage === "lot" ? 0 : spanOf(COMMIT_SIZES[stage], n) };
  }
  return { stage: repo.stage, t: span(repo.stage, repo.sizeKB || 0) };
}

// len/body/span/chord in plot units; wing: 0 low, 0.5 mid, 1 high; sweep in radians.
const AIRCRAFT = {
  lot: { len: 2.5, body: 0.4, span: 4.6, chord: 0.42, wing: 0.5, sweep: 0, fin: 0.75, glider: true },
  tent: { len: 3.0, body: 0.72, span: 4.6, chord: 0.72, wing: 1, sweep: 0, fin: 0.95, nose: "prop" },
  house: { len: 3.8, body: 0.9, span: 5.0, chord: 0.95, wing: 0, sweep: 0.06, fin: 1.15, nose: "prop" },
  midrise: { len: 4.7, body: 0.95, span: 4.9, chord: 1.0, wing: 0, sweep: 0.36, fin: 1.4, rear: 2, tTail: true },
  tower: { len: 6.0, body: 1.25, span: 6.3, chord: 1.35, wing: 0, sweep: 0.42, fin: 1.95, under: 2 },
  skyscraper: { len: 7.0, body: 1.5, span: 7.4, chord: 1.6, wing: 0, sweep: 0.46, fin: 2.5, under: 4, hump: true },
  warehouse: { len: 5.3, body: 1.5, span: 6.6, chord: 1.2, wing: 1, sweep: 0, fin: 2.0, under: 2, props: true, tTail: true },
};
const FUSELAGE = ["#f4f6f8", "#eef1f5", "#f7f3ec", "#e9edf2"];


// ---------- shared resources ----------

function windowTextures() {
  // Four facades, from dark to busy: the same window grid with more of it lit.
  const ratios = [0, 0.14, 0.34, 0.56];
  return ratios.map((ratio, k) => {
    const cols = 8, rows = 16, cw = 16, ch = 16;
    const color = document.createElement("canvas"), glow = document.createElement("canvas");
    color.width = glow.width = cols * cw;
    color.height = glow.height = rows * ch;
    const g = color.getContext("2d"), e = glow.getContext("2d");
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, color.width, color.height);
    e.fillStyle = "#000000";
    e.fillRect(0, 0, glow.width, glow.height);
    const rand = rng(1000 + k);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const x = c * cw + 4, y = r * ch + 3, w = cw - 8, h = ch - 6;
      g.fillStyle = "#3b4757";
      g.fillRect(x, y, w, h);
      g.fillStyle = "rgba(255,255,255,0.18)";
      g.fillRect(x, y, w, 2);
      if (rand() < ratio) {
        const warm = rand();
        e.fillStyle = warm < 0.62 ? "#ffbe6e" : warm < 0.9 ? "#ffd9a0" : "#8fc8ff";
        e.fillRect(x, y, w, h);
      }
    }
    const make = (canvas, srgb) => {
      const t = new THREE.CanvasTexture(canvas);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.anisotropy = 4;
      return t;
    };
    return { map: make(color, true), glow: make(glow, true), cols, rows };
  });
}

export function createShared() {
  return {
    windows: windowTextures(),
    ghost: new THREE.MeshBasicMaterial({ color: "#78c4ff", transparent: true, opacity: 0.24, depthWrite: false }),
    ghostEdge: new THREE.LineBasicMaterial({ color: "#4fb0ff", transparent: true, opacity: 0.95 }),
    beacon: new THREE.MeshBasicMaterial({ color: "#ffe9a8" }),
    beam: new THREE.MeshBasicMaterial({ color: "#ffc46b", vertexColors: true, transparent: true, opacity: 0.0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }),
    red: new THREE.MeshBasicMaterial({ color: "#ff5a4f" }),
    dirt: new THREE.MeshStandardMaterial({ color: "#a98b62", roughness: 1, flatShading: true }),
    canvas: new THREE.MeshStandardMaterial({ color: "#f1ead8", roughness: 0.9, flatShading: true }),
    pole: new THREE.MeshStandardMaterial({ color: "#6b5a46", roughness: 1 }),
    flag: new THREE.MeshStandardMaterial({ color: "#ff7a2f", emissive: "#ff5a1a", emissiveIntensity: 0.25, roughness: 0.7, side: THREE.DoubleSide }),
    geo: {
      box: new THREE.BoxGeometry(1, 1, 1),
      block: wallsAndRoofBox(),
      tent: new THREE.ConeGeometry(1, 1, 4, 1).rotateY(Math.PI / 4),
      roof: new THREE.ConeGeometry(0.75, 1, 4, 1).rotateY(Math.PI / 4),
      beacon: new THREE.OctahedronGeometry(0.55, 0),
      beam: fadingBeam(),
      mound: new THREE.SphereGeometry(1, 7, 4, 0, Math.PI * 2, 0, Math.PI / 2),
      plot: new RoundedBoxGeometry(PLOT - 1.4, 0.6, PLOT - 1.4, 2, 0.28),
      shed: new RoundedBoxGeometry(1.15, 1.1, 1.15, 1, 0.18),
      pole: new THREE.CylinderGeometry(0.08, 0.1, 1, 5).translate(0, 0.5, 0),
      trunk: new THREE.CylinderGeometry(0.12, 0.17, 1.2, 5).translate(0, 0.6, 0),
      crown: new THREE.ConeGeometry(0.85, 2.0, 6).translate(0, 1.0, 0),
      rock: new THREE.DodecahedronGeometry(1, 0),
      pennant: pennantGeometry(),
      // Aircraft parts: a nose cone pointing +x with a square base the size of a unit box, and a nacelle along x.
      nose: new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1).rotateY(Math.PI / 4).rotateZ(-Math.PI / 2),
      nacelle: new THREE.CylinderGeometry(0.5, 0.42, 1, 10).rotateZ(-Math.PI / 2),
    },
    metal: new THREE.MeshStandardMaterial({ color: "#a7afb8", roughness: 0.38, metalness: 0.55 }),
    rubber: new THREE.MeshStandardMaterial({ color: "#2a2e35", roughness: 0.9 }),
  };
}

/** A small triangular flag: work waiting on GitHub. */
function pennantGeometry() {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 0, 0.9, 0, 1.25, 0.45, 0], 3));
  g.computeVertexNormals();
  return g;
}

/** A light beam that fades to nothing at the top (alpha in the vertex colours). */
function fadingBeam() {
  const g = new THREE.CylinderGeometry(0.42, 0.55, 1, 10, 6, true).translate(0, 0.5, 0);
  const pos = g.getAttribute("position"), col = new Float32Array(pos.count * 4);
  for (let i = 0; i < pos.count; i++) {
    const a = Math.pow(1 - pos.getY(i), 1.6);
    col.set([1, 1, 1, a], i * 4);
  }
  g.setAttribute("color", new THREE.BufferAttribute(col, 4));
  return g;
}

/** A unit box drawn in two calls (walls, then roof) instead of six, without the bottom face no one sees. */
function wallsAndRoofBox() {
  const g = new THREE.BoxGeometry(1, 1, 1);
  const idx = g.index.array, walls = [], roof = [];
  for (const grp of g.groups) {
    const part = Array.from(idx.slice(grp.start, grp.start + grp.count));
    if (grp.materialIndex === 2) roof.push(...part);
    else if (grp.materialIndex !== 3) walls.push(...part);
  }
  g.setIndex([...walls, ...roof]);
  g.clearGroups();
  g.addGroup(0, walls.length, 0);
  g.addGroup(walls.length, roof.length, 1);
  return g;
}

// ---------- islands ----------

export function islandGeometry(radius, seed, top) {
  const rand = rng(seed);
  const n = Math.max(28, Math.round(radius * 1.1));
  const ph = [rand() * 6.28, rand() * 6.28, rand() * 6.28];
  const outline = (a) => 1 + 0.05 * Math.sin(3 * a + ph[0]) + 0.035 * Math.sin(5 * a + ph[1]) + 0.025 * Math.sin(9 * a + ph[2]);
  const depth = clamp(radius * 1.05, 18, 70);
  const edge = top.clone().multiplyScalar(0.78);
  const soil = new THREE.Color("#8a6a4a"), rock = new THREE.Color("#6d6559"), deep = new THREE.Color("#4b4740");
  const rings = [
    { r: 1, y: 0, c: top }, { r: 1.005, y: -1.1, c: edge }, { r: 0.96, y: -3.2, c: soil },
    { r: 0.78, y: -depth * 0.32, c: rock, j: 0.07 }, { r: 0.5, y: -depth * 0.62, c: rock, j: 0.1 },
    { r: 0.22, y: -depth * 0.88, c: deep, j: 0.12 },
  ];
  const pts = rings.map((ring) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const rr = radius * ring.r * outline(a) * (1 + (ring.j ? (rand() - 0.5) * 2 * ring.j : 0));
      out.push(new THREE.Vector3(Math.cos(a) * rr, ring.y + (ring.j ? (rand() - 0.5) * 2 : 0), Math.sin(a) * rr));
    }
    return out;
  });
  const tip = new THREE.Vector3((rand() - 0.5) * 3, -depth, (rand() - 0.5) * 3);
  const pos = [], col = [];
  const tri = (a, b, c, color, vary = 0.06) => {
    pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    const k = 1 + (rand() - 0.5) * vary * 2;
    for (let i = 0; i < 3; i++) col.push(color.r * k, color.g * k, color.b * k);
  };
  const centre = new THREE.Vector3(0, 0, 0);
  for (let i = 0; i < n; i++) tri(centre, pts[0][(i + 1) % n], pts[0][i], top, 0.03);
  for (let k = 0; k < rings.length - 1; k++) {
    for (let i = 0; i < n; i++) {
      const a = pts[k][i], b = pts[k][(i + 1) % n], c = pts[k + 1][i], d = pts[k + 1][(i + 1) % n];
      tri(a, b, c, rings[k].c);
      tri(b, d, c, rings[k + 1].c);
    }
  }
  const last = pts[rings.length - 1];
  for (let i = 0; i < n; i++) tri(last[i], last[(i + 1) % n], tip, deep);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

export function buildIsland(spot, shared, shadows) {
  const group = new THREE.Group();
  group.position.set(spot.x, spot.y, spot.z);
  const color = familyColor(spot.id);
  const rock = new THREE.Mesh(islandGeometry(spot.radius, spot.seed, color),
    new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95, metalness: 0 }));
  rock.receiveShadow = shadows;
  rock.userData.island = spot;
  group.add(rock);

  const plots = new THREE.InstancedMesh(shared.geo.plot, new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.85 }), spot.cells.length);
  const m = new THREE.Matrix4();
  const paving = color.clone().lerp(new THREE.Color("#d8d2c2"), 0.5);
  const here = paving.clone().lerp(new THREE.Color("#fff4d6"), 0.35), away = paving.clone().multiplyScalar(0.94);
  spot.cells.forEach((cell, i) => {
    m.makeTranslation(cell.x, 0.3, cell.z);
    plots.setMatrixAt(i, m);
    plots.setColorAt(i, cell.repo.onMachine ? here : away);
  });
  plots.receiveShadow = shadows;
  plots.userData.island = spot;
  group.add(plots);

  const label = document.createElement("button");
  label.type = "button";
  label.setAttribute("aria-label", `Explore ${spot.family.name}, ${spot.cells.length} projects`);
  label.className = "district-label";
  label.innerHTML = `<span class="dot" style="background:#${color.getHexString()}"></span><b></b><i></i>`;
  label.querySelector("b").textContent = spot.family.name;
  label.querySelector("i").textContent = spot.cells.length;
  label.dataset.island = spot.id;
  const tag = new CSS2DObject(label);
  tag.position.set(0, 4, -spot.radius * 0.92);
  group.add(tag);

  return { spot, group, rock, plots, label, tag, color, bob: rng(spot.seed)() * 6.28 };
}

// ---------- buildings ----------

function spanOf([lo, hi], v) {
  return clamp((Math.log10(Math.max(v, 1)) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo)), 0, 1);
}
function span(stage, kb) {
  return spanOf(SIZES[stage] || [1, 10], kb);
}

export class Building {
  constructor(repo, cell, island, shared, shadows) {
    this.repo = repo;
    this.cell = cell;
    this.island = island;
    this.shared = shared;
    this.group = new THREE.Group();
    this.group.position.set(cell.x, 0.6, cell.z);
    this.pickables = [];
    this.facades = [];
    this.solids = [];
    this.lit = LIT[repo.recency] ?? 0;
    const rand = rng(hash(repo.id));
    ({ stage: this.stage, t: this.t } = sizing(repo));
    this.sizeBy = sizeBy;
    this.stuff = STUFF[this.stage] || STUFF.midrise;
    this.base = new THREE.Color(pickOf(this.stuff.facade, rand));
    this.base.offsetHSL(0, (rand() - 0.5) * 0.06, (rand() - 0.5) * 0.05);
    this.roofColor = this.stage === "house" || this.stage === "tent" || this.stage === "lot"
      ? new THREE.Color(pickOf(this.stuff.roof, rand))
      : new THREE.Color(pickOf(this.stuff.roof, rand)).lerp(familyColor(repo.family), 0.35);
    this.height = 0;
    this.style = modelStyle;
    this.make(rand, shadows);
    island.group.add(this.group);
    this.state = { tint: this.base.clone(), dim: 0, ghost: false, glow: 0, born: 1, hover: 0 };
    this.target = { tint: this.base.clone(), dim: 0, ghost: false, glow: 0, born: 1, hover: 0 };
    this.night = 0;
  }

  facade(w, h, d, rand) {
    const tex = this.shared.windows[this.lit];
    const floors = Math.max(1, Math.round(h / 1.35)), across = Math.max(1, Math.round(w / 1.15));
    const map = tex.map.clone(), glow = tex.glow.clone();
    const ox = Math.floor(rand() * tex.cols) / tex.cols, oy = Math.floor(rand() * tex.rows) / tex.rows;
    for (const t of [map, glow]) {
      t.repeat.set(across / tex.cols, floors / tex.rows);
      t.offset.set(ox, oy);
      t.needsUpdate = true;
    }
    const mat = new THREE.MeshStandardMaterial({ color: this.base.clone(), map, emissive: "#ffffff", emissiveMap: glow, emissiveIntensity: 0.1, roughness: this.stuff.rough ?? 0.62, metalness: this.stuff.metal ?? 0.05 });
    this.facades.push(mat);
    return mat;
  }

  roof() {
    const mat = new THREE.MeshStandardMaterial({ color: this.roofColor.clone(), roughness: 0.8, flatShading: true });
    this.solids.push(mat);
    return mat;
  }

  add(geo, mats, x, y, z, sx, sy, sz, shadows, pick = true) {
    const mesh = new THREE.Mesh(geo, mats);
    mesh.position.set(x, y, z);
    mesh.scale.set(sx, sy, sz);
    mesh.castShadow = mesh.receiveShadow = shadows;
    mesh.userData.building = this;
    this.group.add(mesh);
    if (pick) this.pickables.push(mesh);
    return mesh;
  }

  make(rand, shadows) {
    const r = this.repo, g = this.shared.geo, t = this.t;
    const box = (w, h, d, y = 0, x = 0, z = 0) => {
      const f = this.facade(w, h, d, rand), top = this.roof();
      this.add(g.block, [f, top], x, y + h / 2, z, w, h, d, shadows);
      return y + h;
    };
    let top = 0;
    if (this.style === "airplanes") top = this.aircraft(rand, shadows);
    else switch (this.stage) {
      case "lot": {
        for (let i = 0; i < 3; i++) this.add(g.mound, this.shared.dirt, (rand() - 0.5) * 3, 0, (rand() - 0.5) * 3, 0.7 + rand() * 0.6, 0.4 + rand() * 0.4, 0.7 + rand() * 0.6, shadows);
        this.add(g.pole, this.shared.pole, 1.6, 0, 1.6, 1, 1.6, 1, shadows);
        const sign = new THREE.MeshStandardMaterial({ color: familyColor(r.family), roughness: 0.9 });
        this.solids.push(sign);
        this.add(g.box, sign, 1.6, 1.55, 1.6, 1.1, 0.6, 0.12, shadows);
        top = 1.9;
        break;
      }
      case "tent": {
        const cloth = new THREE.MeshStandardMaterial({ color: familyColor(r.family).lerp(new THREE.Color("#ffffff"), 0.45), roughness: 0.95, flatShading: true });
        this.solids.push(cloth);
        const h = 2.2 + t * 0.8;
        this.add(g.tent, cloth, 0, h / 2, 0, 2.2, h, 2.2, shadows);
        top = h;
        break;
      }
      case "house": {
        const w = 3.3 + t * 0.6, h = 2.4 + t * 1.2;
        top = box(w, h, w * 0.86);
        const roof = this.roof();
        this.add(g.roof, roof, 0, top + 0.85, 0, w * 0.98, 1.7, w * 0.84, shadows);
        top += 1.7;
        break;
      }
      case "midrise": {
        const w = 3.6 + t * 0.6, h = 5 + t * 5;
        top = box(w, h, w * 0.9);
        this.add(g.box, this.roof(), (rand() - 0.5) * 1.2, top + 0.4, (rand() - 0.5) * 1.2, 1.2, 0.8, 1, shadows, false);
        top += 0.8;
        break;
      }
      case "tower": {
        const w = 3.6 + t * 0.4, h = 11 + t * 8;
        top = box(w, h * 0.72, w);
        top = box(w * 0.72, h * 0.28, w * 0.72, top);
        break;
      }
      case "skyscraper": {
        const w = 3.8, h = 21 + t * 14;
        top = box(w, h * 0.55, w);
        top = box(w * 0.8, h * 0.28, w * 0.8, top);
        top = box(w * 0.55, h * 0.17, w * 0.55, top);
        this.add(g.pole, this.shared.pole, 0, top, 0, 1.2, 4.5, 1.2, shadows, false);
        this.tip = this.add(g.beacon, this.shared.red, 0, top + 4.6, 0, 0.32, 0.32, 0.32, false, false);
        top += 4.8;
        break;
      }
      case "warehouse": {
        const w = 5.2, h = 2.4 + t;
        top = box(w, h, 3.6);
        this.add(g.roof, this.roof(), 0, top + 0.5, 0, w * 1.05, 1, 3.4, shadows, false);
        top += 1;
        break;
      }
      default:
        top = box(3.2, 3, 3);
    }
    this.height = top;

    if (r.homepage) {
      this.beacon = this.add(g.beacon, this.shared.beacon, 0, top + 1.2, 0, 1, 1.25, 1, false, false);
      this.beam = this.add(g.beam, this.shared.beam.clone(), 0, top + 1.2, 0, 1, 1, 1, false, false);
      this.beam.scale.set(1, 42, 1);
      this.beam.visible = false;
    }
    if (r.openPRs) {
      // An orange pennant on the roof: pull requests waiting on you. Bigger when more are waiting.
      const k = 1.5 + Math.min(r.openPRs, 10) * 0.1, x = this.mount?.x ?? (this.stage === "tent" ? 0.6 : 1.1), z = this.mount?.z ?? x * 0.3;
      this.add(g.pole, this.shared.pole, x, top - 0.1, z, 1, 2.4 * k, 1, shadows, false);
      this.pennant = this.add(g.pennant, this.shared.flag, x, top + 1.25 * k, z, k, k, k, shadows, false);
      this.pennant.rotation.y = -0.6;
      this.flagTop = top + 2.4 * k;
    }
    // A shed per extra folder; pale when it holds nothing unique, in its role's colour when it might.
    this.sheds = r.sites.filter((s) => !["canonical", "orphan", "vendor"].includes(s.role)).map((s) => ({
      role: s.role,
      spare: !!s.spare && s.spare.commitsElsewhere && !s.spare.ignored.length && !s.spare.ignoredMore && !(s.dirty || 0),
    }));
  }

  /** An aircraft parked on the plot, nose along the island's diagonal. Returns the top of its tail fin. */
  aircraft(rand, shadows) {
    const r = this.repo, g = this.shared.geo, spec = AIRCRAFT[this.stage] || AIRCRAFT.house;
    const k = (1 + this.t * 0.14) * 1.12;
    const len = spec.len * k, body = spec.body * k, wingSpan = spec.span * k, chord = spec.chord * k;
    const thick = (spec.glider ? 0.06 : 0.1) * k, gear = spec.glider ? 0.14 : 0.34 * k, y0 = gear + body / 2;
    this.group.rotation.y = -Math.PI / 4 + (rand() - 0.5) * 0.16;
    // White fuselage with a row of cabin windows on each side; the island's colour is the livery.
    this.base.set(pickOf(FUSELAGE, rand));
    this.roofColor = familyColor(r.family).offsetHSL(0, 0.28, -0.24);  // a deeper shade of the island, so planes stand out from its ground
    const paint = new THREE.MeshStandardMaterial({ color: this.base.clone(), roughness: 0.5, metalness: 0.06, flatShading: true });
    this.facades.push(paint);
    const cabin = len * 0.6, windows = this.facade(cabin * 2.1, 1.35, body, rand), livery = this.roof();
    const front = -len * 0.04 + cabin / 2, back = -len * 0.04 - cabin / 2, noseLen = len * 0.18, tailLen = len * 0.26;
    this.add(g.box, [paint, paint, paint, paint, windows, windows], -len * 0.04, y0, 0, cabin, body, body, shadows);
    this.add(g.nose, paint, front + noseLen / 2, y0, 0, noseLen, body, body, shadows);
    const tail = this.add(g.nose, paint, back - tailLen / 2, y0 + body * 0.12, 0, tailLen, body * 0.82, body * 0.9, shadows);
    tail.rotation.y = Math.PI;
    const wing = (x, y, width, c, sweep, mat) => {
      for (const side of [-1, 1]) {
        const half = width / 2;
        const m = this.add(g.box, mat, x - Math.sin(sweep) * half / 2, y, side * Math.cos(sweep) * half / 2, c, thick, half, shadows);
        m.rotation.y = -side * sweep;
      }
    };
    const wingY = gear + body * (spec.wing === 1 ? 0.96 : spec.wing === 0.5 ? 0.5 : 0.14), wingX = -len * 0.04 + cabin * 0.06;
    wing(wingX, wingY, wingSpan, chord, spec.sweep, livery);
    // A swept fin with a long root reads as a tail from any angle; a tall thin one reads as a pole.
    const finH = spec.fin * k * 0.72, tailX = back - tailLen * 0.42;
    const fin = this.add(g.box, livery, tailX, y0 + body / 2 + finH / 2, 0, Math.max(chord * 1.05, tailLen * 0.7), finH, Math.max(thick * 1.6, 0.14 * k), shadows);
    fin.rotation.z = 0.5;
    wing(tailX - finH * 0.3, spec.tTail ? y0 + body / 2 + finH * 0.95 : y0 + body * 0.18, wingSpan * 0.36, chord * 0.6, spec.sweep, livery);
    const nacelle = (x, y, z, size) => this.add(g.nacelle, this.shared.metal, x, y, z, size * 1.9, size, size, shadows);
    if (spec.under) {
      const reach = wingSpan / 2, places = spec.under === 4 ? [0.3, 0.56] : [0.34];
      for (const f of places) for (const side of [-1, 1]) nacelle(wingX - Math.sin(spec.sweep) * reach * f + chord * 0.25, wingY - body * (spec.wing === 1 ? -0.05 : 0.3), side * reach * f, body * 0.4);
    }
    if (spec.rear) for (const side of [-1, 1]) nacelle(tailX + tailLen * 0.15, y0 + body * 0.25, side * body * 0.85, body * 0.42);
    if (spec.nose === "prop" || spec.props) {
      // Propellers: one on the nose, or one on each wing engine.
      const blades = spec.props ? [-1, 1].map(side => [wingX + chord * 0.75, wingY - body * 0.05, side * wingSpan * 0.17]) : [[front + noseLen + 0.04, y0, 0]];
      for (const [x, y, z] of blades) this.add(g.box, this.shared.rubber, x, y, z, 0.06, body * (spec.props ? 1.1 : 1.5), body * 0.16, shadows, false);
    }
    if (spec.hump) this.add(g.box, paint, front - cabin * 0.2, y0 + body * 0.55, 0, cabin * 0.34, body * 0.38, body * 0.78, shadows);
    if (!spec.glider) this.add(g.box, this.shared.rubber, wingX, gear / 2, 0, chord * 0.7, gear, body * 0.7, shadows, false);
    this.mount = { x: tailX, z: 0 };
    return y0 + body / 2 + finH;
  }

  /** Placed by the island after construction: the small sheds that stand for extra local folders. */
  shedSpots() {
    const out = [], n = Math.min(this.sheds.length, 16), half = (PLOT - 1.6) / 2;
    for (let i = 0; i < n; i++) {
      const side = i % 4, k = Math.floor(i / 4), along = -half + 0.75 + k * 1.45;
      const p = [[along, -half], [half, along], [-along, half], [-half, -along]][side];
      out.push({ x: this.cell.x + p[0], z: this.cell.z + p[1], ...this.sheds[i] });
    }
    return out;
  }

  setTarget(t) {
    Object.assign(this.target, t);
  }

  /** Eases towards the target; true while still moving. */
  step(dt) {
    if (this.delayUntil) {
      if (performance.now() < this.delayUntil) return true;
      this.delayUntil = 0;
    }
    const s = this.state, t = this.target, k = 1 - Math.exp(-dt * 9);
    let moving = false;
    const ease = (key) => {
      const d = t[key] - s[key];
      if (Math.abs(d) > 0.002) { s[key] += d * k; moving = true; } else s[key] = t[key];
    };
    ease("dim"); ease("glow"); ease("born"); ease("hover");
    if (!s.tint.equals(t.tint)) {
      s.tint.lerp(t.tint, k);
      if (Math.abs(s.tint.r - t.tint.r) + Math.abs(s.tint.g - t.tint.g) + Math.abs(s.tint.b - t.tint.b) < 0.004) s.tint.copy(t.tint);
      moving = true;
    }
    if (s.ghost !== t.ghost) this.setGhost((s.ghost = t.ghost));
    this.apply();
    return moving;
  }

  apply() {
    const s = this.state, grey = new THREE.Color("#8e9399");
    const color = s.tint.clone().lerp(grey, s.dim * 0.75).multiplyScalar(1 - s.dim * 0.35);
    const windows = lerp(0.06, 0.95, this.night) * (1 - s.dim) * (this.lit ? 1 : 0.4);
    for (const m of this.facades) {
      m.color.copy(color);
      m.emissiveIntensity = windows + s.hover * 0.35;
    }
    for (const m of this.solids) m.color.copy(this.roofColor).lerp(grey, s.dim * 0.7);
    const born = Math.max(0.001, s.born);
    this.group.scale.set(1, born * (1 + s.hover * 0.05), 1);
    this.group.visible = this.onMap !== false && s.born > 0.02;
    if (this.beacon) {
      this.beacon.visible = s.dim < 0.6;
      this.beam.visible = s.glow > 0.02;
      // A night sky takes the beam as added light; on a pale day sky added light turns white, so by day it is painted amber and shorter.
      const day = this.night < 0.5;
      if (this.beam.userData.day !== day) {
        this.beam.userData.day = day;
        this.beam.material.blending = day ? THREE.NormalBlending : THREE.AdditiveBlending;
        this.beam.material.color.set(day ? "#e8962c" : "#ffc46b");
        this.beam.scale.y = day ? 16 : 42;
      }
      this.beam.material.opacity = s.glow * (day ? 0.7 : lerp(0.55, 0.8, this.night));
    }
  }

  setGhost(on) {
    for (const mesh of this.group.children) {
      if (!mesh.isMesh || mesh === this.beam) continue;
      if (on) {
        mesh.userData.real ??= mesh.material;
        mesh.material = this.shared.ghost;
        mesh.castShadow = false;
        if (!mesh.userData.edges && mesh.geometry.type !== "OctahedronGeometry") {
          const e = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 30), this.shared.ghostEdge);
          mesh.add(e);
          mesh.userData.edges = e;
        }
        if (mesh.userData.edges) mesh.userData.edges.visible = true;
      } else if (mesh.userData.real) {
        mesh.material = mesh.userData.real;
        mesh.castShadow = this.island.shadows;
        if (mesh.userData.edges) mesh.userData.edges.visible = false;
      }
    }
  }

  setNight(n) {
    this.night = n;
    this.apply();
  }

  worldTop(v = new THREE.Vector3()) {
    return this.group.localToWorld(v.set(0, this.height + 1, 0));
  }
}

export function buildSheds(island, buildings, shared, shadows) {
  const spots = buildings.flatMap((b) => b.shedSpots());
  if (!spots.length) return null;
  const mesh = new THREE.InstancedMesh(shared.geo.shed, new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.8, flatShading: true }), spots.length);
  const m = new THREE.Matrix4(), c = new THREE.Color();
  spots.forEach((s, i) => {
    m.makeTranslation(s.x, 1.15, s.z);
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, s.spare ? c.set("#e9e6df") : c.set(SHED_COLORS[s.role] || "#b9b4a8"));
  });
  mesh.castShadow = mesh.receiveShadow = shadows;
  island.group.add(mesh);
  return mesh;
}

export const shedColor = (role) => SHED_COLORS[role] || "#b9b4a8";

// ---------- scenery ----------
// The empty grass around the plots carries a mood: busy districts grow fresh green trees, quiet ones turn
// yellow-green, dormant ones are in autumn. The desert gets rocks, the vendor yard crates, and what is off the map
// only bare trunks.
const LEAVES = {
  live: ["#5f9e4a", "#6aac52", "#4f8f43", "#78b55a"],
  recent: ["#7aa84c", "#8db454", "#6f9f47"],
  quiet: ["#a7b14e", "#b9a94a", "#94a548"],
  dormant: ["#d08a3c", "#c9652f", "#b8853f", "#d6a64a", "#a85a2e"],
};

function districtMood(spot) {
  const w = { live: 3, recent: 2, quiet: 1, dormant: 0, unknown: 0 };
  const avg = spot.cells.reduce((s, c) => s + (w[c.repo.recency] ?? 0), 0) / Math.max(1, spot.cells.length);
  return avg >= 2.2 ? "live" : avg >= 1.5 ? "recent" : avg >= 0.8 ? "quiet" : "dormant";
}

function freeSpots(spot, rand, want) {
  const out = [], r = spot.radius * 0.9, clear = PLOT * 0.62;
  for (let tries = 0; out.length < want && tries < want * 30; tries++) {
    const a = rand() * Math.PI * 2, d = Math.sqrt(0.15 + rand() * 0.85) * r;
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    if (spot.cells.some((c) => Math.abs(c.x - x) < clear && Math.abs(c.z - z) < clear)) continue;
    if (out.some((p) => Math.hypot(p.x - x, p.z - z) < 2.2)) continue;
    out.push({ x, z, s: 0.75 + rand() * 0.6, rot: rand() * Math.PI * 2 });
  }
  return out;
}

export function decorate(isl, shared, shadows, lite) {
  const spot = isl.spot, rand = rng(spot.seed ^ 0x9e3779b9);
  const area = Math.PI * spot.radius * spot.radius - spot.cells.length * PLOT * PLOT;
  const want = Math.min(lite ? 18 : 46, Math.max(4, Math.round(area / (lite ? 90 : 46))));
  const spots = freeSpots(spot, rand, want);
  if (!spots.length) return;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), c = new THREE.Color(), up = new THREE.Vector3(0, 1, 0);
  const put = (mesh, i, x, y, z, sx, sy, sz, rot) => {
    q.setFromAxisAngle(up, rot);
    m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(sx, sy, sz));
    mesh.setMatrixAt(i, m);
  };
  const add = (mesh) => {
    mesh.castShadow = mesh.receiveShadow = shadows;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    isl.group.add(mesh);
  };
  const g = shared.geo;
  if (spot.id === "vendor") {
    const crates = new THREE.InstancedMesh(g.box, new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.9, flatShading: true }), spots.length * 2);
    let n = 0;
    for (const p of spots) {
      const tone = ["#a07a52", "#8f6c48", "#7d8a94", "#b08d5c"][Math.floor(rand() * 4)];
      put(crates, n, p.x, 0.55, p.z, 1.1 * p.s, 1.1 * p.s, 1.1 * p.s, p.rot);
      crates.setColorAt(n++, c.set(tone));
      if (rand() < 0.5) {
        put(crates, n, p.x + 0.1, 0.55 + 1.1 * p.s, p.z, 0.9 * p.s, 0.9 * p.s, 0.9 * p.s, p.rot + 0.4);
        crates.setColorAt(n++, c.set(tone).multiplyScalar(0.9));
      }
    }
    crates.count = n;
    return add(crates);
  }
  const rockCount = Math.ceil(spots.length * 0.25);
  const rocks = new THREE.InstancedMesh(g.rock, new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 1, flatShading: true }), rockCount);
  const ground = familyColor(spot.id);
  for (let i = 0; i < rockCount; i++) {
    const p = spots[spots.length - 1 - i];
    put(rocks, i, p.x, 0.2, p.z, 0.7 * p.s, 0.5 * p.s, 0.6 * p.s, p.rot);
    rocks.setColorAt(i, c.copy(ground).lerp(new THREE.Color("#8d867a"), 0.6).multiplyScalar(0.85 + rand() * 0.2));
  }
  add(rocks);
  const trees = spots.slice(0, spots.length - rockCount);
  if (!trees.length) return;
  const bare = spot.id === "offmap";
  const trunks = new THREE.InstancedMesh(g.trunk, shared.pole, trees.length);
  trees.forEach((p, i) => put(trunks, i, p.x, 0, p.z, p.s, p.s * (bare ? 1.6 : 1), p.s, p.rot));
  add(trunks);
  if (bare) return;
  const leaves = LEAVES[districtMood(spot)];
  const crowns = new THREE.InstancedMesh(g.crown, new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.85, flatShading: true }), trees.length);
  trees.forEach((p, i) => {
    put(crowns, i, p.x, 1.05 * p.s, p.z, p.s, p.s * (0.9 + rand() * 0.4), p.s, p.rot);
    crowns.setColorAt(i, c.set(leaves[Math.floor(rand() * leaves.length)]));
  });
  add(crowns);
}
