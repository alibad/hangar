import { NextRequest, NextResponse } from "next/server";
import { videoQueue, type VideoJobRequest } from "@/lib/video-jobs";

export const dynamic = "force-dynamic";

/** GET — the queue, newest first. */
export async function GET(req: NextRequest) {
  const limit = Math.min(200, Math.max(1, Number(req.nextUrl.searchParams.get("limit")) || 40));
  return NextResponse.json({ jobs: await videoQueue.list(limit) });
}

/**
 * POST — enqueue a clip; answers at once with the job. Generation takes
 * minutes, so nothing waits on this request: poll GET /api/video/jobs/<id>.
 */
export async function POST(req: NextRequest) {
  let body: VideoJobRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Expected JSON" }, { status: 400 });
  }
  try {
    const job = await videoQueue.add({ ...body, origin: body.origin ?? "lab" });
    return NextResponse.json({ job }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
