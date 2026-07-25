import { NextRequest, NextResponse } from "next/server";
import { mkdir, rm, rename } from "fs/promises";
import { resolveInside, safeFolder } from "@/lib/save-image";

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
      return NextResponse.json({ ok: true, path: to });
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
    }
  }

  if (action === "delete") {
    const folder = safeFolder(body.path);
    if (!folder) return NextResponse.json({ error: "cannot delete root" }, { status: 400 });
    const abs = resolveInside(folder);
    if (!abs) return NextResponse.json({ error: "bad path" }, { status: 400 });
    // recursive:true removes the folder and everything in it — the UI gates this
    // behind a confirm that spells out the image count.
    try {
      await rm(abs, { recursive: true, force: true });
      return NextResponse.json({ ok: true, deleted: folder });
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
    }
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
