import { NextRequest, NextResponse } from "next/server";
import { readFile, writeFile } from "fs/promises";
import { resolveInside, safeRelPng } from "@/lib/save-image";
import { getDb } from "@/lib/db";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const rel = safeRelPng(body.rel);
  if (!rel) return NextResponse.json({ error: "bad path" }, { status: 400 });
  const favorite = body.favorite === true;

  const db = await getDb();
  await db.run("UPDATE images SET favorite = ? WHERE rel = ?", [favorite, rel]);

  // Also update sidecar for backward compat (best-effort)
  const sidecarAbs = resolveInside(rel.replace(/\.png$/i, ".json"));
  if (sidecarAbs) {
    try {
      let meta: Record<string, unknown> = {};
      try { meta = JSON.parse(await readFile(sidecarAbs, "utf8")); } catch { /* no sidecar */ }
      meta.favorite = favorite;
      await writeFile(sidecarAbs, JSON.stringify(meta, null, 2));
    } catch { /* ignore sidecar errors */ }
  }

  return NextResponse.json({ rel, favorite });
}
