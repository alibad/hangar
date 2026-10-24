// Small helpers shared by the world and the interface.
import { api } from "./host.js";

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOut = (t) => 1 - Math.pow(1 - t, 3);

/** FNV-1a: a stable number from a string, so the same repo always gets the same building. */
export function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** A seeded random stream (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const UNITS = [
  ["year", 365 * 864e5], ["month", 30 * 864e5], ["week", 7 * 864e5], ["day", 864e5], ["hour", 36e5], ["minute", 6e4],
];

/** "3 days ago", "in 2 hours", "just now". */
export function ago(iso, now = Date.now()) {
  if (!iso) return "never";
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "unknown";
  if (Math.abs(ms) < 6e4) return "just now";
  for (const [name, size] of UNITS) {
    const n = Math.floor(Math.abs(ms) / size);
    if (n >= 1) return ms > 0 ? `${n} ${name}${n > 1 ? "s" : ""} ago` : `in ${n} ${name}${n > 1 ? "s" : ""}`;
  }
  return "just now";
}

export const fmtDate = (iso) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "";

export function fmtSize(kb) {
  if (!kb) return "empty";
  if (kb < 1024) return `${kb} KB`;
  if (kb < 1024 * 1024) return `${(kb / 1024).toFixed(kb < 10240 ? 1 : 0)} MB`;
  return `${(kb / 1024 / 1024).toFixed(1)} GB`;
}

/** Subsequence match with bonuses for word starts and runs; 0 means no match. */
export function fuzzy(query, text) {
  const q = query.toLowerCase().replace(/\s+/g, "");
  const t = text.toLowerCase();
  if (!q) return 1;
  const direct = t.indexOf(q);
  if (direct >= 0) return 1000 - direct - (t.length - q.length) * 0.5;
  let score = 0, ti = 0, run = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return 0;
    run = found === ti ? run + 1 : 0;
    const wordStart = found === 0 || /[-_ ./]/.test(t[found - 1]);
    score += 10 + run * 5 + (wordStart ? 15 : 0) - (found - ti);
    ti = found + 1;
  }
  return Math.max(1, score);
}

/** A repo's own logo as a small image (null when it has none, or on a shared copy without folders). */
export function logoImg(r, size = 20) {
  const logo = (r.sites || []).find((s) => s.logo)?.logo;
  if (!logo) return null;
  const img = document.createElement("img");
  img.className = "logo";
  img.alt = "";
  img.width = img.height = size;
  img.loading = "lazy";
  img.decoding = "async";
  img.src = api(`/api/logo?repo=${encodeURIComponent(r.id)}&v=${logo.hash}`);
  img.addEventListener("error", () => img.remove());
  return img;
}

export const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (k === "html") n.innerHTML = v;
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid.nodeType ? kid : String(kid));
  return n;
};

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
