import { NextRequest, NextResponse } from "next/server";
import { readFile, unlink } from "fs/promises";
import { imageContentType, resolveInside, safeRelImage, sidecarRelFor } from "@/lib/save-image";

// Serve a saved image (PNG, JPEG or WebP) by its relative path (may be inside a folder).
export async function GET(req: NextRequest) {
  const rel = safeRelImage(req.nextUrl.searchParams.get("rel") ?? req.nextUrl.searchParams.get("name"));
  const abs = rel && resolveInside(rel);
  if (!abs) return NextResponse.json({ error: "bad path" }, { status: 400 });
  try {
    const buf = await readFile(abs);
    return new NextResponse(new Uint8Array(buf), {
      headers: { "Content-Type": imageContentType(abs), "Cache-Control": "public, max-age=31536000, immutable" },
    });
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}

// Explicit, user-initiated delete: removes the image and its sidecar.
export async function DELETE(req: NextRequest) {
  const rel = safeRelImage(req.nextUrl.searchParams.get("rel") ?? req.nextUrl.searchParams.get("name"));
  const abs = rel && resolveInside(rel);
  if (!abs || !rel) return NextResponse.json({ error: "bad path" }, { status: 400 });
  try {
    await unlink(abs);
    const sidecar = resolveInside(sidecarRelFor(rel));
    if (sidecar) {
      try {
        await unlink(sidecar);
      } catch {
        /* sidecar may not exist */
      }
    }
    return NextResponse.json({ deleted: rel });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 404 });
  }
}
