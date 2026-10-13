import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import { generateAndSave } from "@/lib/image-gen";
import { newJob, saveArtifact, writeJobMeta } from "@/lib/mesh3d";
import { objectPrompt, personPrompt } from "@/lib/mesh3d-shared";

export const dynamic = "force-dynamic";
/** A cold image model can take minutes to load. */
export const maxDuration = 900;

/**
 * Step 1 of the 3D Lab: the image, in a fresh job folder.
 *
 * JSON `{ subject, kind?, imageModel?, seed? }` generates it with a local image
 * model (the Image Studio's own generateAndSave, so leases and the gallery
 * behave the same); multipart `image` (+ `subject`, `kind`) takes an upload
 * instead. `kind` is "object" (default) or "person": it picks the prompt
 * scaffold and is remembered, so the gallery reopens a job in the right mode.
 */
export async function POST(req: NextRequest) {
  const ct = req.headers.get("content-type") ?? "";
  try {
    if (ct.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("image");
      if (!(file instanceof Blob)) return NextResponse.json({ error: "an image file is required" }, { status: 400 });
      const kind = form.get("kind") === "person" ? "person" : "object";
      const subject = String(form.get("subject") ?? "").trim() || (kind === "person" ? "a person" : "upload");
      const png = await sharp(Buffer.from(await file.arrayBuffer())).rotate().png().toBuffer();
      const job = await newJob(subject);
      const src = await saveArtifact(job, "source.png", png);
      await writeJobMeta(job, { subject, kind, source: { kind: "upload", name: (file as File).name ?? null } });
      return NextResponse.json({ job: job.id, sourceUrl: src.url, subject });
    }

    const b = await req.json().catch(() => ({}));
    const subject = typeof b?.subject === "string" ? b.subject.trim() : "";
    const kind = b?.kind === "person" ? "person" : "object";
    if (!subject) return NextResponse.json({ error: kind === "person" ? "Describe the person first." : "Describe the object first." }, { status: 400 });
    const imageModel = typeof b?.imageModel === "string" && b.imageModel ? b.imageModel : "z-image-turbo";
    const seed = Number.isInteger(b?.seed) ? (b.seed as number) : undefined;
    const prompt = kind === "person" ? personPrompt(subject) : objectPrompt(subject);

    const gen = await generateAndSave({ prompt, model: imageModel, seed, width: 1024, height: 1024, folder: "3d-sources" }, undefined, req.signal);
    if (!gen.ok) {
      const body = gen.body as { error?: string; resourceBlocked?: boolean };
      return NextResponse.json({ error: body.error ?? "Image generation failed", resourceBlocked: body.resourceBlocked }, { status: gen.status });
    }
    const body = gen.body as { image: string; latency: number; model: string; seed: number };
    const png = Buffer.from(body.image.split(",")[1], "base64");
    const job = await newJob(subject);
    const src = await saveArtifact(job, "source.png", png);
    await writeJobMeta(job, { subject, kind, source: { kind: "generated", model: body.model, seed: body.seed, prompt, latencyMs: body.latency } });
    return NextResponse.json({ job: job.id, sourceUrl: src.url, subject, model: body.model, seed: body.seed, latencyMs: body.latency, prompt });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
