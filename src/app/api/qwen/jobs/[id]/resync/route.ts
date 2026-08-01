import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import path from "path";
import fs from "fs/promises";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const outputDir =
    process.env.QWEN_OUTPUT_DIR || path.join(process.cwd(), "generated");

  const db = await getDb();
  const existing = await db.all<{ rel: string }>(
    "SELECT rel FROM images WHERE batch_job_id = ?",
    [id],
  );
  const existingRels = new Set(existing.map((r) => r.rel));

  const inserted: string[] = [];

  async function walk(dir: string, relDir: string) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(path.join(dir, e.name), rel);
        continue;
      }
      if (!e.name.toLowerCase().endsWith(".json")) continue;
      try {
        const meta = JSON.parse(
          await fs.readFile(path.join(dir, e.name), "utf8"),
        );
        if (meta.batch_job_id !== id) continue;
        const pngRel = rel.replace(/\.json$/i, ".png");
        if (existingRels.has(pngRel)) continue;
        const pngAbs = path.join(outputDir, pngRel);
        try {
          await fs.access(pngAbs);
        } catch {
          continue;
        }
        const st = await fs.stat(pngAbs);
        const filename = pngRel.includes("/")
          ? pngRel.slice(pngRel.lastIndexOf("/") + 1)
          : pngRel;
        const folder = pngRel.includes("/")
          ? pngRel.slice(0, pngRel.lastIndexOf("/"))
          : "";
        const imgId = `img_rs_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        await db.run(
          `INSERT INTO images (id, rel, folder, filename, kind, prompt, negative_prompt, seed, width, height, steps, cfg, latency, input_count, bytes, favorite, saved_at, batch_job_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            imgId,
            pngRel,
            folder,
            filename,
            (meta.kind as string) || "generate",
            String(meta.prompt || ""),
            String(meta.negative_prompt || ""),
            (meta.seed as number) ?? null,
            (meta.width as number) ?? null,
            (meta.height as number) ?? null,
            (meta.steps as number) ?? null,
            (meta.cfg as number) ?? null,
            (meta.latency as number) ?? null,
            null,
            st.size,
            false,
            (meta.savedAt as string) || st.mtime.toISOString(),
            id,
          ],
        );
        inserted.push(pngRel);
        existingRels.add(pngRel);
      } catch {
        /* skip malformed */
      }
    }
  }

  await walk(outputDir, "");
  return NextResponse.json({ synced: inserted.length, files: inserted });
}
