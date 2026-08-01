import { mkdir, writeFile, stat } from "fs/promises";
import path from "path";
import { getDb } from "@/lib/db";

// Every generated/edited PNG is auto-saved here so nothing is lost when the
// browser tab closes. Override with QWEN_OUTPUT_DIR; defaults to ./generated
// (gitignored) at the project root.
export function outputDir(): string {
  return process.env.QWEN_OUTPUT_DIR || path.join(process.cwd(), "generated");
}

// ── path safety (folders live UNDER outputDir; never escape it) ──────────────

/** Resolve a relative path inside the output dir, or null if it would escape. */
export function resolveInside(rel: string): string | null {
  const root = path.resolve(outputDir());
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

/** Validate a folder path (may be nested, "" = root). Returns normalized or null. */
export function safeFolder(p: string | null | undefined): string | null {
  if (p == null) return null;
  const norm = String(p).replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (norm === "") return "";
  if (norm.includes("..")) return null;
  if (!/^([A-Za-z0-9._ -]+)(\/[A-Za-z0-9._ -]+)*$/.test(norm)) return null;
  return norm;
}

/** Validate a relative PNG path (may include nested folders). */
export function safeRelPng(rel: string | null | undefined): string | null {
  if (rel == null) return null;
  const norm = String(rel).replace(/\\/g, "/").replace(/^\/+/, "");
  if (norm.includes("..")) return null;
  if (!/^([A-Za-z0-9._ -]+\/)*[A-Za-z0-9._ -]+\.png$/.test(norm)) return null;
  return norm;
}

/** Turn a user-typed folder name into a filesystem-safe single segment. */
export function cleanFolderName(name: string): string {
  return String(name).replace(/[^A-Za-z0-9._ -]+/g, "-").replace(/\s+/g, " ").replace(/^[-.\s]+|[-.\s]+$/g, "").slice(0, 60);
}

function stamp(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`
  );
}

function slug(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export type SavedImage = { file: string; dir: string; path: string };

/**
 * Write a PNG to the output dir alongside a `.json` sidecar of its metadata,
 * and insert a record into the DuckDB images table. Returns the bare filename
 * + absolute path. Never throws — a disk problem must not fail an otherwise-
 * successful generation; callers get `null` instead.
 */
export async function saveImage(
  buf: Buffer,
  meta: Record<string, unknown> & { kind: string; seed: number; prompt?: string },
  batchJobId?: string,
): Promise<SavedImage | null> {
  try {
    const dir = outputDir();
    await mkdir(dir, { recursive: true });
    const base = [stamp(new Date()), meta.kind, meta.seed, slug(String(meta.prompt ?? ""))]
      .filter(Boolean)
      .join("-");
    const file = `${base}.png`;
    const full = path.join(dir, file);
    await writeFile(full, buf);

    const sidecarMeta: Record<string, unknown> = {
      file,
      savedAt: new Date().toISOString(),
      ...meta,
    };
    if (batchJobId) sidecarMeta.batch_job_id = batchJobId;
    await writeFile(
      path.join(dir, `${base}.json`),
      JSON.stringify(sidecarMeta, null, 2),
    );

    // Insert into DuckDB (non-fatal if it fails)
    try {
      const db = await getDb();
      const savedAt = sidecarMeta.savedAt as string;
      const fileBytes = (await stat(full)).size;
      const id = `img_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      await db.run(
        `INSERT INTO images (id, rel, folder, filename, kind, prompt, negative_prompt, seed, width, height, steps, cfg, latency, input_count, bytes, favorite, saved_at, batch_job_id, model)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id, file, "", file,
          meta.kind,
          String(meta.prompt || ""),
          String(meta.negative_prompt || ""),
          (meta.seed as number) ?? null,
          (meta.width as number) ?? null,
          (meta.height as number) ?? null,
          (meta.steps as number) ?? null,
          (meta.cfg as number) ?? null,
          (meta.latency as number) ?? null,
          (meta.inputCount as number) || (meta.input_count as number) || null,
          fileBytes,
          false,
          savedAt,
          batchJobId || null,
          String(meta.model || "qwen-image"),
        ],
      );
    } catch (dbErr) {
      console.error("[qwen] saveImage DB insert failed:", dbErr);
    }

    return { file, dir, path: full };
  } catch (err) {
    console.error("[qwen] saveImage failed:", err);
    return null;
  }
}
