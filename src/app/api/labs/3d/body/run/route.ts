import { NextRequest, NextResponse } from "next/server";
import { readFile } from "fs/promises";
import path from "path";
import sharp from "sharp";
import { measureRun, recordLabRun } from "@/lib/lab-runs";
import type { LabRunResult } from "@/lib/lab-types";
import { ResourceLeaseError, withResourceLease } from "@/lib/resource-manager";
import { getServiceHeaders, getServiceUrl } from "@/lib/services";
import { PipelineError, jobFromId, meshModel, readJobMeta, saveArtifact, workloadFor, writeJobMeta } from "@/lib/mesh3d";
import { bodyGlb, personBox } from "@/lib/mesh3d-shared";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export type BodyLabOutput = {
  glbUrl: string;
  glbPath: string;
  poseUrl: string;
  downloadName: string;
  bytes: number;
  /** The photo the pose was read from, and the 33 landmarks projected onto it (0-1, with confidence). */
  photoUrl: string;
  overlay: { width: number; height: number; points: number[][] } | null;
  /** The region SAM 3D Body was pointed at (normalised), when a cutout chose the person. */
  box: [number, number, number, number] | null;
  joints: number;
  vertices: number;
  faces: number;
  steps: { name: string; ms: number | null; detail?: string }[];
};

type PoseResponse = {
  ok: boolean;
  error?: string;
  width?: number;
  height?: number;
  keypoints_3d_mhr70?: number[][];
  global_rot?: number[];
  mediapipe33?: { landmarks: number[][]; image: number[][] };
  vertices?: number[][];
  faces?: number[][] | null;
};

/**
 * The 3D Lab's Person mode: one photo of a person → SAM 3D Body → a body mesh
 * (GLB, for the same viewer and download as objects) and its pose (70 3D
 * joints + the 33 MediaPipe landmarks, as JSON). Recorded as a 3D Lab run.
 *
 * The model is found by capability ("3d-body"), not by service name. If the job
 * has a SAM 3 cutout, its box — grown by a margin — tells SAM 3D Body which
 * person to reconstruct; otherwise it takes the most prominent one.
 */
