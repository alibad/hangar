import http from "node:http";
import { mkdir, readFile, stat, writeFile } from "fs/promises";
import path from "path";
import { servedModels, servicesForCapability } from "@/lib/host";
import { getServiceHeaders, getServiceUrl } from "@/lib/services";
import { withResourceLease } from "@/lib/resource-manager";
import { outputDir } from "@/lib/save-image";
import { applyMask } from "@/lib/mesh3d-image";
import { MESH_ROOT, isJobId, latestByFile, meshWorkload, orientGlb, servableRel, type UpAxis } from "@/lib/mesh3d-shared";
import modelMetaJson from "../../config/model-meta.json";
import policyJson from "../../config/resource-policy.json";

const MODEL_META = modelMetaJson as Record<string, { upAxis?: UpAxis } | undefined>;
const POLICY = policyJson as { workloads: Record<string, { service?: string }> };

export { MESH_ROOT, meshWorkload } from "@/lib/mesh3d-shared";

/**
 * The 3D pipeline, server side: object image → SAM 3 cutout → mesh service → GLB.
 *
 * Three callers share it — the 3D Lab's step routes, its run route, and the
 * one-shot /api/labs/3d/pipeline the MCP tool uses — so the Lab and an agent
 * cannot disagree about how a mesh is made.
 *
 * Mesh services are found by capability, never by name: any host service that
 * declares `serves: { "3d": … }` and answers `POST /generate` (multipart
 * `image` → model/gltf-binary) is a mesh model here. TRELLIS.2 (trellis.cpp's
 * own server) and TripoSR (our FastAPI wrapper) both speak that.
 */

export type MeshJob = { id: string; dir: string; rel: string };

