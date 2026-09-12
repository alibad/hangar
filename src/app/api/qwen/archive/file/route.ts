import { NextRequest, NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { resolveInArchive } from "@/lib/archive";
import { safeRelPng } from "@/lib/save-image";

// Serve an archived PNG by its relative path (date-dir + filename). Read-only —
// the Activity view never mutates the archive, so there's no DELETE here.
export async function GET(req: NextRequest) {
  const rel = safeRelPng(req.nextUrl.searchParams.get("rel"));
  const abs = rel && resolveInArchive(rel);
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
