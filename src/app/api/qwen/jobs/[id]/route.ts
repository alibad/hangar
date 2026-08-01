import { NextRequest, NextResponse } from "next/server";
import { batchQueue } from "@/lib/batch-queue";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = batchQueue.get(id);
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(job);
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  if (body.action === "pause") batchQueue.pause(id);
  else if (body.action === "resume") batchQueue.resume(id);
  else if (body.action === "cancel") batchQueue.cancel(id);
  else if (body.action === "reorder") batchQueue.reorder(id, body.dir);
  else return NextResponse.json({ error: "unknown action" }, { status: 400 });
  return NextResponse.json({ ok: true });
}

/**
 * Permanently delete the job row. Use PATCH {action:"cancel"} to stop a job but
 * keep its record — DELETE used to do that, which meant nothing could ever
 * actually be removed from the list.
 */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await batchQueue.remove(id);
  return NextResponse.json({ ok: true });
}