export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  const job = jobFromId(b?.job);
  const model = typeof b?.model === "string" ? b.model.trim() : "";
  if (!job) return NextResponse.json({ error: "Add a photo of a person first." }, { status: 400 });
  const m = meshModel(model, "3d-body");
  if (!m) return NextResponse.json({ error: `No service on this host reconstructs people with "${model}".` }, { status: 400 });
  const compareGroup = typeof b?.compareGroup === "string" ? b.compareGroup : null;

  let photo: Buffer;
  try {
    photo = await readFile(path.join(job.dir, "source.png"));
  } catch {
    return NextResponse.json({ error: "This job has no photo." }, { status: 404 });
  }
  const meta = await readJobMeta(job);
  const cut = meta.cutout as { box?: [number, number, number, number]; concept?: string; latencyMs?: number } | null | undefined;
  const { width = 0, height = 0 } = await sharp(photo).metadata();
  const box = cut?.box && width && height ? personBox(cut.box, width, height) : null;

  const measured = await measureRun(
    async () => {
      const form = new FormData();
      form.append("image", new Blob([new Uint8Array(photo)], { type: "image/png" }), "photo.png");
      form.append("mediapipe", "true");
      form.append("include_mesh", "true");
      if (box) form.append("bbox", box.join(","));
      const base = getServiceUrl(m.serviceId);
      const workload = workloadFor(m.serviceId);
      const call = () => fetch(`${base}/pose`, { method: "POST", headers: getServiceHeaders(m.serviceId), body: form, signal: req.signal });
      const t0 = Date.now();
      const res = workload
        ? await withResourceLease(workload, { owner: `lab:3d-body:${model}`, lane: "interactive", waitMs: 60_000, signal: req.signal }, call)
        : await call();
      const serviceMs = Date.now() - t0;
      const body = (await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))) as PoseResponse;
      if (!body.ok) {
        const why = body.error === "no person detected"
          ? "No person found in this photo. SAM 3D Body needs one person, ideally the whole body in frame — try another photo, or cut the person out first."
          : body.error === "model not ready"
            ? `${m.serviceName} is still loading its model — try again in a few seconds.`
            : `${m.serviceName}: ${body.error ?? `HTTP ${res.status}`}`;
        throw new PipelineError(why, res.status === 200 ? 422 : res.status);
      }
      if (!body.vertices?.length || !body.faces?.length) throw new PipelineError(`${m.serviceName} returned a pose but no body mesh.`, 502);
      return { body, serviceMs };
    },
    { local: true },
  );
  const mm = measured.measurement;
  const result = measured.ok ? measured.result : null;
  const err = measured.ok ? null : measured.error;
  const errMsg = err
    ? /ECONNREFUSED|fetch failed/.test(String((err as Error).message ?? err))
      ? `${m.serviceName} is not reachable — start it first.`
      : err instanceof Error
        ? err.message
        : String(err)
    : null;

  let output: BodyLabOutput | undefined;
  let outputPath: string | null = null;
  if (result) {
    const { body, serviceMs } = result;
    const stem = `${model}${box ? "-picked" : ""}`.toLowerCase().replace(/[^a-z0-9._-]/g, "-");
    const glb = Buffer.from(bodyGlb(body.vertices!, body.faces!));
    const saved = await saveArtifact(job, `${stem}.glb`, glb);
    const pose = await saveArtifact(
      job,
      `${stem}-pose.json`,
      JSON.stringify(
        {
          model,
          image: { width: body.width, height: body.height },
          box,
          global_rot: body.global_rot,
          keypoints_3d_mhr70: body.keypoints_3d_mhr70,
          mediapipe33: body.mediapipe33,
          note: "Camera frame: x right, y down, z away from the camera. The GLB is turned 180° about X (Y up, facing the viewer).",
        },
        null,
        1,
      ),
    );
    outputPath = saved.abs;
    await writeJobMeta(job, {
      meshes: [{ file: `${stem}.glb`, model, kind: "body", pose: `${stem}-pose.json`, latencyMs: mm.latencyMs, serviceMs, bytes: glb.length, box }],
    });
    const src = meta.source as { kind?: string; latencyMs?: number; model?: string } | undefined;
    output = {
      glbUrl: saved.url,
      glbPath: saved.abs,
      poseUrl: pose.url,
      downloadName: `${(meta.subject ?? "person").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${stem}.glb`,
      bytes: glb.length,
      photoUrl: `/api/labs/3d/file?rel=${encodeURIComponent(`${job.rel}/source.png`)}`,
      overlay: body.mediapipe33 ? { width: body.width ?? width, height: body.height ?? height, points: body.mediapipe33.image } : null,
      box,
      joints: body.keypoints_3d_mhr70?.length ?? 0,
      vertices: body.vertices!.length,
      faces: body.faces!.length,
      steps: [
        { name: src?.kind === "upload" ? "Photo (uploaded)" : "Photo", ms: src?.latencyMs ?? null, detail: src?.model },
        { name: "Person pick", ms: box ? (cut?.latencyMs ?? null) : null, detail: box ? `SAM 3 · ${cut?.concept ?? ""}` : "skipped — most prominent person" },
        { name: "Body + pose", ms: serviceMs, detail: model },
      ],
    };
  }

  const run = await recordLabRun({
    lab: "3d",
    capability: "3d-body",
    model,
    local: true,
    compareGroup,
    inputSummary: `${meta.subject ?? job.id}${box ? " (person picked with SAM 3)" : ""}`,
    params: { job: job.id, box },
    seed: null,
    status: result ? "ok" : "error",
    error: errMsg,
    latencyMs: mm.latencyMs,
    peakVramGb: mm.peakVramGb,
    baselineVramGb: mm.baselineVramGb,
    vramNote: mm.vramNote,
    costUsd: null,
    outputPath,
    outputSummary: output ? `${output.joints} joints, ${output.vertices} vertices` : null,
  });

  const resourceBlocked = err instanceof ResourceLeaseError;
  const payload: LabRunResult<BodyLabOutput> = {
    ok: !!output,
    model,
    local: true,
    error: errMsg ?? undefined,
    resourceBlocked: resourceBlocked || undefined,
    output,
    runId: run?.id ?? null,
    latencyMs: mm.latencyMs,
    peakVramGb: mm.peakVramGb,
    baselineVramGb: mm.baselineVramGb,
    vramNote: mm.vramNote,
    costUsd: null,
  };
  return NextResponse.json(payload);
}
