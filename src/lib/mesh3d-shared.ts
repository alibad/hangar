/**
 * The parts of the 3D pipeline that are pure: artifact path rules, the prompt
 * scaffold, the detail knob. No imports, so the Lab (browser), the routes
 * (server) and scripts/mesh3d.test.mjs (Node, types stripped) share one copy.
 */

/** Every artifact lives under <outputDir>/3d/<job>/. */
export const MESH_ROOT = "3d";

const JOB_ID = /^[0-9]{8}-[0-9]{6}-[a-z0-9-]{1,40}$/;
const SERVABLE = /^3d\/[0-9]{8}-[0-9]{6}-[a-z0-9-]{1,40}\/[a-z0-9._-]{1,80}\.(png|glb|json)$/;

/** A job id from a client. Strict, because it becomes a directory name. */
export function isJobId(id: unknown): id is string {
  return typeof id === "string" && JOB_ID.test(id);
}

/**
 * A servable artifact path, normalised, or null: only .png/.glb/.json directly
 * inside 3d/<job>/ — never a traversal, never another gallery folder.
 */
export function servableRel(rel: string | null | undefined): string | null {
  if (!rel) return null;
  const norm = rel.replace(/\\/g, "/");
  if (norm.includes("..") || !SERVABLE.test(norm)) return null;
  return norm;
}

const STOP = new Set(["a", "an", "the", "of", "with", "and", "in", "on", "for", "its", "full", "body"]);

/**
 * The noun SAM 3 should segment, guessed from a description: the last content
 * word of its head phrase — before the first comma and before clauses like
 * "with …", "wearing …" or "standing …", which describe the object rather than
 * name it ("a windsor chair with splayed legs" is a chair, not legs). A guess;
 * the Lab lets you correct it.
 */
export function lastNoun(subject: string): string {
  const head = subject
    .toLowerCase()
    .split(",")[0]
    .split(/\b(?:with|wearing|made of|holding|standing|sitting|lying|that|which|in|on|for)\b/)[0];
  const words = head
    .replace(/[^a-z\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w));
  return words[words.length - 1] ?? "";
}

/** Prompt scaffolding that makes a text-to-image model draw something a 3D model can lift. */
export function objectPrompt(subject: string): string {
  return `${subject.trim()}, a single object, whole and centred, three-quarter view, isolated on a plain light grey studio background, soft even lighting, sharp focus, no shadow clutter, no text`;
}

/** The detail knob, mapped per model family: "resolution" means different things to each. */
export const DETAIL = [
  { id: "draft", label: "Draft", trellis: 512, triposr: 256 },
  { id: "standard", label: "Standard", trellis: 1024, triposr: 320 },
  { id: "high", label: "High", trellis: 1536, triposr: 384 },
] as const;
export type Detail = (typeof DETAIL)[number]["id"];

export function resolutionFor(model: string, detail: Detail): number {
  const d = DETAIL.find((x) => x.id === detail) ?? DETAIL[1];
  if (/tripo/i.test(model)) return d.triposr;
  // Pixal3D publishes only a 1024 texture flow: at 512 trellis.cpp falls back to
  // raw, untextured geometry (measured: 1.29M triangles, 65K open edges). So its
  // Draft is 1024.
  if (/pixal/i.test(model)) return Math.max(1024, d.trellis);
  return d.trellis;
}

/**
 * The resource-policy workload that guards a mesh service: `<serviceId>-generate`.
 * One convention rather than a lookup table, so a new mesh service needs only
 * its policy entry.
 */
export function meshWorkload(serviceId: string): string {
  return `${serviceId}-generate`;
}

/** Which way is up in a model's GLB, when it is not glTF's +Y. */
export type UpAxis = "+x" | "-x" | "+z" | "-z" | "-y";

/** The quaternion [x, y, z, w] that turns `up` into +Y. */
const TO_Y_UP: Record<UpAxis, [number, number, number, number]> = {
  "-z": [Math.SQRT1_2, 0, 0, Math.SQRT1_2], // +90° about X
  "+z": [-Math.SQRT1_2, 0, 0, Math.SQRT1_2], // -90° about X
  "+x": [0, 0, Math.SQRT1_2, Math.SQRT1_2], // +90° about Z
  "-x": [0, 0, -Math.SQRT1_2, Math.SQRT1_2], // -90° about Z
  "-y": [1, 0, 0, 0], // 180° about X
};

