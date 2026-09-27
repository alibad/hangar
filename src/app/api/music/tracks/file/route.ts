import { NextRequest, NextResponse } from "next/server";
import { createReadStream } from "fs";
import { Readable } from "stream";
import { AUDIO_TYPES, fileSize, readTrack, trackAudioPath } from "@/lib/music-store";

export const dynamic = "force-dynamic";

/**
 * One track's audio. Honours Range, because an <audio> element that cannot
 * range-request cannot seek — clicking the waveform would restart the song.
 * `?download=1` sets a filename so "Save" gives something recognisable.
 */
export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id") ?? "";
  const found = await trackAudioPath(id);
  if (!found) return NextResponse.json({ error: `No track "${id}".` }, { status: 404 });
  let size: number;
  try {
    size = await fileSize(found.path);
  } catch {
    return NextResponse.json({ error: "The audio file is missing from disk." }, { status: 404 });
  }
  const type = AUDIO_TYPES[found.format] ?? "application/octet-stream";
  const headers: Record<string, string> = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600" };
  if (req.nextUrl.searchParams.get("download")) {
    const t = await readTrack(id);
    headers["Content-Disposition"] = `attachment; filename="${(t?.id ?? id).replace(/"/g, "")}.${found.format}"`;
  }

  const range = req.headers.get("range");
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range);
  if (m) {
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
    if (start >= size || start > end) {
      return new NextResponse(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }
    const stream = Readable.toWeb(createReadStream(found.path, { start, end })) as ReadableStream;
    return new NextResponse(stream, {
      status: 206,
      headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) },
    });
  }
  const stream = Readable.toWeb(createReadStream(found.path)) as ReadableStream;
  return new NextResponse(stream, { headers: { ...headers, "Content-Length": String(size) } });
}
