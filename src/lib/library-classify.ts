// The Library's rules for what a file on disk IS: its kind, which studio made
// it, its project, its faction, and whether Faction Studio approved it.
//
// Pure functions only (no filesystem, no "@/" imports), so
// scripts/library-classify.test.mjs runs them straight under node --test.

import { inflateSync } from "node:zlib";

export type Shelf = "videos" | "generated" | "datasets";
export type MediaKind = "image" | "video" | "sound" | "model" | "collection";
export type ReviewStatus = "draft" | "approved" | "rejected";

export const SHELVES: { id: Shelf; label: string }[] = [
  { id: "videos", label: "Videos" },
  { id: "generated", label: "Generated" },
  { id: "datasets", label: "Datasets" },
];

const KIND_BY_EXT: Record<string, MediaKind> = {
  ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image", ".gif": "image", ".bmp": "image",
  ".mp4": "video", ".webm": "video", ".mov": "video", ".mkv": "video", ".m4v": "video", ".avi": "video",
  ".wav": "sound", ".mp3": "sound", ".ogg": "sound", ".flac": "sound", ".m4a": "sound", ".opus": "sound",
  // .glb only: the 3D Lab writes a .ply beside some meshes, and the same model
  // twice is noise. A .gltf can point at files beside it, which the viewer
  // can't fetch through one id.
  ".glb": "model",
};

export function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot).toLowerCase();
}

export function kindOf(name: string): MediaKind | null {
  return KIND_BY_EXT[extOf(name)] ?? null;
}

export function stemOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? name : name.slice(0, dot);
}

/** Pictures that exist to show something else: a 3D job's input, a clip's still. */
const POSTER_NAME = /^(cutout|mesh_cutout|source|mesh_base|poster|thumb|thumbnail|cover)\.(png|jpe?g|webp)$/i;
/** Previews a pipeline renders of its own candidates, not candidates themselves. */
const DERIVED_NAME = /^preview-/i;

export function isPosterName(name: string): boolean {
  return POSTER_NAME.test(name);
}

/**
 * The files in one folder that the Library shows, and the picture each model or
 * clip is shown with. A model's poster is the cutout or source image of its 3D
 * job; a clip's is a picture with the same name.
 */
export function pickItems(names: string[]): { items: { name: string; kind: MediaKind; poster: string | null }[]; posters: Set<string> } {
  const kinds = new Map(names.map((n) => [n, kindOf(n)] as const));
  const images = names.filter((n) => kinds.get(n) === "image");
  const byStem = new Map(images.map((n) => [stemOf(n).toLowerCase(), n]));
  const posterOrder = ["mesh_cutout", "cutout", "source", "mesh_base", "poster", "cover", "thumb", "thumbnail"];
  const folderPoster = posterOrder.map((s) => images.find((n) => stemOf(n).toLowerCase() === s)).find(Boolean) ?? null;
  const hasModels = names.some((n) => kinds.get(n) === "model");
  const posters = new Set<string>();
  const items: { name: string; kind: MediaKind; poster: string | null }[] = [];
  for (const name of names) {
    const kind = kinds.get(name);
    if (kind === "model" || kind === "video") {
      const own = byStem.get(stemOf(name).toLowerCase()) ?? null;
      const poster = own ?? (kind === "model" ? folderPoster : null);
      if (poster) posters.add(poster);
      items.push({ name, kind, poster });
    } else if (kind === "sound") {
      items.push({ name, kind, poster: null });
    }
  }
  for (const name of images) {
    if (posters.has(name) || DERIVED_NAME.test(name)) continue;
    // A 3D job's input pictures belong to its models even when one is unused.
    if (hasModels && isPosterName(name)) continue;
    items.push({ name, kind: "image", poster: null });
  }
  return { items, posters };
}

/** Where Hangar's own studios write, so an output says which studio made it. */
export type StudioDirs = { gallery: string; archive: string; music: string; effects: string };

/** Lower-cased and with forward slashes, for comparing Windows paths. */
export function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function isInside(child: string, parent: string): boolean {
  const c = normPath(child);
  const p = normPath(parent);
  return c === p || c.startsWith(p + "/");
}

