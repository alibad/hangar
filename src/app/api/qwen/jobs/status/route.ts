import { NextResponse } from "next/server";
import { batchQueue } from "@/lib/batch-queue";
import { getServiceUrl } from "@/lib/services";

/**
 * Answers "why is nothing running?" — the queue can legitimately be holding
 * because the image backend is down, and that must be visible rather than
 * looking like silent success.
 */
export async function GET() {
  const base = getServiceUrl("qwen");
  let alive = false;
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 4000);
    const res = await fetch(`${base}/health`, { signal: ac.signal });
    clearTimeout(t);
    alive = res.ok;
  } catch {
    alive = false;
  }

  // Self-healing: a live backend under a parked queue means the in-process retry
  // timer was lost (HMR reload, or it never got scheduled). The UI polls this
  // route every few seconds, so nudging here guarantees recovery regardless.
  if (alive && batchQueue.parked) batchQueue.kick();

  const counts: Record<string, number> = {};
  for (const j of batchQueue.jobs) counts[j.status] = (counts[j.status] ?? 0) + 1;

  return NextResponse.json({
    backend: { id: "qwen", url: base, alive },
    parked: batchQueue.parked,
    counts,
  });
}
