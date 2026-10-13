import { NextRequest, NextResponse } from "next/server";
import { rm } from "fs/promises";
import sharp from "sharp";
import { generateAndSave } from "@/lib/image-gen";
import { measureRun, recordLabRun } from "@/lib/lab-runs";
import { ResourceLeaseError } from "@/lib/resource-manager";
import { PipelineError, makeCutout, makeMesh, meshModels, newJob, saveArtifact, writeJobMeta } from "@/lib/mesh3d";
import { glbName, lastNoun, objectPrompt, resolutionFor } from "@/lib/mesh3d-shared";

export const dynamic = "force-dynamic";
export const maxDuration = 1800;

/**
 * The whole 3D pipeline in one request — what the MCP `generate_3d_model` tool
 * calls. Same steps and helpers as the 3D Lab, recorded in the same runs table:
 *
 *   { subject } or { image: base64 PNG/JPEG }   the object
 *   concept?     noun for SAM 3 (default: last word of subject); cutout: false skips it
 *   model?       a "3d" model on this host (default: the first one the host profile lists)
 *   imageModel?  local image model for a described subject (default z-image-turbo)
 *   seed?, resolution?
 *
 * Answers with every artifact's absolute path, and where the time went.
 */
export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  const subject = typeof b?.subject === "string" ? b.subject.trim() : "";
  const imageB64 = typeof b?.image === "string" ? b.image.replace(/^data:[^,]+,/, "") : "";
  if (!subject && !imageB64) return NextResponse.json({ error: "Pass a subject to draw, or an image." }, { status: 400 });
  const models = meshModels();
  const model = typeof b?.model === "string" && b.model ? b.model : models[0]?.model;
  if (!model) return NextResponse.json({ error: "Nothing on this host serves 3D generation." }, { status: 409 });
  if (!models.some((m) => m.model === model)) {
    return NextResponse.json({ error: `Unknown 3D model "${model}". This host has: ${models.map((m) => m.model).join(", ")}.` }, { status: 400 });
  }
  const seed = Number.isInteger(b?.seed) ? (b.seed as number) : 42;
  // Default to the Lab's Draft setting: 1024 costs 3-6x the time for a difference
  // that is hard to see (docs/3d-model-experiment-2026-09-27.md).
  const resolution = Number.isInteger(b?.resolution) ? (b.resolution as number) : resolutionFor(model, "draft");
  const wantCutout = b?.cutout !== false;
  const concept = typeof b?.concept === "string" && b.concept.trim() ? b.concept.trim() : lastNoun(subject);

  const steps: { name: string; ms: number; detail?: string }[] = [];
  const job = await newJob(subject || "image");
  let sourceSaved = false;
  try {
    // 1 — the object image
    let source: Buffer;
    if (imageB64) {
      source = await sharp(Buffer.from(imageB64, "base64")).rotate().png().toBuffer();
      steps.push({ name: "image", ms: 0, detail: "supplied" });
      await writeJobMeta(job, { subject: subject || "supplied image", source: { kind: "upload" } });
    } else {
      const imageModel = typeof b?.imageModel === "string" && b.imageModel ? b.imageModel : "z-image-turbo";
      const prompt = objectPrompt(subject);
      const gen = await generateAndSave({ prompt, model: imageModel, seed, width: 1024, height: 1024, folder: "3d-sources" }, undefined, req.signal);
      if (!gen.ok) {
        const gb = gen.body as { error?: string; resourceBlocked?: boolean };
        throw new PipelineError(`Image generation: ${gb.error ?? "failed"}`, gen.status, { resourceBlocked: gb.resourceBlocked });
      }
      const gb = gen.body as { image: string; latency: number; model: string };
      source = Buffer.from(gb.image.split(",")[1], "base64");
      steps.push({ name: "image", ms: gb.latency, detail: gb.model });
      await writeJobMeta(job, { subject, source: { kind: "generated", model: gb.model, seed, prompt, latencyMs: gb.latency } });
    }
    const src = await saveArtifact(job, "source.png", source);
    sourceSaved = true;

    // 2 — cutout
    let meshInput = source;
    let cutoutPath: string | null = null;
    if (wantCutout && concept) {
      const c = await makeCutout(source, concept, req.signal);
      const saved = await saveArtifact(job, "cutout.png", c.png);
      cutoutPath = saved.abs;
      meshInput = c.png;
      steps.push({ name: "cutout", ms: c.latencyMs, detail: `SAM 3 "${concept}" score ${c.score.toFixed(2)}` });
      await writeJobMeta(job, { cutout: { concept, score: c.score, box: c.box, instances: c.instances, latencyMs: c.latencyMs } });
    }

    // 3 — mesh, measured and recorded like a Lab run
    const measured = await measureRun(() => makeMesh(model, meshInput, { seed, resolution, signal: req.signal, owner: `mcp:3d:${model}` }), { local: true });
    const m = measured.measurement;
    if (!measured.ok) {
      await recordLabRun({
        lab: "3d", capability: "3d", model, local: true,
        inputSummary: `${subject || "supplied image"} (pipeline)`, params: { resolution, job: job.id, via: "pipeline" }, seed,
        status: "error", error: String((measured.error as Error)?.message ?? measured.error), ...m,
      });
      throw measured.error;
    }
    const mesh = measured.result;
    const name = glbName(model, resolution, seed);
    const glb = await saveArtifact(job, name, mesh.glb);
    steps.push({ name: "mesh", ms: mesh.serviceMs, detail: model });
    await writeJobMeta(job, { meshes: [{ file: name, model, seed, resolution, latencyMs: m.latencyMs, serviceMs: mesh.serviceMs, bytes: mesh.glb.length, reported: mesh.reported }] });
    const run = await recordLabRun({
      lab: "3d", capability: "3d", model, local: true,
      inputSummary: `${subject || "supplied image"}${cutoutPath ? " (SAM 3 cutout)" : ""} (pipeline)`,
      params: { resolution, job: job.id, via: "pipeline" }, seed, status: "ok", ...m,
      outputPath: glb.abs, outputSummary: `${(mesh.glb.length / 1024 / 1024).toFixed(1)} MB GLB`,
    });

    return NextResponse.json({
      ok: true,
      job: job.id,
      model,
      seed,
      resolution,
      glbPath: glb.abs,
      glbUrl: glb.url,
      sourcePath: src.abs,
      cutoutPath,
      bytes: mesh.glb.length,
      steps,
      totalMs: steps.reduce((s, x) => s + x.ms, 0),
      peakVramGb: m.peakVramGb,
      runId: run?.id ?? null,
      labUrl: "/#lab-3d",
    });
  } catch (err) {
    // Refused before there was even an image: leave no empty folder in the gallery.
    if (!sourceSaved) await rm(job.dir, { recursive: true, force: true }).catch(() => {});
    if (err instanceof ResourceLeaseError) {
      return NextResponse.json({ ok: false, error: err.message, resourceBlocked: true, job: job.id, steps }, { status: err.status });
    }
    const status = err instanceof PipelineError ? err.status : 502;
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { ok: false, error: msg, resourceBlocked: err instanceof PipelineError ? err.resourceBlocked : undefined, job: job.id, steps },
      { status },
    );
  }
}
