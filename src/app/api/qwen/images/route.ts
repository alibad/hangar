import { NextResponse } from "next/server";
import { readdir, readFile, stat } from "fs/promises";
import path from "path";
import { outputDir } from "@/lib/save-image";

// Recursively collect subfolders (relative) and PNG files (relative) under root.
async function walk(absDir: string, relDir: string, folders: string[], pngs: string[]) {
  let entries;
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const rel = relDir ? `${relDir}/${e.name}` : e.name;
    if (e.isDirectory()) {
      folders.push(rel);
      await walk(path.join(absDir, e.name), rel, folders, pngs);
    } else if (e.name.toLowerCase().endsWith(".png")) {
      pngs.push(rel);
    }
  }
}

// Lists the full on-disk history (newest first) plus the folder tree. Each image
// reports its `rel` (path under the output dir) and `folder` (parent, "" = root).
export async function GET() {
  const dir = outputDir();
  const folders: string[] = [];
  const pngs: string[] = [];
  await walk(dir, "", folders, pngs);

  const images = await Promise.all(
    pngs.map(async (rel) => {
      const file = rel.includes("/") ? rel.slice(rel.lastIndexOf("/") + 1) : rel;
      const folder = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
      let meta: Record<string, unknown> = {};
      try {
        meta = JSON.parse(await readFile(path.join(dir, rel.replace(/\.png$/i, ".json")), "utf8"));
      } catch {
        /* no sidecar */
      }
      let bytes = meta.bytes as number | undefined;
      let savedAt = meta.savedAt as string | undefined;
      try {
        const s = await stat(path.join(dir, rel));
        bytes = s.size;
        if (!savedAt) savedAt = s.mtime.toISOString();
      } catch {
        /* ignore */
      }
      return {
        rel,
        file,
        folder,
        url: `/api/qwen/images/file?rel=${encodeURIComponent(rel)}`,
        kind: (meta.kind as string) ?? (file.includes("-edit-") ? "edit" : "generate"),
        favorite: meta.favorite === true,
        prompt: (meta.prompt as string) ?? "",
        seed: meta.seed as number | undefined,
        width: meta.width as number | undefined,
        height: meta.height as number | undefined,
        steps: meta.steps as number | undefined,
        cfg: meta.cfg as number | undefined,
        latency: meta.latency as number | undefined,
        inputCount: meta.inputCount as number | undefined,
        savedAt,
        bytes,
      };
    }),
  );

  images.sort((a, b) => String(b.savedAt ?? "").localeCompare(String(a.savedAt ?? "")) || b.rel.localeCompare(a.rel));
  folders.sort();
  return NextResponse.json({ images, folders, dir, count: images.length });
}
