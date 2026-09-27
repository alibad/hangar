import { NextRequest, NextResponse } from "next/server";
import { deleteTrack, listTracks } from "@/lib/music-store";

export const dynamic = "force-dynamic";

/** The music gallery, newest first. */
export async function GET(req: NextRequest) {
  const limit = Math.min(200, Math.max(1, Number(req.nextUrl.searchParams.get("limit")) || 60));
  return NextResponse.json({ tracks: await listTracks(limit) });
}

/** Remove a track and its sidecar. The runs-record row stays: it is history. */
export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (!(await deleteTrack(id))) return NextResponse.json({ error: `No track "${id}".` }, { status: 404 });
  return NextResponse.json({ deleted: id });
}
