import { NextRequest, NextResponse } from "next/server";
import { readFile, writeFile } from "fs/promises";
import { resolveInside, safeRelPng } from "@/lib/save-image";

// Toggle an image's favorite flag, persisted in its `.json` sidecar (created if
// it doesn't exist yet) so it survives reloads and shows in any file browser.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const rel = safeRelPng(body.rel);
  if (!rel) return NextResponse.json({ error: "bad path" }, { status: 400 });
  const favorite = body.favorite === true;

  const sidecarRel = rel.replace(/\.png$/i, ".json");
  const abs = resolveInside(sidecarRel);
  if (!abs) return NextResponse.json({ error: "bad path" }, { status: 400 });

  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(await readFile(abs, "utf8"));
  } catch {
    /* no sidecar yet — create a minimal one */
  }
  meta.favorite = favorite;
  try {
    await writeFile(abs, JSON.stringify(meta, null, 2));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
  return NextResponse.json({ rel, favorite });
}
