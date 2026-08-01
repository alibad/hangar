import { NextRequest, NextResponse } from "next/server";
import { mkdir, rename, access, readdir } from "fs/promises";
import path from "path";
import { resolveInside, safeRelPng, safeFolder } from "@/lib/save-image";
import { getDb } from "@/lib/db";

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

const outputDir = () =>
  process.env.QWEN_OUTPUT_DIR || path.join(process.cwd(), "generated");

/** Locate a file by basename anywhere under the output dir. */
async function findByBasename(base: string): Promise<string | null> {
  const root = outputDir();
  async function walk(dir: string, relDir: string): Promise<string | null> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const e of entries) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        const hit = await walk(path.join(dir, e.name), rel);
        if (hit) return hit;
      } else if (e.name === base) {
        return rel;
      }
    }
    return null;
  }
  return walk(root, "");
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const rel = safeRelPng(body.rel);
  const toFolder = safeFolder(body.toFolder);
  if (rel == null || toFolder == null) return NextResponse.json({ error: "bad path" }, { status: 400 });

  const srcAbs = resolveInside(rel);
  const destDirAbs = resolveInside(toFolder || "");
  if (!srcAbs || !destDirAbs) return NextResponse.json({ error: "bad path" }, { status: 400 });

  const base = path.basename(rel);
  const srcFolder = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
  if (srcFolder === toFolder) return NextResponse.json({ rel, unchanged: true });

  try {
    await mkdir(destDirAbs, { recursive: true });

    // The DB row can point at a stale path if the file was moved behind its back.
    // Rather than failing with ENOENT, find where the file actually is and repair
    // the row — if it already sits in the destination there is nothing to move.
    if (!(await exists(srcAbs))) {
      const actual = await findByBasename(base);
      if (!actual) {
        return NextResponse.json(
          { error: `Source file is missing from disk: ${rel}` },
          { status: 404 },
        );
      }
      const actualFolder = actual.includes("/") ? actual.slice(0, actual.lastIndexOf("/")) : "";
      const db = await getDb();
      if (actualFolder === toFolder) {
        await db.run(
          "UPDATE images SET rel = ?, folder = ?, filename = ? WHERE rel = ?",
          [actual, actualFolder, base, rel],
        );
        return NextResponse.json({ rel: actual, movedTo: toFolder, healed: true });
      }
      const actualAbs = resolveInside(actual);
      if (!actualAbs) return NextResponse.json({ error: "bad path" }, { status: 400 });
      let healName = base;
      const healStem = base.replace(/\.png$/i, "");
      for (let i = 1; await exists(path.join(destDirAbs, healName)); i++) healName = `${healStem}-${i}.png`;
      const healRel = toFolder ? `${toFolder}/${healName}` : healName;
      await rename(actualAbs, path.join(destDirAbs, healName));
      await db.run(
        "UPDATE images SET rel = ?, folder = ?, filename = ? WHERE rel = ?",
        [healRel, toFolder, healName, rel],
      );
      return NextResponse.json({ rel: healRel, movedTo: toFolder, healed: true });
    }

    let name = base;
    const stem = base.replace(/\.png$/i, "");
    for (let i = 1; await exists(path.join(destDirAbs, name)); i++) name = `${stem}-${i}.png`;

    const newRel = toFolder ? `${toFolder}/${name}` : name;
    await rename(srcAbs, path.join(destDirAbs, name));

    // Update DB
    const db = await getDb();
    await db.run(
      "UPDATE images SET rel = ?, folder = ?, filename = ? WHERE rel = ?",
      [newRel, toFolder, name, rel],
    );

    // Move sidecar alongside (best-effort)
    const srcSidecar = resolveInside(rel.replace(/\.png$/i, ".json"));
    if (srcSidecar && (await exists(srcSidecar))) {
      try {
        const destSidecar = path.join(destDirAbs, name.replace(/\.png$/i, ".json"));
        await rename(srcSidecar, destSidecar);
      } catch { /* ignore */ }
    }

    return NextResponse.json({ rel: newRel, movedTo: toFolder });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