export function studioFor(file: string, kind: MediaKind, dirs: StudioDirs): string | null {
  const f = normPath(file);
  const g = normPath(dirs.gallery);
  if (isInside(f, dirs.music)) return "music";
  if (isInside(f, dirs.effects)) return "effects";
  if (isInside(f, dirs.archive)) return "image";
  if (isInside(f, g)) {
    const first = f.slice(g.length + 1).split("/")[0];
    if (first === "3d" || first === "3d-sources") return "3d";
    if (first === "video") return "video";
    if (first === "forge") return "forge";
    if (first === "music") return "music";
    if (first === "effects") return "effects";
    return kind === "video" ? "video" : kind === "model" ? "3d" : kind === "sound" ? "effects" : "image";
  }
  // ComfyUI runs Hangar's image and video workflows.
  if (/\/comfyui[^/]*\//.test(f + "/")) return kind === "video" ? "video" : kind === "image" ? "image" : null;
  return null;
}

/** The names a folder gets on the shelf, where its disk name reads badly. */
const PROJECT_NAMES: Record<string, string> = { "comfyui output": "ComfyUI" };

export function projectName(folder: string): string {
  return PROJECT_NAMES[folder.toLowerCase()] ?? folder;
}

// ── Faction Studio: draft or approved ──────────────────────────────────────

export type ReviewEntry = { chosen: Set<string>; rejected: Set<string> };
export type ReviewMap = Map<string, ReviewEntry>;

/** RTSAI-Art/review.json → unit → the candidates its slots chose or rejected. */
export function readReview(json: unknown): ReviewMap {
  const map: ReviewMap = new Map();
  if (!json || typeof json !== "object") return map;
  for (const [unit, value] of Object.entries(json as Record<string, unknown>)) {
    const slots = (value as { slots?: Record<string, { chosen?: string | null; rejected?: string[] }> })?.slots ?? {};
    const entry: ReviewEntry = { chosen: new Set(), rejected: new Set() };
    for (const slot of Object.values(slots)) {
      if (slot?.chosen) entry.chosen.add(slot.chosen.toLowerCase());
      for (const r of slot?.rejected ?? []) entry.rejected.add(String(r).toLowerCase());
    }
    map.set(unit.toLowerCase(), entry);
  }
  return map;
}

/**
 * A file's review status, from its path. A candidate under `units/<unit>/
 * candidates/<candidate>/` is approved or rejected when its unit's review says
 * so. Everything under D:\Generated\RTSAI is a draft by that folder's own rule
 * (approved files move into git), unless the review names its candidate.
 */
export function reviewStatus(file: string, review: ReviewMap, draftsRoot: string | null): ReviewStatus | null {
  const parts = normPath(file).split("/");
  const at = parts.lastIndexOf("candidates");
  const inDrafts = !!draftsRoot && isInside(file, draftsRoot);
  if (at > 0 && at + 1 < parts.length - 1) {
    const unit = parts[at - 1];
    const candidate = parts[at + 1];
    const entry = review.get(unit);
    if (entry?.chosen.has(candidate)) return "approved";
    if (entry?.rejected.has(candidate)) return "rejected";
    return "draft";
  }
  if (inDrafts) {
    for (const [unit, entry] of review) {
      if (!parts.includes(unit)) continue;
      if (parts.some((p) => entry.chosen.has(stemOf(p)))) return "approved";
      if (parts.some((p) => entry.rejected.has(stemOf(p)))) return "rejected";
    }
    return "draft";
  }
  return null;
}

/** The faction a file belongs to: a faction folder in its path, else its unit's. */
export function factionFor(file: string, factions: Set<string>, unitFaction: Map<string, string>): string | null {
  const parts = normPath(file).split("/");
  for (const p of parts) if (factions.has(p)) return p;
  for (const p of parts) {
    const hit = unitFaction.get(p);
    if (hit) return hit;
  }
  return null;
}

/** Actor ids a rules file defines: its top-level YAML keys. */
export function yamlActors(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/^([A-Za-z0-9_.-]+):\s*(?:#.*)?$/gm)) out.push(m[1].toLowerCase());
  return out;
}

// ── prompts ────────────────────────────────────────────────────────────────

export type PromptInfo = { prompt: string | null; model: string | null };

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** The prompt and model in a sidecar, whichever studio wrote it. */
export function promptFromSidecar(meta: unknown): PromptInfo {
  if (!meta || typeof meta !== "object") return { prompt: null, model: null };
  const m = meta as Record<string, unknown>;
  const meshes = Array.isArray(m.meshes) ? (m.meshes as Record<string, unknown>[]) : [];
  const request = (m.request && typeof m.request === "object" ? m.request : {}) as Record<string, unknown>;
  const prompt = text(m.prompt) ?? text(request.prompt) ?? text(m.caption) ?? text(m.subject) ?? text(m.description) ?? text(m.title) ?? text(m.name);
  const model = text(m.model) ?? text(request.model) ?? text(meshes[0]?.model) ?? text(m.checkpoint) ?? text(m.engine);
  return { prompt, model };
}

/** tEXt, zTXt and iTXt chunks of a PNG (ComfyUI keeps its prompt graph there). */
export function pngText(buf: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (buf.length < 8 || sig.some((b, i) => buf[i] !== b)) return out;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const latin = new TextDecoder("latin1");
  const utf8 = new TextDecoder("utf-8");
  let pos = 8;
  while (pos + 8 <= buf.length) {
    const len = view.getUint32(pos);
    const type = latin.decode(buf.subarray(pos + 4, pos + 8));
    const start = pos + 8;
    const end = start + len;
    if (end > buf.length || type === "IDAT" || type === "IEND") break;
    const data = buf.subarray(start, end);
    const nul = data.indexOf(0);
    if (nul > 0) {
      const key = latin.decode(data.subarray(0, nul));
      try {
        if (type === "tEXt") out[key] = latin.decode(data.subarray(nul + 1));
        else if (type === "zTXt") out[key] = latin.decode(inflateSync(data.subarray(nul + 2)));
        else if (type === "iTXt") {
          const compressed = data[nul + 1] === 1;
          let p = nul + 3;
          p = data.indexOf(0, p) + 1; // language tag
          p = data.indexOf(0, p) + 1; // translated keyword
          const body = data.subarray(p);
          out[key] = utf8.decode(compressed ? inflateSync(body) : body);
        }
      } catch {
        /* a damaged chunk is skipped, the rest still read */
      }
    }
    pos = end + 4;
  }
  return out;
}

/** The words and checkpoint in a ComfyUI prompt graph. */
export function promptFromComfy(graphJson: string): PromptInfo {
  let graph: Record<string, { class_type?: string; inputs?: Record<string, unknown> }>;
  try {
    graph = JSON.parse(graphJson);
  } catch {
    return { prompt: null, model: null };
  }
  const texts: string[] = [];
  let model: string | null = null;
  for (const node of Object.values(graph ?? {})) {
    const inputs = node?.inputs ?? {};
    const cls = String(node?.class_type ?? "");
    for (const key of ["text", "prompt", "positive", "text_g"]) {
      const t = text(inputs[key]);
      if (t && /text|prompt|encode/i.test(cls) && !/negative/i.test(cls) && !texts.includes(t)) texts.push(t);
    }
    model ??= text(inputs.ckpt_name) ?? text(inputs.unet_name) ?? text(inputs.model_name);
  }
  return { prompt: texts[0] ?? null, model };
}

// ── datasets ───────────────────────────────────────────────────────────────

/** A dataset folder with more media than this is one card with samples. */
export const COLLECTION_MIN = 1000;

/** `count` picks spread evenly through a list, so samples aren't all frame 1-12. */
export function spread<T>(list: T[], count: number): T[] {
  if (list.length <= count) return list.slice();
  const step = list.length / count;
  return Array.from({ length: count }, (_, i) => list[Math.floor(i * step + step / 2)]);
}
