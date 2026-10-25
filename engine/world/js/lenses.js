// Lenses: the same city, asked a different question. Each one only sets targets; buildings ease towards them.
import * as THREE from "three";

const C = (hex) => new THREE.Color(hex);
const ACTIVITY = { live: C("#ffad4d"), recent: C("#f4d35e"), quiet: C("#78c6a3"), dormant: C("#8399b3"), unknown: C("#a0a4a8") };
export const CHANGE = { push: "#ff5f52", commit: "#ffb03b", pull: "#4aa3ff", prs: "#c084fc" };
const CHANGE_C = Object.fromEntries(Object.entries(CHANGE).map(([k, v]) => [k, C(v)]));

/** What is waiting on a repo: uncommitted changes, commits not on GitHub, a pull needed, pull requests to review. */
export function pending(r) {
  const dirty = r.sites.reduce((n, s) => n + (s.dirty || 0), 0);
  const push = r.risks.find((k) => k.id === "unpushed" || k.id === "offmap") || null;
  const pull = r.risks.find((k) => k.id === "pull") || null;
  const prs = r.openPRs || 0;
  return { dirty, push, pull, prs, any: !!(dirty || push || pull || prs) };
}

const level = (r) => (r.risks.some((k) => k.level === "high") ? "high" : r.risks.some((k) => k.level === "medium") ? "medium" : null);

export const LENSES = [
  {
    id: "working", name: "Live work", key: "6", icon: "pulse",
    hint: "Observed Hangar coding jobs; past sessions do not imply running work",
    legend: [{ color: "#ffb85c", label: "Agent working" }],
    target: (r, b) => ({ tint: b.base, dim: 0.85, ghost: false, glow: 0 }),
  },
  {
    id: "map", name: "Map", key: "1", icon: "map",
    hint: "Every repo you own, by district",
    legend: [],
    target: (r, b) => ({ tint: b.base, dim: 0, ghost: false, glow: 0 }),
  },
  {
    id: "changes", name: "Changes", key: "2", icon: "changes",
    hint: "What is waiting on you: uncommitted work, commits not on GitHub, pulls to make, pull requests to review",
    legend: [
      { color: CHANGE.commit, label: "Uncommitted" }, { color: CHANGE.push, label: "Not pushed" },
      { color: CHANGE.pull, label: "Needs a pull" }, { color: CHANGE.prs, label: "Pull requests waiting" },
    ],
    target: (r, b) => {
      const p = pending(r);
      if (!p.any) return { tint: b.base, dim: 0.7, ghost: false, glow: 0 };
      const tint = p.push ? CHANGE_C.push : p.dirty ? CHANGE_C.commit : p.pull ? CHANGE_C.pull : CHANGE_C.prs;
      return { tint, dim: 0, ghost: false, glow: 0 };
    },
  },
  {
    id: "where", name: "Where", key: "3", icon: "device",
    hint: "Solid: on this machine. Hologram: only on GitHub or another machine",
    legend: [
      { swatch: "solid", label: "On this machine" },
      { swatch: "ghost", label: "Not here" },
      { swatch: "shed", label: "Extra folder with something of its own" },
      { swatch: "shed spare", label: "Extra folder with nothing unique" },
    ],
    target: (r, b) => ({ tint: b.base, dim: 0, ghost: !r.onMachine, glow: 0 }),
  },
  {
    id: "activity", name: "Activity", key: "4", icon: "pulse",
    hint: "How recently each repo was worked on",
    legend: [
      { color: "#ffad4d", label: "This month" }, { color: "#f4d35e", label: "3 months" },
      { color: "#78c6a3", label: "This year" }, { color: "#8399b3", label: "Dormant" },
    ],
    target: (r) => ({ tint: ACTIVITY[r.recency] || ACTIVITY.unknown, dim: 0, ghost: false, glow: 0 }),
  },
  {
    id: "shipped", name: "Shipped", key: "5", icon: "beacon",
    hint: "Repos with a website address on GitHub (the Website field on the repo page)",
    legend: [{ color: "#ffd98a", label: "Has a website address" }],
    target: (r, b) => (r.homepage ? { tint: b.base, dim: 0, ghost: false, glow: 1 } : { tint: b.base, dim: 0.85, ghost: false, glow: 0 }),
  },
];

/** Hangar's one everyday view: the map as it is, with the layers the host turns on instead of separate lenses. */
export const DEFAULT_VIEW = {
  id: "default", name: "Map", icon: "map", hint: "", legend: [],
  target: (r, b, layers = {}) => ({
    tint: layers.activity ? ACTIVITY[r.recency] || ACTIVITY.unknown : b.base, dim: 0,
    ghost: !!layers.where && !r.onMachine, glow: layers.websites && r.homepage ? 1 : 0,
  }),
};
export const LAYERS = { attention: true, apps: true, work: true, where: true, activity: false, websites: false };

const OLD = { pulse: "activity", live: "shipped", risk: "changes" }; // links made before the rename keep working
export const lensById = (id) => id === "default" ? DEFAULT_VIEW : LENSES.find((l) => l.id === (OLD[id] || id)) || LENSES.find(l => l.id === "changes");
export const riskLevel = level;
