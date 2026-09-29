import { NextRequest, NextResponse } from "next/server";
import { copyFile, mkdir, writeFile } from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { resolveInside } from "@/lib/save-image";
import { videoRoot } from "@/lib/video-jobs";

export const dynamic = "force-dynamic";

/**
 * POST — register a still as a source for image-to-video. Either
 *   { dataUrl: "data:image/png;base64,…" }   an upload, or
 *   { galleryRel: "folder/file.png" }         an image already in the gallery
 *                                             (e.g. one a local model just made).
 * The still is copied under generated/video/sources so a clip keeps its source
 * even if the gallery image is later deleted.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { dataUrl?: string; galleryRel?: string };
  const dir = path.join(videoRoot(), "sources");
  await mkdir(dir, { recursive: true });
  const id = randomUUID().slice(0, 12);

  if (body.dataUrl) {
    const m = /^data:image\/(png|jpeg|webp);base64,([\s\S]+)$/.exec(body.dataUrl);
    if (!m) return NextResponse.json({ error: "Upload a PNG, JPEG or WebP image" }, { status: 400 });
    const bytes = Buffer.from(m[2], "base64");
    if (bytes.length > 25 * 1024 * 1024) return NextResponse.json({ error: "Image is over 25 MB" }, { status: 400 });
    const file = `${id}.${m[1] === "jpeg" ? "jpg" : m[1]}`;
    await writeFile(path.join(dir, file), bytes);
    return NextResponse.json({ path: `sources/${file}` });
  }

  if (body.galleryRel) {
    const src = resolveInside(body.galleryRel);
    const ext = path.extname(body.galleryRel).toLowerCase();
    if (!src || ![".png", ".jpg", ".jpeg", ".webp"].includes(ext)) {
      return NextResponse.json({ error: "Not a gallery image" }, { status: 400 });
    }
    const file = `${id}${ext}`;
    try {
      await copyFile(src, path.join(dir, file));
    } catch {
      return NextResponse.json({ error: "Gallery image not found on disk" }, { status: 404 });
    }
    return NextResponse.json({ path: `sources/${file}` });
  }

  return NextResponse.json({ error: "Send dataUrl or galleryRel" }, { status: 400 });
}
