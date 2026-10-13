import { NextRequest, NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { resolveInside, safeRelImage, sidecarRelFor } from "@/lib/save-image";

// A gallery image's sidecar: the full parameter set it was made with.
//
// The DuckDB row holds what every model shares (prompt, size, seed, steps); a
// hosted model's quality, background, format, count, references and cost live
// only here, so the details panel reads them on open instead of the gallery
// list carrying them for every image.
export async function GET(req: NextRequest) {
  const rel = safeRelImage(req.nextUrl.searchParams.get("rel"));
  const abs = rel && resolveInside(sidecarRelFor(rel));
  if (!abs) return NextResponse.json({ error: "bad path" }, { status: 400 });
  try {
    const meta = JSON.parse(await readFile(abs, "utf8"));
    return NextResponse.json(meta, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "no sidecar" }, { status: 404 });
  }
}
