import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

type DbImageRow = {
  id: string; rel: string; folder: string; filename: string; kind: string;
  prompt: string | null; negative_prompt: string | null; seed: number | null;
  width: number | null; height: number | null; steps: number | null; cfg: number | null;
  latency: number | null; input_count: number | null; bytes: number | null;
  favorite: boolean; saved_at: string; batch_job_id: string | null;
  /** Null on rows written before the gallery held more than one model. */
  model: string | null;
};

export async function GET() {
  const db = await getDb();
  const rows = await db.all<DbImageRow>(
    "SELECT * FROM images ORDER BY saved_at DESC, rel DESC",
  );

  const images = rows.map((row) => ({
    rel: row.rel,
    file: row.filename,
    folder: row.folder,
    url: `/api/qwen/images/file?rel=${encodeURIComponent(row.rel)}`,
    kind: row.kind as "generate" | "edit",
    favorite: row.favorite === true,
    prompt: row.prompt || "",
    seed: row.seed ?? undefined,
    width: row.width ?? undefined,
    height: row.height ?? undefined,
    steps: row.steps ?? undefined,
    cfg: row.cfg ?? undefined,
    latency: row.latency ?? undefined,
    inputCount: row.input_count ?? undefined,
    savedAt: row.saved_at,
    bytes: row.bytes ?? undefined,
    batchJobId: row.batch_job_id ?? undefined,
    model: row.model || "qwen-image",
  }));

  const folderSet = new Set<string>();
  for (const img of images) {
    if (img.folder) folderSet.add(img.folder);
  }
  const folders = [...folderSet].sort();

  return NextResponse.json({ images, folders, count: images.length });
}
