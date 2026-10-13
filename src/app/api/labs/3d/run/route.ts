import { NextRequest, NextResponse } from "next/server";
import { readFile } from "fs/promises";
import path from "path";
import { measureRun, recordLabRun } from "@/lib/lab-runs";
import type { LabRunResult } from "@/lib/lab-types";
import { ResourceLeaseError } from "@/lib/resource-manager";
import { PipelineError, hasFile, jobFromId, makeMesh, readJobMeta, saveArtifact, writeJobMeta, type MeshResult } from "@/lib/mesh3d";
import { glbName } from "@/lib/mesh3d-shared";

export const dynamic = "force-dynamic";
/** TRELLIS.2 on a dense organic object at 1024 is 15+ minutes of post-processing. */
export const maxDuration = 1800;

export type MeshLabOutput = {
  glbUrl: string;
  glbPath: string;
  downloadName: string;
  bytes: number;
  resolution: number | null;
  /** The three pipeline steps, so the column shows where the time went. */
  steps: { name: string; ms: number | null; detail?: string }[];
  reportedFaces: number | null;
  reportedPeakVramMb: number | null;
};

/**
 * Step 3 of the 3D Lab — the measured one: mesh the job's cutout (or its source
 * image when there is no cutout) with one 3D model, save the GLB beside it, and
 * record the run.
 */
export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  const job = jobFromId(b?.job);
  const model = typeof b?.model === "string" ? b.model.trim() : "";
  if (!job) return NextResponse.json({ error: "Make the object image first." }, { status: 400 });
  if (!model) return NextResponse.json({ error: "model is required" }, { status: 400 });
  const seed = Number.isInteger(b?.seed) ? (b.seed as number) : 42;
  const resolution = Number.isInteger(b?.resolution) ? (b.resolution as number) : null;
  const compareGroup = typeof b?.compareGroup === "string" ? b.compareGroup : null;

  const useCutout = await hasFile(job, "cutout.png");
  let image: Buffer;
  try {
    image = await readFile(path.join(job.dir, useCutout ? "cutout.png" : "source.png"));
  } catch {
    return NextResponse.json({ error: "This job has no image." }, { status: 404 });
  }
  const meta = await readJobMeta(job);

  const measured = await measureRun(() => makeMesh(model, image, { seed, resolution, signal: req.signal, owner: `lab:3d:${model}` }), {
    local: true,
  });
  const m = measured.measurement;
  const mesh: MeshResult | null = measured.ok ? measured.result : null;
  const err = measured.ok ? null : measured.error;
  const resourceBlocked = err instanceof ResourceLeaseError || (err instanceof PipelineError && !!err.resourceBlocked);
  const errMsg = err
    ? /ECONNREFUSED|socket hang up/.test(String((err as Error).message ?? err))
      ? `${model}'s service is not reachable — start it first.`
      : err instanceof Error
        ? err.message
        : String(err)
    : null;

  let saved: { rel: string; url: string; abs: string } | null = null;
  const name = glbName(model, resolution, seed);
  if (mesh) {
    saved = await saveArtifact(job, name, mesh.glb);
    await writeJobMeta(job, {
      meshes: [{ file: name, model, seed, resolution, latencyMs: m.latencyMs, serviceMs: mesh.serviceMs, bytes: mesh.glb.length, reported: mesh.reported, input: useCutout ? "cutout" : "source" }],
      // A named set ("hangar-models:leela-vedic") files the job under it in the
      // library; the Lab's own two-model comparisons use a bare UUID, not a set.
      ...(compareGroup?.includes(":") ? { group: compareGroup } : {}),
    });
    // The library's cached index (api/labs/3d/jobs) would show it without its mesh for a while.
    (globalThis as { __mesh3dIndex?: unknown }).__mesh3dIndex = undefined;
  }

  const src = meta.source as { kind?: string; latencyMs?: number; model?: string } | undefined;
  const cut = meta.cutout as { latencyMs?: number; concept?: string } | null | undefined;
  const steps: MeshLabOutput["steps"] = [
    { name: src?.kind === "upload" ? "Image (uploaded)" : "Image", ms: src?.latencyMs ?? null, detail: src?.model },
    { name: "Cutout", ms: useCutout ? (cut?.latencyMs ?? null) : null, detail: useCutout ? `SAM 3 · ${cut?.concept ?? ""}` : "skipped — model matted it" },
    { name: "Mesh", ms: mesh?.serviceMs ?? m.latencyMs, detail: model },
  ];

  const run = await recordLabRun({
    lab: "3d",
    capability: "3d",
    model,
    local: true,
    compareGroup,
    inputSummary: `${meta.subject ?? job.id}${useCutout ? " (SAM 3 cutout)" : ""}`,
    params: { resolution, input: useCutout ? "cutout" : "source", job: job.id },
    seed,
    status: mesh ? "ok" : "error",
    error: errMsg,
    latencyMs: m.latencyMs,
    peakVramGb: m.peakVramGb,
    baselineVramGb: m.baselineVramGb,
    vramNote: m.vramNote,
    costUsd: null,
    outputPath: saved?.abs ?? null,
    outputSummary: mesh ? `${(mesh.glb.length / 1024 / 1024).toFixed(1)} MB GLB${mesh.reported.faces ? `, ${mesh.reported.faces} faces` : ""}` : null,
  });

  const result: LabRunResult<MeshLabOutput> = {
    ok: !!mesh,
    model,
    local: true,
    error: errMsg ?? undefined,
    resourceBlocked: resourceBlocked || undefined,
    output:
      mesh && saved
        ? {
            glbUrl: saved.url,
            glbPath: saved.abs,
            downloadName: `${(meta.subject ?? "mesh").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${name}`,
            bytes: mesh.glb.length,
            resolution,
            steps,
            reportedFaces: mesh.reported.faces ?? null,
            reportedPeakVramMb: mesh.reported.peakVramMb ?? null,
          }
        : undefined,
    runId: run?.id ?? null,
    latencyMs: m.latencyMs,
    peakVramGb: m.peakVramGb,
    baselineVramGb: m.baselineVramGb,
    vramNote: m.vramNote,
    costUsd: null,
  };
  return NextResponse.json(result);
}
