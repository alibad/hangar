import { NextRequest, NextResponse } from "next/server";
import { videoQueue } from "@/lib/video-jobs";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const job = await videoQueue.get((await params).id);
  return job ? NextResponse.json({ job }) : NextResponse.json({ error: "No such job" }, { status: 404 });
}

/** DELETE — cancel; with ?remove=1, also drop the record (the file stays on disk). */
export async function DELETE(req: NextRequest, { params }: Ctx) {
  const id = (await params).id;
  if (req.nextUrl.searchParams.get("remove") === "1") {
    return (await videoQueue.remove(id))
      ? NextResponse.json({ ok: true })
      : NextResponse.json({ error: "No such job" }, { status: 404 });
  }
  const job = await videoQueue.cancel(id);
  return job ? NextResponse.json({ job }) : NextResponse.json({ error: "No such job" }, { status: 404 });
}
