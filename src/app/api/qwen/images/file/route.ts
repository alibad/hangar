import { NextRequest, NextResponse } from "next/server";
import { readFile, unlink } from "fs/promises";
import { resolveInside, safeRelPng } from "@/lib/save-image";

// Serve a saved PNG by its relative path (may be inside a folder).
export async function GET(req: NextRequest) {
  const rel = safeRelPng(req.nextUrl.searchParams.get("rel") ?? req.nextUrl.searchParams.get("name"));
  const abs = rel && resolveInside(rel);
  if (!abs) return NextResponse.json({ error: "bad path" }, { status: 400 });
  try {
    const buf = await readFile(abs);
    return new NextResponse(new Uint8Array(buf), {
      headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=31536000, immutable" },
    });
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}

// Explicit, user-initiated delete: removes the PNG and its sidecar.
export async function DELETE(req: NextRequest) {
  const rel = safeRelPng(req.nextUrl.searchParams.get("rel") ?? req.nextUrl.searchParams.get("name"));
  const abs = rel && resolveInside(rel);
  if (!abs || !rel) return NextResponse.json({ error: "bad path" }, { status: 400 });
  try {
    await unlink(abs);
    const sidecar = resolveInside(rel.replace(/\.png$/i, ".json"));
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