function stamp(d = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function slug(s: string): string {
  return (s || "object").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "object";
}

export async function newJob(label: string): Promise<MeshJob> {
  const id = `${stamp()}-${slug(label)}-${Math.random().toString(36).slice(2, 6)}`;
  const rel = `${MESH_ROOT}/${id}`;
  const dir = path.join(outputDir(), MESH_ROOT, id);
  await mkdir(dir, { recursive: true });
  return { id, dir, rel };
}

/** A job id from the client. Strict, because it becomes a path. */
export function jobFromId(id: unknown): MeshJob | null {
  if (!isJobId(id)) return null;
  return { id, rel: `${MESH_ROOT}/${id}`, dir: path.join(outputDir(), MESH_ROOT, id) };
}

/** Absolute path for a servable artifact, or null. Only .png/.glb/.json under 3d/<job>/. */
export function resolveMeshFile(rel: string | null): string | null {
  const norm = servableRel(rel);
  return norm ? path.join(outputDir(), norm) : null;
}

export function meshFileUrl(rel: string): string {
  return `/api/labs/3d/file?rel=${encodeURIComponent(rel)}`;
}

export async function saveArtifact(job: MeshJob, name: string, data: Buffer | string): Promise<{ rel: string; url: string; abs: string }> {
  const abs = path.join(job.dir, name);
  await writeFile(abs, data);
  const rel = `${job.rel}/${name}`;
  return { rel, url: meshFileUrl(rel), abs };
}

/** What a job folder knows about itself: the subject, and how each step was made. */
export type JobMeta = {
  subject?: string;
  /** What is being turned into 3D: an object (mesh models) or a person (body + pose). */
  kind?: "object" | "person";
  source?: Record<string, unknown>;
  cutout?: Record<string, unknown> | null;
  meshes?: Record<string, unknown>[];
  /** The named set a script made it in — a run's compareGroup "<tool>:<set>" — for the library. */
  group?: string | null;
};

export async function readJobMeta(job: MeshJob): Promise<JobMeta> {
  try {
    return JSON.parse(await readFile(path.join(job.dir, "meta.json"), "utf8")) as JobMeta;
  } catch {
    return {};
  }
}

/** Shallow-merge into meta.json; `meshes` appends. */
export async function writeJobMeta(job: MeshJob, patch: JobMeta): Promise<JobMeta> {
  const cur = await readJobMeta(job);
  const next: JobMeta = { ...cur, ...patch, meshes: latestByFile([...(cur.meshes ?? []), ...(patch.meshes ?? [])]) };
  await writeFile(path.join(job.dir, "meta.json"), JSON.stringify(next, null, 2));
  return next;
}

export async function hasFile(job: MeshJob, name: string): Promise<boolean> {
  try {
    await stat(path.join(job.dir, name));
    return true;
  } catch {
    return false;
  }
}

// ── mesh models on this host ────────────────────────────────────────────────

export type MeshModel = {
  model: string;
  serviceId: string;
  serviceName: string;
  /** The service's own `model` form value for this served name, when it hosts several. */
  param?: string;
};

/**
 * One row per served-model-name, from every host service that serves the
 * capability: "3d" for object meshes (the default), "3d-body" for people.
 */
export function meshModels(capability: "3d" | "3d-body" = "3d"): MeshModel[] {
  const out: MeshModel[] = [];
  for (const svc of servicesForCapability(capability)) {
    for (const model of servedModels(svc, capability)) {
      out.push({ model, serviceId: svc.id, serviceName: svc.name, param: svc.modelParam?.[model] });
    }
  }
  return out;
}

export function meshModel(id: string, capability: "3d" | "3d-body" = "3d"): MeshModel | null {
  return meshModels(capability).find((m) => m.model === id) ?? null;
}

/**
 * The resource-policy workload that guards a service's inference, looked up
 * rather than named: the first workload whose `service` is this one. (Mesh
 * services follow the `<id>-generate` convention; SAM 3D Body's predates it and
 * is `sam3d-pose`.)
 */
export function workloadFor(serviceId: string): string | null {
  const w = Object.entries(POLICY.workloads).find(([, e]) => e.service === serviceId);
  return w ? w[0] : null;
}

// ── SAM 3 cutout ────────────────────────────────────────────────────────────

export type Cutout = {
  png: Buffer;
  concept: string;
  score: number;
  box: [number, number, number, number];
  instances: number;
  latencyMs: number;
};

export class PipelineError extends Error {
  status: number;
  resourceBlocked?: boolean;
  details?: unknown;
  constructor(message: string, status = 500, extra: { resourceBlocked?: boolean; details?: unknown } = {}) {
    super(message);
    this.status = status;
    this.resourceBlocked = extra.resourceBlocked;
    this.details = extra.details;
  }
}

/**
 * Segment `concept` with SAM 3 and return the best instance as an RGBA PNG,
 * cropped square around the object with a margin — the framing single-image
 * 3D models were trained on.
 */
export async function makeCutout(image: Buffer, concept: string, signal?: AbortSignal): Promise<Cutout> {
  const form = new FormData();
  form.append("image", new Blob([new Uint8Array(image)], { type: "image/png" }), "source.png");
  form.append("concepts", concept);
  form.append("include_masks", "true");
  form.append("overlay", "false");
  const base = getServiceUrl("sam3");
  const t0 = Date.now();
  const res = await withResourceLease("sam3-segment", { owner: "console:lab-3d:cutout", lane: "interactive", signal }, () =>
    fetch(`${base}/segment`, { method: "POST", headers: getServiceHeaders("sam3"), body: form, signal }),
  );
  const body = (await res.json().catch(() => null)) as {
    ok?: boolean;
    error?: string;
    instances?: { score: number; box: [number, number, number, number]; mask_png?: string; concept: string }[];
  } | null;
  if (!res.ok || !body?.ok) throw new PipelineError(`SAM 3: ${body?.error ?? `HTTP ${res.status}`}`, 502);
  const best = body.instances?.find((i) => i.mask_png);
  if (!best?.mask_png) {
    throw new PipelineError(`SAM 3 found no "${concept}" in the image. Try the noun for the object as it appears.`, 422);
  }
  const mask = Buffer.from(best.mask_png.split(",")[1], "base64");
  const png = await applyMask(image, mask, best.box);
  return {
    png,
    concept,
    score: best.score,
    box: best.box,
    instances: body.instances?.length ?? 0,
    latencyMs: Date.now() - t0,
  };
}

// ── mesh step ───────────────────────────────────────────────────────────────

export type MeshResult = {
  glb: Buffer;
  model: string;
  serviceId: string;
  /** Wall time of the service call, lease wait excluded. */
  serviceMs: number;
  /** Whatever the service reported about itself (TripoSR sends X-* headers; trellis-server does not). */
  reported: { faces?: number; vertices?: number; peakVramMb?: number; watertight?: boolean; inferMs?: number };
};

export async function makeMesh(
  modelId: string,
  image: Buffer,
  opts: { seed?: number | null; resolution?: number | null; signal?: AbortSignal; owner?: string } = {},
): Promise<MeshResult> {
  const m = meshModel(modelId);
  if (!m) throw new PipelineError(`No service on this host serves the 3D model "${modelId}".`, 400);
  const fields: Record<string, string> = {};
  if (opts.seed != null) fields.seed = String(opts.seed);
  if (opts.resolution != null) fields.resolution = String(opts.resolution);
  // One runtime can host several models (trellis.cpp serves TRELLIS.2 and Pixal3D
  // from one weights directory); the host profile says what to call each.
  if (m.param) fields.model = m.param;
  // The cutout already carries alpha; both services keep a given alpha and only
  // run their own matting when there is none.
  const base = getServiceUrl(m.serviceId);
  let serviceMs = 0;
  const res = await withResourceLease(
    meshWorkload(m.serviceId),
    { owner: opts.owner ?? `console:lab-3d:${modelId}`, lane: "interactive", waitMs: 60_000, signal: opts.signal },
    async () => {
      const t0 = Date.now();
      const r = await multipartPost(`${base}/generate`, { image: { data: image, filename: "cutout.png", type: "image/png" } }, fields, opts.signal);
      serviceMs = Date.now() - t0;
      return r;
    },
  );
  if (res.status !== 200) {
    const text = res.body.toString("utf8").slice(0, 400);
    throw new PipelineError(`${m.serviceName} ${res.status}: ${text || "no body"}`, 502);
  }
  const h = res.headers;
  const num = (k: string) => (h[k] != null && !Number.isNaN(Number(h[k])) ? Number(h[k]) : undefined);
  // A model that reconstructs in its input camera's frame declares which way
  // its up is (model-meta `upAxis`); stand it up here so every consumer — the
  // viewer, a download, an agent — gets an upright asset.
  const up = MODEL_META[`local-${modelId}`]?.upAxis ?? MODEL_META[modelId]?.upAxis;
  return {
    glb: up ? Buffer.from(orientGlb(res.body, up)) : res.body,
    model: modelId,
    serviceId: m.serviceId,
    serviceMs,
    reported: {
      faces: num("x-faces"),
      vertices: num("x-vertices"),
      peakVramMb: num("x-peak-vram-mb"),
      inferMs: num("x-infer-ms"),
      watertight: h["x-watertight"] == null ? undefined : h["x-watertight"] === "1",
    },
  };
}

/**
 * multipart/form-data over node:http. Not fetch: undici's headersTimeout is 300 s
 * whatever signal you pass, and a 1536-resolution TRELLIS.2 run can take longer
 * than that before the first byte (same reason qwen-http.ts exists).
 */
function multipartPost(
  url: string,
  files: Record<string, { data: Buffer; filename: string; type: string }>,
  fields: Record<string, string>,
  signal?: AbortSignal,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  const boundary = `----betenshi3d${Math.random().toString(36).slice(2)}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  for (const [k, f] of Object.entries(files)) {
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"; filename="${f.filename}"\r\nContent-Type: ${f.type}\r\n\r\n`),
      f.data,
      Buffer.from("\r\n"),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(parts);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Cancelled"));
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: Number(u.port) || 80,
        path: u.pathname + u.search,
        method: "POST",
        headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": body.length },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    const abort = () => req.destroy(new Error("Cancelled"));
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => req.destroy(new Error("Mesh service timed out after 30 minutes")), 1_800_000);
    req.on("close", () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    });
    req.end(body);
  });
}
