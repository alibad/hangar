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
  const blocks = [];
  const rectilinear = ["airplanes", "museum", "mechanical"].includes(style);
  for (const [index, s] of plan.islands.entries()) {
    const rand = rng(s.seed ^ hash(style)), n = s.cells.length;
    const a = index * GOLDEN;
    let x = Math.cos(a) * Math.sqrt(index) * 82, z = Math.sin(a) * Math.sqrt(index) * 82, y = 0;
    let positions = [];
    if (style === "airplanes") {
      // Balanced terminal blocks, each with opposing gate rows.
      const cols = Math.max(2, Math.ceil(Math.sqrt(n * 1.1)));
      positions = s.cells.map((_, i) => ({
        x: (Math.floor(i / 2) % cols - (cols - 1) / 2) * 14,
        y: 0.12, z: Math.floor(i / (cols * 2)) * 36 + (i % 2 ? 9 : -9),
        heading: i % 2 ? Math.PI / 2 : -Math.PI / 2,
      }));
    } else if (style === "museum" || style === "mechanical") {
      const gap = style === "museum" ? 11 : 10;
      const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
      positions = s.cells.map((_, i) => ({
        x: (i % cols - (cols - 1) / 2) * gap, y: 0.12,
        z: (Math.floor(i / cols) - (Math.ceil(n / cols) - 1) / 2) * gap, heading: null,
      }));
    } else if (style === "fleet") {
      y = Math.sin(a) * 15;
      positions = s.cells.map((c, i) => { const row = Math.ceil((Math.sqrt(8 * (i + 1) + 1) - 1) / 2), at = i - row * (row - 1) / 2; return { x: (at - row / 2) * 12, y: (rand() - 0.5) * 4, z: row * 11, heading: Math.PI }; });
    } else if (style === "garden") {
      const cols = Math.ceil(Math.sqrt(n * 1.7)), rows = Math.ceil(n / cols);
      positions = s.cells.map((_, i) => {
        const row = Math.floor(i / cols);
        const x = (i % cols - (cols - 1) / 2) * 9;
        return { x, y: 0.12, z: (row - (rows - 1) / 2) * 11 + Math.sin(x * 0.09 + row) * 2.4, heading: null };
      });
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
    const label = { x: focus.x, y: focus.y + 10, z: focus.z - radius * 0.65 };
    const group = { x, y, z, radius, focus, label };
    groups.set(s.id, group);
    if (rectilinear) {
      const padding = style === "airplanes" ? 28 : 23;
      const left = Math.min(...positions.map(p => p.x)) - padding / 2;
      const top = Math.min(...positions.map(p => p.z)) - padding / 2;
      blocks.push({ group, left, top, width: (focus.x - left) * 2, height: (focus.z - top) * 2 });
    }
    s.cells.forEach((cell, i) => projects.set(cell.repo.id, positions[i]));
  }
  if (rectilinear) {
    // Place large blocks first, then fill the gaps next to and below them.
    // Rectangular terminals and galleries need not fill an entire row by themselves.
    const width = Math.max(1, ...blocks.map(b => b.width), Math.sqrt(blocks.reduce((area, b) => area + b.width * b.height, 0)) * 1.2);
    const placed = [];
    for (const block of blocks.sort((a, b) => b.width * b.height - a.width * a.height)) {
      const xs = [0, ...placed.map(p => p.x + p.width)].sort((a, b) => a - b);
      const zs = [0, ...placed.map(p => p.z + p.height)].sort((a, b) => a - b);
      const z = zs.find(z => xs.some(x => fits(x, z)));
      const x = xs.find(x => fits(x, z));
      block.group.x = x - block.left;
      block.group.z = z - block.top;
      placed.push({ x, z, width: block.width, height: block.height });

      function fits(x, z) {
        return x + block.width <= width && placed.every(p =>
          x + block.width <= p.x || x >= p.x + p.width || z + block.height <= p.z || z >= p.z + p.height);
      }
    }
  } else {
    // Fit each group as close as possible to the existing scene.
    const placed = [];
    for (const s of plan.islands) {
      const g = groups.get(s.id);
      g.x = 0; g.z = 0;
      if (placed.length) {
        const start = (hash(s.id) % 360) * Math.PI / 180;
        let found = false;
        for (let d = 6; !found; d += 6) {
          const steps = Math.max(12, Math.ceil(d * Math.PI / 4));
          for (let step = 0; step < steps; step++) {
            const a = start + step / steps * Math.PI * 2;
            const x = Math.cos(a) * d, z = Math.sin(a) * d;
            if (!placed.every(o => Math.hypot(x - o.x, z - o.z) >= g.radius + o.radius + 5)) continue;
            g.x = x; g.z = z; found = true; break;
          }
        }
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
  const axis = key => [Math.min(...worldPositions.map(p => p[key])), Math.max(...worldPositions.map(p => p[key]))];
  if (!worldPositions.length) worldPositions.push({ x: 0, y: 0, z: 0 });
  const [minX, maxX] = axis("x"), [minY, maxY] = axis("y"), [minZ, maxZ] = axis("z");
  const runwayX = minX - 37;
  if (style === "airplanes") {
    worldPositions.push({ x: runwayX - 12, y: 0, z: minZ - 32 }, { x: runwayX + 12, y: 0, z: maxZ + 32 });
  }
  const center = { x: ((style === "airplanes" ? runwayX - 12 : minX) + maxX) / 2, y: (minY + maxY) / 2 + 3, z: (minZ + maxZ) / 2 };
  const extent = Math.max(32, Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2 + 18);
  for (const g of groups.values()) { g.x -= center.x; g.y = isLandscape(style) ? 0 : g.y - center.y; g.z -= center.z; }
  if (isLandscape(style)) for (const s of plan.islands) for (const c of s.cells) { const g = groups.get(s.id), p = projects.get(c.repo.id); p.y += groundHeight(style, g.x + p.x, g.z + p.z); }
  const points = worldPositions.map(p => ({ x: p.x - center.x, y: isLandscape(style) ? p.y : p.y - center.y, z: p.z - center.z }));
  return { style, groups, projects, points, extent, axisX: runwayX - center.x, center: { x: 0, y: 0, z: 0 }, phi: style === "airplanes" ? 0.57 : style === "constellation" ? 0.88 : style === "neural" ? 1.03 : style === "fleet" ? 0.92 : ["forest", "mountains", "reef"].includes(style) ? 1.03 : 0.85, theta: style === "airplanes" ? -0.6 : style === "neural" ? 0.45 : 0.72 };
}

/** Sparse, explainable edges. Cross-category edges require an observed shared topic. */
export function compositionEdges(plan, composition, includeHidden = false) {
  const edges = [], seen = new Set(), all = plan.islands.flatMap(s => s.cells).filter(c => includeHidden || !c.repo.hidden);
  const point = cell => { const g = composition.groups.get(cell.repo.family), p = composition.projects.get(cell.repo.id); return { x: g.x + p.x, y: g.y + p.y + 1, z: g.z + p.z }; };
  const add = (a, b, reason) => { const key = [a.repo.id, b.repo.id].sort().join("|"); if (seen.has(key)) return; seen.add(key); edges.push({ a: a.repo.id, b: b.repo.id, from: point(a), to: point(b), reason }); };
  for (const family of plan.islands) {
    // With no category membership, proximity would invent a connection.
    if (family.id === "uncategorized") continue;
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
