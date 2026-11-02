import { NextRequest } from "next/server";
import path from "path";
import { isHostedRuntime } from "@/lib/runtime";
import { resolveMediaFile } from "@/lib/library";
import { serveFile } from "@/lib/http-range";

export const dynamic = "force-dynamic";

const TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp",
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".mkv": "video/x-matroska", ".avi": "video/x-msvideo",
  ".wav": "audio/wav", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".opus": "audio/ogg", ".flac": "audio/flac", ".m4a": "audio/mp4",
  ".glb": "model/gltf-binary",
};

/**
 * GET ?id=            the file itself, seekable
 * GET ?id=&poster=1   the picture a model or clip is shown with
 * GET ?id=&sample=n   a collection's n-th sample
 *
 * Files are found by id; only files inside the Library's folders are served.
 */
export async function GET(request: NextRequest) {
  if (isHostedRuntime()) return new Response("Run Hangar locally", { status: 501 });
  const params = request.nextUrl.searchParams;
  const sample = params.get("sample");
  const file = await resolveMediaFile(params.get("id") ?? "", { poster: params.get("poster") === "1", sample: sample == null ? undefined : Number(sample) });
  if (!file || file.kind === "collection") return new Response("Not found", { status: 404 });
  const type = TYPES[path.extname(file.path).toLowerCase()];
  if (!type) return new Response("Not found", { status: 404 });
  return serveFile(request, file.path, type, { download: params.get("download") === "1" });
}
