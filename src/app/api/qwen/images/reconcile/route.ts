import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import path from "path";
import fs from "fs/promises";

/**
 * Re-sync the images table with what is actually on disk.
 *
 * The gallery reads only from DuckDB, so any file moved behind the DB's back
 * leaves a row pointing at a path that no longer exists — the image shows in the
 * wrong folder and moving it again fails with ENOENT. Causes seen in the wild:
 * a folder renamed/deleted straight on disk, and moves that landed on a
 * different database than the one now in use.
 *
 * Three repairs, in order of preference:
 *   relocated — row's file is gone but the same filename exists elsewhere → repoint
 *   added     — file on disk with no row → insert (reading its .json sidecar)
 *   removed   — row's file is gone and nothing matches → drop the row
 */
export async function POST() {
  const outputDir =
    process.env.QWEN_OUTPUT_DIR || path.join(process.cwd(), "generated");
  const db = await getDb();

  const diskRels: string[] = [];
  async function walk(dir: string, relDir: string) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(dir, e.name), rel);
      else if (e.name.toLowerCase().endsWith(".png")) diskRels.push(rel);
    }
  }
  await walk(outputDir, "");

  const rows = await db.all<{ rel: string }>("SELECT rel FROM images");
  const dbRels = new Set(rows.map((r) => r.rel));
  const diskSet = new Set(diskRels);

  // basename -> rel, for spotting a file that simply moved
  const byBase = new Map<string, string>();
  for (const rel of diskRels) {
    const base = rel.includes("/") ? rel.slice(rel.lastIndexOf("/") + 1) : rel;
    if (!byBase.has(base)) byBase.set(base, rel);
  }

  const relocated: { from: string; to: string }[] = [];
  const removed: string[] = [];
  const added: string[] = [];

  const split = (rel: string) => ({
    folder: rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "",
    filename: rel.includes("/") ? rel.slice(rel.lastIndexOf("/") + 1) : rel,
  });

  for (const rel of dbRels) {
    if (diskSet.has(rel)) continue;
    const base = split(rel).filename;
    const found = byBase.get(base);
    if (found && !dbRels.has(found)) {
      const { folder, filename } = split(found);
      await db.run(
        "UPDATE images SET rel = ?, folder = ?, filename = ? WHERE rel = ?",
        [found, folder, filename, rel],
      );
      relocated.push({ from: rel, to: found });
      dbRels.add(found);
    } else {
      await db.run("DELETE FROM images WHERE rel = ?", [rel]);
      removed.push(rel);
    }
  }

  for (const rel of diskRels) {
    if (dbRels.has(rel)) continue;
    const { folder, filename } = split(rel);
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(
        await fs.readFile(path.join(outputDir, rel.replace(/\.png$/i, ".json")), "utf8"),
      );
    } catch {
      /* no sidecar — insert what we can */
    }
    let bytes: number | null = null;
    let savedAt = (meta.savedAt as string) || null;
    try {
      const st = await fs.stat(path.join(outputDir, rel));
      bytes = st.size;
      if (!savedAt) savedAt = st.mtime.toISOString();
    } catch {
      /* ignore */
    }
    await db.run(
      `INSERT INTO images (id, rel, folder, filename, kind, prompt, negative_prompt, seed,
                           width, height, steps, cfg, latency, input_count, bytes, favorite,
                           saved_at, batch_job_id, model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        `img_rc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        rel, folder, filename,
        (meta.kind as string) || (filename.includes("-edit-") ? "edit" : "generate"),
        String(meta.prompt || ""),
        String(meta.negative_prompt || ""),
        (meta.seed as number) ?? null,
        (meta.width as number) ?? null,
        (meta.height as number) ?? null,
        (meta.steps as number) ?? null,
        (meta.cfg as number) ?? null,
        (meta.latency as number) ?? null,
        (meta.inputCount as number) ?? (meta.input_count as number) ?? null,
        bytes,
        meta.favorite === true,
        savedAt || new Date().toISOString(),
        (meta.batch_job_id as string) || null,
        // The sidecar records which model made it. Defaulting to qwen-image here
        // would mislabel every re-indexed FLUX image as Qwen's.
        (meta.model as string) || "qwen-image",
      ],
    );
    added.push(rel);
    dbRels.add(rel);
  }

  return NextResponse.json({
    ok: true,
    diskCount: diskRels.length,
    relocated: relocated.length,
    added: added.length,
    removed: removed.length,
    details: { relocated, added, removed },
  });
}
