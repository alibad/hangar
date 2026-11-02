import { NextRequest } from "next/server";
import path from "path";
import { resolveVideoPath } from "@/lib/video-jobs";
import { serveFile } from "@/lib/http-range";

export const dynamic = "force-dynamic";

const TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

/** GET ?path=<relative to generated/video> — a clip or a source still, seekable. */
export async function GET(req: NextRequest) {
  const rel = req.nextUrl.searchParams.get("path") ?? "";
  const full = resolveVideoPath(rel);
  const type = TYPES[path.extname(rel).toLowerCase()];
  if (!full || !type) return new Response("Not found", { status: 404 });
  return serveFile(req, full, type, { download: req.nextUrl.searchParams.get("download") === "1" });
}