/**
 * Stand a GLB upright by wrapping its scene in one rotated root node — an edit
 * to the JSON chunk only, so geometry and textures are untouched byte for byte.
 *
 * For models that reconstruct in the input camera's frame (Pixal3D arrives
 * with up along -Z), declared per model as `upAxis` in config/model-meta.json.
 * Returns the input unchanged if it is not a GLB it understands.
 */
export function orientGlb(glb: Uint8Array, up: UpAxis): Uint8Array {
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  if (glb.byteLength < 20 || dv.getUint32(0, true) !== 0x46546c67 || dv.getUint32(16, true) !== 0x4e4f534a) return glb;
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLen))) as {
    scene?: number;
    scenes?: { nodes?: number[] }[];
    nodes?: Record<string, unknown>[];
  };
  const scene = json.scenes?.[json.scene ?? 0];
  if (!scene?.nodes?.length) return glb;
  json.nodes = json.nodes ?? [];
  json.nodes.push({ name: `to-y-up(${up})`, rotation: TO_Y_UP[up], children: scene.nodes });
  scene.nodes = [json.nodes.length - 1];

  let text = new TextEncoder().encode(JSON.stringify(json));
  const pad = (4 - (text.length % 4)) % 4;
  if (pad) {
    const padded = new Uint8Array(text.length + pad).fill(0x20); // JSON chunk pads with spaces
    padded.set(text);
    text = padded;
  }
  const rest = glb.subarray(20 + jsonLen); // the BIN chunk, header included, as-is
  const out = new Uint8Array(12 + 8 + text.length + rest.length);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, 0x46546c67, true); // "glTF"
  ov.setUint32(4, 2, true);
  ov.setUint32(8, out.length, true);
  ov.setUint32(12, text.length, true);
  ov.setUint32(16, 0x4e4f534a, true); // "JSON"
  out.set(text, 20);
  out.set(rest, 20 + text.length);
  return out;
}

/** A GLB file name that says what made it. */
export function glbName(model: string, resolution: number | null, seed: number): string {
  return `${model}-${resolution ?? "default"}-s${seed}.glb`.toLowerCase().replace(/[^a-z0-9._-]/g, "-");
}

/**
 * One record per file, the latest winning, in first-made order. A re-run
 * under the same name (same model, detail and seed, or the same body pick)
 * overwrote the file, so the older record describes a mesh that is gone.
 */
export function latestByFile<T extends { file?: unknown }>(meshes: T[]): T[] {
  const last = new Map<unknown, T>();
  for (const m of meshes) last.set(m.file, m);
  return meshes.filter((m) => last.get(m.file) === m);
}

// ── people (the 3D Lab's Person mode, SAM 3D Body) ──────────────────────────

/** What the 3D Lab turns into 3D: an object (mesh models) or a person (body + pose). */
export type Subject3d = "object" | "person";

/** Where the 3D Lab remembers which mode a viewer was last in (per browser). */
export const SUBJECT_STORAGE_KEY = "bt-3d-subject";

/**
 * Ask the 3D Lab to open in `subject` mode next time it mounts — for links that
 * mean "3D of a person": the old #sam3d tab, and SAM 3D Body's Open button.
 */
export function preferSubject(subject: Subject3d): void {
  try {
    globalThis.localStorage?.setItem(SUBJECT_STORAGE_KEY, subject);
  } catch {
    /* storage can be unavailable; the Lab then opens in its last mode */
  }
}

/** The capability a mode draws its models from. */
export function capabilityFor(subject: Subject3d): "3d" | "3d-body" {
  return subject === "person" ? "3d-body" : "3d";
}

/** Prompt scaffolding for a person photo a body model can read: one person, whole, unoccluded. */
export function personPrompt(subject: string): string {
  return `${subject.trim()}, one person only, full body visible from head to feet, nothing blocking the body, plain light grey studio background, even lighting, sharp focus, photograph`;
}

/**
 * The box that tells SAM 3D Body which person to reconstruct, from a SAM 3
 * cutout box in source pixels: normalised to 0-1 and grown by `margin` on every
 * side, because SAM 3D Body crops to it and a tight box clips hands and feet.
 */
