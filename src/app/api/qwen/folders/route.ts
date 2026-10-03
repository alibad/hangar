import { NextRequest, NextResponse } from "next/server";
import { mkdir, rm, rename } from "fs/promises";
import { resolveInside, safeFolder } from "@/lib/save-image";
import { getDb } from "@/lib/db";
import { revealInExplorer } from "@/lib/reveal-in-explorer";
import { isLabStorage } from "@/lib/gallery-folders";

// Folder management: create / rename / delete galleries on disk under the output
// dir. Folders are real directories, so the hierarchy mirrors the filesystem.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const action = String(body.action ?? "");

  if (action === "create") {
    const folder = safeFolder(body.path);
    if (!folder) return NextResponse.json({ error: "bad folder name" }, { status: 400 });
    const abs = resolveInside(folder);
    if (!abs) return NextResponse.json({ error: "bad path" }, { status: 400 });
    await mkdir(abs, { recursive: true });
    return NextResponse.json({ ok: true, path: folder });
  }

  if (action === "rename") {
    const from = safeFolder(body.path);
    const to = safeFolder(body.newPath);
    if (!from || !to) return NextResponse.json({ error: "bad folder name" }, { status: 400 });
    const fromAbs = resolveInside(from);
    const toAbs = resolveInside(to);
    if (!fromAbs || !toAbs) return NextResponse.json({ error: "bad path" }, { status: 400 });
    try {
      await rename(fromAbs, toAbs);
      // Repoint every row under the old prefix — the gallery reads from the DB,
      // so without this the renamed folder's images all break.
      const db = await getDb();
      await db.run(
        `UPDATE images
            SET rel    = ? || substr(rel, ?),
                folder = ? || substr(folder, ?)
          WHERE rel LIKE ?`,
        [to, from.length + 1, to, from.length + 1, `${from}/%`],
      );
      return NextResponse.json({ ok: true, path: to });
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
    }
  }

  // Reveal the folder in Windows Explorer on the machine running the console,
  // in front of the browser (revealInExplorer says why that takes a script).
  if (action === "reveal") {
    const folder = safeFolder(body.path) ?? "";
    const abs = resolveInside(folder);
    if (!abs) return NextResponse.json({ error: "bad path" }, { status: 400 });
    const result = await revealInExplorer(abs.replace(/\//g, "\\"));
    return NextResponse.json(result, { status: result.ok ? 200 : 500 });
  }

  if (action === "delete") {
    const folder = safeFolder(body.path);
    if (!folder) return NextResponse.json({ error: "cannot delete root" }, { status: 400 });
    // The 3D and Video Labs keep their jobs here too; that is not the gallery's to delete.
    if (isLabStorage(folder)) return NextResponse.json({ error: `"${folder}" holds another lab's jobs, not gallery images` }, { status: 400 });
    const abs = resolveInside(folder);
    if (!abs) return NextResponse.json({ error: "bad path" }, { status: 400 });
    // recursive:true removes the folder and everything in it — the UI gates this
    // behind a confirm that spells out the image count.
    try {
      await rm(abs, { recursive: true, force: true });
      // Drop the rows too, or the gallery keeps listing images whose files are gone.
      const db = await getDb();
      await db.run("DELETE FROM images WHERE folder = ? OR folder LIKE ?", [
        folder,
        `${folder}/%`,
      ]);
      return NextResponse.json({ ok: true, deleted: folder });
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
    }
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
