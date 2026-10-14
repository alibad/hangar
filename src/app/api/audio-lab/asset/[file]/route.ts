import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { audioFile } from "@/lib/audio-store";
import { isHostedRuntime } from "@/lib/runtime";

export const runtime = "nodejs";
export async function GET(req: NextRequest, { params }: { params: Promise<{ file: string }> }) {
  if (isHostedRuntime()) return new NextResponse("Local audio is not available on the hosted app", { status: 404 });
  const { file } = await params, pathname = audioFile(file);
  if (!pathname || file.endsWith(".json")) return new NextResponse("Not found", { status: 404 });
  try {
    const bytes = await readFile(pathname), ext = file.split(".").pop()!;
    const type = ({ wav: "audio/wav", mp3: "audio/mpeg", ogg: "audio/ogg", flac: "audio/flac", webm: "audio/webm", m4a: "audio/mp4" } as Record<string, string>)[ext];
    return new NextResponse(bytes, { headers: { "Content-Type": type, "Content-Length": String(bytes.length), "Cache-Control": "private, max-age=31536000, immutable" } });
  } catch { return new NextResponse("Not found", { status: 404 }); }
}
