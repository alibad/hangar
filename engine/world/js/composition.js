// A view is a spatial interpretation, independent of the catalog's stable seats.
// Categories are grouping evidence, not physical boundaries or dependency claims.
import { hash, rng } from "./util.js";

const GOLDEN = Math.PI * (3 - Math.sqrt(5));
export const isLandscape = style => ["forest", "garden", "reef", "mountains", "mechanical", "museum", "airplanes"].includes(style);
export function groundHeight(style, x, z) {
  if (style === "forest") return Math.sin(x * 0.026) * Math.cos(z * 0.022) * 3;
  if (style === "reef") return Math.sin(x * 0.035 + z * 0.012) * 1.4 + Math.cos(z * 0.03) * 1.1;
  if (style === "mountains") return Math.sin(x * 0.021) * Math.cos(z * 0.018) * 6 + Math.sin((x + z) * 0.037) * 2;
  return 0;
}

/** Deterministic positions, including hidden seats so a hide/restore never shuffles neighbors. */
export function composeWorld(plan, style) {
  const groups = new Map(), projects = new Map();
  if (style === "buildings") {
    for (const s of plan.islands) {
      groups.set(s.id, { x: s.x, y: s.y, z: s.z, radius: s.radius, label: { x: 0, y: 4, z: -s.radius * 0.92 } });
      for (const c of s.cells) projects.set(c.repo.id, { x: c.x, y: 0.6, z: c.z, heading: null });
    }
    return { style, groups, projects, extent: plan.extent, center: { x: 0, y: -3, z: 0 }, phi: 1, theta: 0.72 };
  }
  const count = plan.islands.length;
  let airportZ = [0, 0];
  const widest = Math.max(3, ...plan.islands.map(s => Math.min(10, Math.ceil(s.cells.length / 2))));
  for (const [index, s] of plan.islands.entries()) {
    const rand = rng(s.seed ^ hash(style)), n = s.cells.length;
    const a = index * GOLDEN;
    let x = Math.cos(a) * Math.sqrt(index) * 82, z = Math.sin(a) * Math.sqrt(index) * 82, y = 0;
    let positions = [];
    if (style === "airplanes") {
      const side = index % 2 ? 1 : -1, rows = Math.ceil(n / (widest * 2));
      x = side * 40; z = airportZ[index % 2] + 18;
      airportZ[index % 2] += Math.max(1, rows) * 48 + 20;
      positions = s.cells.map((c, i) => ({ x: side * (18 + (Math.floor(i / 2) % widest) * 12), y: 0.65, z: Math.floor(i / (widest * 2)) * 48 + (i % 2 ? 11 : -11), heading: i % 2 ? Math.PI / 2 : -Math.PI / 2 }));
    } else if (style === "museum") {
      const cols = Math.max(2, Math.ceil(Math.sqrt(n)));
      const across = Math.ceil(Math.sqrt(count));
      const stride = Math.max(80, ...plan.islands.map(f => Math.ceil(Math.sqrt(f.cells.length)) * 14 + 24));
      x = (index % across) * stride; z = Math.floor(index / across) * stride;
      positions = s.cells.map((c, i) => ({ x: (i % cols - (cols - 1) / 2) * 12, y: 0.5, z: (Math.floor(i / cols) - (Math.ceil(n / cols) - 1) / 2) * 14, heading: null }));
    } else if (style === "mechanical") {
      const stride = Math.max(70, ...plan.islands.map(f => Math.ceil(Math.sqrt(f.cells.length)) * 10 + 24));
      x = (index % 4) * stride; z = Math.floor(index / 4) * stride;
      const cols = Math.max(2, Math.ceil(Math.sqrt(n)));
      positions = s.cells.map((c, i) => ({ x: (i % cols - (cols - 1) / 2) * 10 + (Math.floor(i / cols) % 2 ? 5 : 0), y: 0.6, z: Math.floor(i / cols) * 10, heading: null }));
    } else if (style === "fleet") {
      y = Math.sin(a) * 15;
      positions = s.cells.map((c, i) => { const row = Math.ceil((Math.sqrt(8 * (i + 1) + 1) - 1) / 2), at = i - row * (row - 1) / 2; return { x: (at - row / 2) * 12, y: (rand() - 0.5) * 4, z: row * 11, heading: Math.PI }; });
    } else if (style === "garden") {
      positions = s.cells.map((c, i) => { const t = (i - (n - 1) / 2) * 9; return { x: t, y: 0.4, z: Math.sin(t * 0.075) * 9, heading: null }; });
    } else if (style === "constellation") {
      y = Math.sin(a * 1.7) * 24;
      positions = s.cells.map((c, i) => { const phase = i * 1.16 + rand(), distance = 8 + Math.sqrt(i) * 12; return { x: Math.cos(phase) * distance, y: (rand() - 0.5) * 24, z: Math.sin(phase) * distance * 0.6, heading: null }; });
    } else if (style === "neural") {
      y = Math.sin(a) * 22;
      positions = s.cells.map((c, i) => { const r = 10 + Math.sqrt(i) * 10, p = i * GOLDEN; return { x: Math.cos(p) * r, y: (rand() - 0.5) * 35, z: Math.sin(p) * r, heading: null }; });
    } else {
      // Spiral sampling gives groves, coral and planetary systems a loose, irregular structure.
      positions = s.cells.map((c, i) => { const angle = i * GOLDEN + rand() * 0.3, d = Math.sqrt(i + 0.5) * (style === "galaxy" ? 13 : 9); return { x: Math.cos(angle) * d, y: style === "galaxy" ? Math.sin(angle * 2) * 7 : 0, z: Math.sin(angle) * d * (style === "mountains" ? 0.65 : 1), heading: null }; });
      if (style === "galaxy") { y = Math.sin(a) * 12; x *= 1.2; z *= 0.75; }
    }
    const midpoint = key => (Math.min(...positions.map(p => p[key])) + Math.max(...positions.map(p => p[key]))) / 2;
    const focus = { x: midpoint("x"), y: midpoint("y"), z: midpoint("z") };
    const radius = Math.max(14, ...positions.map(p => Math.hypot(p.x - focus.x, p.y - focus.y, p.z - focus.z) + 7));
    const label = style === "airplanes" ? { x: 0, y: 6, z: -20 } : { x: focus.x, y: focus.y + 7, z: focus.z - radius * 0.7 };
    groups.set(s.id, { x, y, z, radius, focus, side: index % 2 ? 1 : -1, label });
    s.cells.forEach((cell, i) => projects.set(cell.repo.id, positions[i]));
  }
  // Pack organic families without fences; their spacing follows their actual occupied extent.
  if (!["airplanes", "museum", "mechanical"].includes(style)) {
    const placed = [];
    for (const s of plan.islands) {
      const g = groups.get(s.id);
      for (let attempt = 0; attempt < 1000; attempt++) {
        const collision = placed.find(o => Math.hypot(g.x - o.x, g.z - o.z) < g.radius + o.radius + 14);
        if (!collision) break;
        const angle = (placed.length + attempt * 0.1) * GOLDEN, d = Math.sqrt(attempt + placed.length) * 20;
        g.x = Math.cos(angle) * d; g.z = Math.sin(angle) * d;
      }
      placed.push(g);
    }
  }
  if (style === "neural") {
    const nodes = plan.islands.flatMap(s => s.cells.map(c => { const g = groups.get(s.id), p = projects.get(c.repo.id); return { id: c.repo.id, family: s.id, x: g.x + p.x, y: g.y + p.y, z: g.z + p.z }; }));
    const byId = new Map(nodes.map((node, index) => [node.id, index]));
    const edges = compositionEdges(plan, { style, groups, projects }, true).map(e => [byId.get(e.a), byId.get(e.b), e.reason]);
    const anchors = nodes.map(p => ({ ...p }));
    for (let pass = 0; pass < 100; pass++) {
      const force = nodes.map(() => [0, 0, 0]);
      for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j], delta = [a.x - b.x, a.y - b.y, a.z - b.z], d = Math.max(1, Math.hypot(...delta)), k = 80 / (d * d);
        for (let axis = 0; axis < 3; axis++) { force[i][axis] += delta[axis] / d * k; force[j][axis] -= delta[axis] / d * k; }
      }
      for (const [i, j, reason] of edges) {
        const a = nodes[i], b = nodes[j], delta = [b.x - a.x, b.y - a.y, b.z - a.z], d = Math.max(1, Math.hypot(...delta)), k = (d - 18) * (reason === "category" ? 0.025 : 0.007);
        for (let axis = 0; axis < 3; axis++) { force[i][axis] += delta[axis] / d * k; force[j][axis] -= delta[axis] / d * k; }
      }
      nodes.forEach((node, i) => ["x", "y", "z"].forEach((key, axis) => { node[key] += Math.max(-2, Math.min(2, force[i][axis] + (anchors[i][key] - node[key]) * 0.0005)); }));
    }
    for (const s of plan.islands) {
      const members = nodes.filter(n => n.family === s.id), g = groups.get(s.id);
      for (const key of ["x", "y", "z"]) g[key] = members.reduce((sum, n) => sum + n[key], 0) / Math.max(1, members.length);
      for (const node of members) Object.assign(projects.get(node.id), { x: node.x - g.x, y: node.y - g.y, z: node.z - g.z });
      g.radius = Math.max(14, ...members.map(n => Math.hypot(n.x - g.x, n.y - g.y, n.z - g.z) + 7));
      g.label = { x: 0, y: g.radius * 0.5 + 6, z: 0 }; g.focus = { x: 0, y: 0, z: 0 };
    }
  }
  // Center the scene around its actual footprint, rather than the first category.
  const worldPositions = [];
  for (const s of plan.islands) {
    const g = groups.get(s.id);
    for (const c of s.cells) {
      const p = projects.get(c.repo.id);
      worldPositions.push({ x: g.x + p.x, y: g.y + p.y, z: g.z + p.z });
    }
  }
  const axis = key => [Math.min(0, ...worldPositions.map(p => p[key])), Math.max(0, ...worldPositions.map(p => p[key]))];
  const [minX, maxX] = axis("x"), [minY, maxY] = axis("y"), [minZ, maxZ] = axis("z");
  const center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 + 3, z: (minZ + maxZ) / 2 };
  const extent = Math.max(32, Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2 + 18);
  for (const g of groups.values()) { g.x -= center.x; g.y = isLandscape(style) ? 0 : g.y - center.y; g.z -= center.z; }
  if (isLandscape(style)) for (const s of plan.islands) for (const c of s.cells) { const g = groups.get(s.id), p = projects.get(c.repo.id); p.y += groundHeight(style, g.x + p.x, g.z + p.z); }
  return { style, groups, projects, extent, axisX: -center.x, center: { x: 0, y: 0, z: 0 }, phi: style === "airplanes" ? 0.57 : style === "constellation" ? 0.88 : style === "neural" ? 1.03 : style === "fleet" ? 0.92 : ["forest", "mountains", "reef"].includes(style) ? 1.03 : 0.85, theta: style === "airplanes" ? -0.6 : style === "neural" ? 0.45 : 0.72 };
}

