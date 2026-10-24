// Where everything goes. Districts become islands on a spiral, busiest nearest the middle and the quiet ones
// (the attic, the vendor yard, what is off the map) on the outside. On an island, repos sit on a grid with the
// busiest in the middle. Deterministic: the same data always draws the same world.
import { hash, rng } from "./util.js";

export const PLOT = 7; // distance between plot centres
const GAP = 14; // clear air between islands
const OUTSKIRTS = new Set(["attic", "vendor", "offmap", "borrowed", "reading", "parked"]);
const RECENCY_WEIGHT = { live: 4, recent: 3, quiet: 2, dormant: 1, unknown: 1 };

export function repoScore(r) {
  return RECENCY_WEIGHT[r.recency] * 10 + Math.log10((r.sizeKB || 1) + 1) + (r.homepage ? 3 : 0) + (r.onMachine ? 1 : 0);
}

function cellsBySpiral(cols, rows) {
  const cells = [];
  const cx = (cols - 1) / 2, cz = (rows - 1) / 2;
  for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) cells.push([i - cx, j - cz]);
  return cells.sort((a, b) => Math.hypot(...a) - Math.hypot(...b) || Math.atan2(a[1], a[0]) - Math.atan2(b[1], b[0]));
}

export function layout(doc) {
  const byFamily = new Map(doc.families.map((f) => [f.id, { ...f, members: [] }]));
  for (const r of doc.repos) if (!r.hidden) byFamily.get(r.family)?.members.push(r);
  const fams = [...byFamily.values()].filter((f) => f.members.length);
  for (const f of fams) {
    f.members.sort((a, b) => repoScore(b) - repoScore(a) || a.name.localeCompare(b.name));
    f.score = f.members.reduce((s, r) => s + repoScore(r), 0) / Math.sqrt(f.members.length) + f.members.length;
    if (OUTSKIRTS.has(f.id)) f.score -= 1000;
    if (f.id === "focus") f.score += 100000; // what you are working on now sits in the middle
  }
  fams.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  const islands = [];
  for (const f of fams) {
    const n = f.members.length;
    const cols = Math.ceil(Math.sqrt(n * 1.3));
    const rows = Math.ceil(n / cols);
    const radius = (Math.hypot(cols, rows) * PLOT) / 2 + 5;
    const rand = rng(hash(f.id));
    const island = { id: f.id, family: f, radius, x: 0, z: 0, y: (rand() - 0.5) * 6, seed: hash(f.id), cells: [] };
    place(island, islands, rand);
    const spots = cellsBySpiral(cols, rows);
    f.members.forEach((r, i) => {
      const [cx, cz] = spots[i];
      island.cells.push({ repo: r, x: cx * PLOT, z: cz * PLOT });
    });
    islands.push(island);
  }
  let extent = 0;
  for (const s of islands) extent = Math.max(extent, Math.hypot(s.x, s.z) + s.radius);
  return { islands, extent };
}

function place(island, placed, rand) {
  if (!placed.length) return;
  const start = rand() * Math.PI * 2;
  for (let d = placed[0].radius + island.radius + GAP; ; d += 3) {
    const steps = Math.max(12, Math.round(d / 3));
    for (let k = 0; k < steps; k++) {
      const a = start + (k / steps) * Math.PI * 2;
      const x = Math.cos(a) * d, z = Math.sin(a) * d;
      if (placed.every((o) => Math.hypot(o.x - x, o.z - z) >= o.radius + island.radius + GAP)) {
        island.x = x;
        island.z = z;
        return;
      }
    }
  }
}
