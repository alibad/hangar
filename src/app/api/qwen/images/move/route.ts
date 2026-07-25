import { NextRequest, NextResponse } from "next/server";
import { mkdir, rename, access } from "fs/promises";
import path from "path";
import { resolveInside, safeRelPng, safeFolder } from "@/lib/save-image";

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// Move an image (and its .json sidecar) into a target folder. Folder "" = root.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const rel = safeRelPng(body.rel);
  const toFolder = safeFolder(body.toFolder);
  if (rel == null || toFolder == null) return NextResponse.json({ error: "bad path" }, { status: 400 });

  const srcAbs = resolveInside(rel);
  const destDirAbs = resolveInside(toFolder);
  if (!srcAbs || !destDirAbs) return NextResponse.json({ error: "bad path" }, { status: 400 });

  const base = path.basename(rel);
  const srcFolder = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
  if (srcFolder === toFolder) return NextResponse.json({ rel, unchanged: true });

  try {
    await mkdir(destDirAbs, { recursive: true });

    // Avoid clobbering a same-named file already in the destination.
    let name = base;
    const stem = base.replace(/\.png$/i, "");
    for (let i = 1; await exists(path.join(destDirAbs, name)); i++) name = `${stem}-${i}.png`;

    const newRel = toFolder ? `${toFolder}/${name}` : name;
    await rename(srcAbs, path.join(destDirAbs, name));

    // Move sidecar alongside (best-effort).
    const srcSidecar = resolveInside(rel.replace(/\.png$/i, ".json"));
    const destSidecar = path.join(destDirAbs, name.replace(/\.png$/i, ".json"));
    if (srcSidecar && (await exists(srcSidecar))) {
      try {
        await rename(srcSidecar, destSidecar);
      } catch {
        /* ignore */
      }
    }
    return NextResponse.json({ rel: newRel, movedTo: toFolder });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
