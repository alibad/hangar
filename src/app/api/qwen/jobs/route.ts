import { NextRequest, NextResponse } from "next/server";
import { batchQueue } from "@/lib/batch-queue";
import { getDb } from "@/lib/db";
import { DEFAULT_IMAGE_MODEL, isImageModelId } from "@/lib/image-models";

type DbJobRow = {
  id: string; status: string; idea: string; prompts: string; params: string;
  completed: number; failed: number; total: number; current_index: number | null;
  created_at: string; started_at: string | null; done_at: string | null; last_error: string | null;
};

function rowToApi(row: DbJobRow) {
  return {
    id: row.id,
    status: row.status,
    idea: row.idea,
    prompts: JSON.parse(row.prompts),
    params: JSON.parse(row.params),
    completed: row.completed,
    failed: row.failed,
    total: row.total,
    currentIndex: row.current_index ?? undefined,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    doneAt: row.done_at ?? undefined,
    lastError: row.last_error ?? undefined,
  };
}

export async function GET() {
  const db = await getDb();
  const rows = await db.all<DbJobRow>(
    "SELECT * FROM batch_jobs ORDER BY created_at DESC",
  );
  return NextResponse.json(rows.map(rowToApi));
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const prompts: string[] = Array.isArray(body.prompts) ? body.prompts.map(String) : [];
  const idea: string = String(body.idea ?? prompts[0] ?? "batch").slice(0, 80);
  if (prompts.length === 0) return NextResponse.json({ error: "prompts required" }, { status: 400 });

  const job = await batchQueue.add({
    idea,
    prompts,
    total: prompts.length,
    params: {
      negative: String(body.negative ?? ""),
      width: Math.max(256, Number(body.width ?? 1024)),
      height: Math.max(256, Number(body.height ?? 1024)),
      steps: Math.max(1, Number(body.steps ?? 24)),
      cfg: Number(body.cfg ?? 4),
      // Unknown or absent falls back to Qwen-Image, which is what every job
      // queued before the models merged was actually running on.
      model: isImageModelId(body.model) ? body.model : DEFAULT_IMAGE_MODEL,
    },
  });
  return NextResponse.json(job, { status: 201 });
}