/** Sparse, explainable edges. Cross-category edges require an observed shared topic. */
export function compositionEdges(plan, composition, includeHidden = false) {
  const edges = [], seen = new Set(), all = plan.islands.flatMap(s => s.cells).filter(c => includeHidden || !c.repo.hidden);
  const point = cell => { const g = composition.groups.get(cell.repo.family), p = composition.projects.get(cell.repo.id); return { x: g.x + p.x, y: g.y + p.y + 1, z: g.z + p.z }; };
  const add = (a, b, reason) => { const key = [a.repo.id, b.repo.id].sort().join("|"); if (seen.has(key)) return; seen.add(key); edges.push({ a: a.repo.id, b: b.repo.id, from: point(a), to: point(b), reason }); };
  for (const family of plan.islands) {
    const cells = family.cells.filter(c => includeHidden || !c.repo.hidden);
    for (let i = 1; i < cells.length; i++) {
      const p = point(cells[i]); let nearest = cells[0], distance = Infinity;
      for (let j = 0; j < i; j++) { const q = point(cells[j]), d = Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z); if (d < distance) { nearest = cells[j]; distance = d; } }
      add(cells[i], nearest, "category");
    }
  }
  if (composition.style === "neural") for (const cell of all) {
    const topics = new Set((cell.repo.topics || []).filter(t => typeof t === "string"));
    if (!topics.size) continue;
    const p = point(cell);
    const matches = all.filter(other => other.repo.family !== cell.repo.family && (other.repo.topics || []).some(t => topics.has(t)));
    matches.sort((a, b) => { const x = point(a), y = point(b); return Math.hypot(x.x - p.x, x.y - p.y, x.z - p.z) - Math.hypot(y.x - p.x, y.y - p.y, y.z - p.z); });
    if (matches.length) add(cell, matches[0], "shared topic");
  }
  return edges;
}
