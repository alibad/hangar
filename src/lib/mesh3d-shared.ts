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