export function personBox(
  box: [number, number, number, number],
  width: number,
  height: number,
  margin = 0.08,
): [number, number, number, number] {
  const [x1, y1, x2, y2] = box;
  const mx = (x2 - x1) * margin;
  const my = (y2 - y1) * margin;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const r = (v: number) => Math.round(v * 1e4) / 1e4;
  return [r(clamp((x1 - mx) / width)), r(clamp((y1 - my) / height)), r(clamp((x2 + mx) / width)), r(clamp((y2 + my) / height))];
}

/**
 * SAM 3D Body's mesh (camera frame: x right, y down, z away from the camera) as a
 * GLB: turned 180° about X so it stands Y-up facing the viewer — a rotation, so
 * handedness and triangle winding survive — with smooth normals and one neutral
 * clay material. The body carries no texture; the shape is the result.
 */
export function bodyGlb(vertices: number[][], faces: number[][]): Uint8Array {
  const n = vertices.length;
  const pos = new Float32Array(n * 3);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    const p = [vertices[i][0], -vertices[i][1], -vertices[i][2]];
    for (let k = 0; k < 3; k++) {
      pos[i * 3 + k] = p[k];
      if (p[k] < min[k]) min[k] = p[k];
      if (p[k] > max[k]) max[k] = p[k];
    }
  }
  const idx = new Uint32Array(faces.length * 3);
  for (let f = 0; f < faces.length; f++) idx.set(faces[f].slice(0, 3), f * 3);

  // Area-weighted vertex normals: the cross product's length is twice the area.
  const nrm = new Float32Array(n * 3);
  for (let f = 0; f < idx.length; f += 3) {
    const a = idx[f] * 3, b = idx[f + 1] * 3, c = idx[f + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    for (const v of [a, b, c]) {
      nrm[v] += cx;
      nrm[v + 1] += cy;
      nrm[v + 2] += cz;
    }
  }
  for (let i = 0; i < n * 3; i += 3) {
    const l = Math.hypot(nrm[i], nrm[i + 1], nrm[i + 2]) || 1;
    nrm[i] /= l;
    nrm[i + 1] /= l;
    nrm[i + 2] /= l;
  }

  const views = [pos, nrm, idx].map((a) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
  const offsets: number[] = [];
  let binLen = 0;
  for (const v of views) {
    offsets.push(binLen);
    binLen += Math.ceil(v.byteLength / 4) * 4;
  }
  const json = {
    asset: { version: "2.0", generator: "BeTenshi 3D Lab (SAM 3D Body)" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: "body" }],
    meshes: [{ name: "body", primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
    materials: [
      { name: "clay", pbrMetallicRoughness: { baseColorFactor: [0.55, 0.52, 0.49, 1], metallicFactor: 0, roughnessFactor: 0.8 }, doubleSided: true },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: n, type: "VEC3", min, max },
      { bufferView: 1, componentType: 5126, count: n, type: "VEC3" },
      { bufferView: 2, componentType: 5125, count: idx.length, type: "SCALAR" },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: offsets[0], byteLength: views[0].byteLength, target: 34962 },
      { buffer: 0, byteOffset: offsets[1], byteLength: views[1].byteLength, target: 34962 },
      { buffer: 0, byteOffset: offsets[2], byteLength: views[2].byteLength, target: 34963 },
    ],
    buffers: [{ byteLength: binLen }],
  };
  let text = new TextEncoder().encode(JSON.stringify(json));
  if (text.length % 4) {
    const padded = new Uint8Array(Math.ceil(text.length / 4) * 4).fill(0x20);
    padded.set(text);
    text = padded;
  }
  const out = new Uint8Array(12 + 8 + text.length + 8 + binLen);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); // "glTF"
  dv.setUint32(4, 2, true);
  dv.setUint32(8, out.length, true);
  dv.setUint32(12, text.length, true);
  dv.setUint32(16, 0x4e4f534a, true); // "JSON"
  out.set(text, 20);
  const binStart = 20 + text.length;
  dv.setUint32(binStart, binLen, true);
  dv.setUint32(binStart + 4, 0x004e4942, true); // "BIN\0"
  views.forEach((v, i) => out.set(v, binStart + 8 + offsets[i]));
  return out;
}
