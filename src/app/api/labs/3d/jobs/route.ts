import { NextRequest, NextResponse } from "next/server";
import { readdir, stat } from "fs/promises";
import path from "path";
import { outputDir } from "@/lib/save-image";
import { MESH_ROOT, hasFile, jobFromId, meshFileUrl, readJobMeta } from "@/lib/mesh3d";
import { isJobId, latestByFile } from "@/lib/mesh3d-shared";

export const dynamic = "force-dynamic";

export type MeshJobSummary = {
  id: string;
  subject: string;
  sourceUrl: string;
  sourceNote: string;
  cutoutUrl: string | null;
  cutoutNote: string | null;
  /** The noun the cutout was made with, so reopening restores it. */
  concept: string | null;
  /** Object or person — reopening a job switches the Lab to its mode. */
  kind: "object" | "person";
  meshes: {
    file: string;
    url: string;
    model: string;
    resolution: number | null;
    seed: number | null;
    latencyMs: number | null;
    bytes: number | null;
    /** For a body: its pose JSON (joints + landmarks). */
    poseUrl?: string | null;
  }[];
};

/**
 * The 3D Lab's gallery: recent job folders (objects and people), newest first,
 * each with its image, cutout and every mesh made from it — so it can be reopened,
 * its meshes compared, and another model run on the same cutout.
 */
export async function GET(req: NextRequest) {
  const limit = Math.min(60, Math.max(1, Number(req.nextUrl.searchParams.get("limit")) || 24));
  let names: string[] = [];
  try {
    names = (await readdir(path.join(outputDir(), MESH_ROOT))).filter(isJobId).sort().reverse().slice(0, limit);
  } catch {
    return NextResponse.json({ jobs: [] });
  }
  const jobs: MeshJobSummary[] = [];
  for (const id of names) {
    const job = jobFromId(id)!;
    if (!(await hasFile(job, "source.png"))) continue;
    const meta = await readJobMeta(job);
    const src = (meta.source ?? {}) as { kind?: string; model?: string; seed?: number; latencyMs?: number; name?: string };
    const cut = meta.cutout as { concept?: string; score?: number; latencyMs?: number } | null | undefined;
    const cutoutUrl = await versioned(job.dir, `${job.rel}/cutout.png`);
    const meshes = latestByFile(
      (meta.meshes ?? [])
        .map((m) => m as { file?: string; model?: string; resolution?: number | null; seed?: number; latencyMs?: number; bytes?: number; pose?: string })
        .filter((m) => typeof m.file === "string"),
    );
    jobs.push({
      id,
      subject: meta.subject ?? id,
      sourceUrl: (await versioned(job.dir, `${job.rel}/source.png`)) ?? meshFileUrl(`${job.rel}/source.png`),
      sourceNote:
        src.kind === "generated"
          ? `${src.model ?? "image model"} · seed ${src.seed ?? "?"}${src.latencyMs ? ` · ${(src.latencyMs / 1000).toFixed(1)}s` : ""}`
          : `uploaded${src.name ? ` · ${src.name}` : ""}`,
      cutoutUrl,
      concept: cut?.concept ?? null,
      kind: meta.kind === "person" ? "person" : "object",
      cutoutNote: cutoutUrl && cut ? `SAM 3 · "${cut.concept}" · score ${(cut.score ?? 0).toFixed(2)}${cut.latencyMs ? ` · ${(cut.latencyMs / 1000).toFixed(1)}s` : ""}` : null,
      meshes: (
        await Promise.all(
          meshes.map(async (m) => {
            const url = await versioned(job.dir, `${job.rel}/${m.file}`);
            const poseUrl = m.pose ? await versioned(job.dir, `${job.rel}/${m.pose}`) : null;
            return url
              ? { file: m.file!, url, model: m.model ?? "?", resolution: m.resolution ?? null, seed: m.seed ?? null, latencyMs: m.latencyMs ?? null, bytes: m.bytes ?? null, poseUrl }
              : null;
          }),
        )
      ).filter((m): m is NonNullable<typeof m> => !!m),
    });
  }
  return NextResponse.json({ jobs });
}

/**
 * The artifact's URL with its mtime as a version, or null if it is gone. A file
 * rewritten under the same name (a re-cut) gets a new URL, so no cache anywhere
 * can show the old one.
 */
async function versioned(dir: string, rel: string): Promise<string | null> {
  try {
    const st = await stat(path.join(dir, path.basename(rel)));
    return `${meshFileUrl(rel)}&v=${Math.round(st.mtimeMs)}`;
  } catch {
    return null;
  }
}
