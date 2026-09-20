import { NextRequest, NextResponse } from "next/server";
import { batchQueue } from "@/lib/batch-queue";
import { getManagerHeaders, getManagerUrl } from "@/lib/services";

/**
 * One-click VRAM control.
 *
 *  free  — pause every active job, then stop the Qwen service. The ~36 GB the
 *          model holds goes back to the GPU/RAM. Safe because the queue parks
 *          instead of consuming itself when the backend is gone.
 *  start — start the service again and un-pause everything. The queue picks up
 *          from each job's cursor, so nothing is regenerated.
 */
export async function POST(req: NextRequest) {
  const { action } = await req.json().catch(() => ({ action: "" }));

  if (action === "free") {
    batchQueue.pauseAll();
    let stopped = false;
    let error: string | null = null;
    try {
      const res = await fetch(`${getManagerUrl()}/services/qwen/stop`, {
        method: "POST",
        headers: getManagerHeaders(),
        signal: AbortSignal.timeout(60000),
      });
      stopped = res.ok;
      if (!res.ok) error = `manager returned ${res.status}`;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    return NextResponse.json({ ok: stopped, paused: true, stopped, error });
  }

  if (action === "start") {
    let started = false;
    let error: string | null = null;
    try {
      const res = await fetch(`${getManagerUrl()}/services/qwen/start`, {
        method: "POST",
        headers: getManagerHeaders(),
        signal: AbortSignal.timeout(120000),
      });
      started = res.ok;
      if (!res.ok) error = `manager returned ${res.status}`;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    // Un-pause regardless: the queue preflights /health and parks until the
    // model finishes loading, then drains on its own.
    const resumed = batchQueue.resumeAll();
    return NextResponse.json({ ok: started, started, resumed, error });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
