import { NextRequest, NextResponse } from "next/server";
import { readFile } from "fs/promises";
import path from "path";
import { ResourceLeaseError } from "@/lib/resource-manager";
import { PipelineError, jobFromId, makeCutout, saveArtifact, writeJobMeta } from "@/lib/mesh3d";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Step 2 of the 3D Lab: segment the object out of the job's source image with
 * SAM 3 and store it as cutout.png (RGBA, square, margin around the object).
 */
export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  const job = jobFromId(b?.job);
  const concept = typeof b?.concept === "string" ? b.concept.trim() : "";
  if (!job) return NextResponse.json({ error: "Unknown job — make the object image first." }, { status: 400 });
  if (!concept) return NextResponse.json({ error: "Name the object to cut out (a noun, e.g. \"drill\")." }, { status: 400 });

  let source: Buffer;
  try {
    source = await readFile(path.join(job.dir, "source.png"));
  } catch {
    return NextResponse.json({ error: "This job has no source image." }, { status: 404 });
  }

  try {
    const c = await makeCutout(source, concept, req.signal);
    const out = await saveArtifact(job, "cutout.png", c.png);
    await writeJobMeta(job, { cutout: { concept, score: c.score, box: c.box, instances: c.instances, latencyMs: c.latencyMs } });
    return NextResponse.json({ cutoutUrl: out.url, concept, score: c.score, box: c.box, instances: c.instances, latencyMs: c.latencyMs });
  } catch (err) {
    if (err instanceof ResourceLeaseError) {
      return NextResponse.json({ error: err.message, resourceBlocked: true, code: err.code }, { status: err.status });
    }
    const status = err instanceof PipelineError ? err.status : 502;
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: /fetch failed|ECONNREFUSED/.test(msg) ? "SAM 3 is not reachable — start it first." : msg }, { status });
  }
}
