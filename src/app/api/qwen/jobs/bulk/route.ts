import { NextRequest, NextResponse } from "next/server";
import { batchQueue } from "@/lib/batch-queue";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { action } = body;

  if (action === "pause-all") {
    batchQueue.pauseAll();
  } else if (action === "cancel-queued") {
    batchQueue.cancelQueued();
  } else if (action === "resume-all") {
    const resumed = batchQueue.resumeAll();
    return NextResponse.json({ ok: true, resumed });
  } else if (action === "clear-completed") {
    const removed = await batchQueue.removeCompleted();
    return NextResponse.json({ ok: true, removed });
  } else if (action === "retry-failed") {
    const requeued = batchQueue.retryAllFailed();
    return NextResponse.json({ ok: true, requeued });
  } else {
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
