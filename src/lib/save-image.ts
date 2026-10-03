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

// ── image formats ────────────────────────────────────────────────────────────
//
// The gallery was PNG-only because every backend returned PNG. Hosted models
// don't: gpt-image takes output_format png|jpeg|webp, and writing webp bytes
// into a .png file gives a file every viewer, the OS and `file(1)` disagree
// about. The format is read from the bytes (not from what was asked for), so a
// provider that ignores the request still gets an honest extension.

export type ImageFormat = "png" | "jpeg" | "webp";

const EXTENSION: Record<ImageFormat, string> = { png: ".png", jpeg: ".jpg", webp: ".webp" };
const MIME: Record<ImageFormat, string> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };

/** Every extension the gallery serves, lists and reconciles. */
export const GALLERY_IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

/** The format of an encoded image, from its magic bytes; null when unrecognised. */
export function sniffImageFormat(buf: Uint8Array): ImageFormat | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && // RIFF
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50 // WEBP
  ) return "webp";
  return null;
}

export function imageMime(format: ImageFormat): string {
  return MIME[format];
}

/** Content-Type for a gallery path, by extension. */
export function imageContentType(rel: string): string {
  const ext = rel.slice(rel.lastIndexOf(".")).toLowerCase();
  if (ext === ".webp") return MIME.webp;
  if (ext === ".jpg" || ext === ".jpeg") return MIME.jpeg;
  return MIME.png;
}

/** Validate a relative gallery image path (png, jpg/jpeg or webp; may be nested). */
export function safeRelImage(rel: string | null | undefined): string | null {
  if (rel == null) return null;
  const norm = String(rel).replace(/\\/g, "/").replace(/^\/+/, "");
  if (norm.includes("..")) return null;
  if (!/^([A-Za-z0-9._ -]+\/)*[A-Za-z0-9._ -]+\.(png|jpe?g|webp)$/i.test(norm)) return null;
  return norm;
}

/** The `.json` sidecar beside a gallery image, whatever its format. */
export function sidecarRelFor(rel: string): string {
  return rel.replace(GALLERY_IMAGE_EXT, ".json");
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
 * Write an image to the output dir alongside a `.json` sidecar of its metadata,
 * and insert a record into the DuckDB images table. Returns the gallery-relative filename
 * + absolute path. Never throws — a disk problem must not fail an otherwise-
 * successful generation; callers get `null` instead.
 *
 * The extension follows the bytes: PNG, JPEG or WebP, and anything unrecognised
 * stays .png as before. Names never collide: the n images of one hosted call
 * share a timestamp, seed and prompt, so a clash gets a -2, -3 suffix instead
 * of silently overwriting its sibling.
 */
export async function saveImage(
  buf: Buffer,
  meta: Record<string, unknown> & { kind: string; seed: number; prompt?: string },
  batchJobId?: string,
): Promise<SavedImage | null> {
  try {
    const folder = safeFolder(meta.folder == null ? "" : String(meta.folder));
    if (folder === null) throw new Error("Invalid destination gallery");
    const dir = path.join(outputDir(), folder);
    await mkdir(dir, { recursive: true });
    const base = [stamp(new Date()), meta.kind, meta.seed, slug(String(meta.prompt ?? ""))]
      .filter(Boolean)
      .join("-");
    const format = sniffImageFormat(buf) ?? "png";
    let stem = base;
    let file = `${stem}${EXTENSION[format]}`;
    let full = path.join(dir, file);
    for (let i = 2; ; i++) {
      try {
        await writeFile(full, buf, { flag: "wx" });
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST" || i > 50) throw err;
        stem = `${base}-${i}`;
        file = `${stem}${EXTENSION[format]}`;
        full = path.join(dir, file);
      }
    }
    const rel = folder ? folder + "/" + file : file;

    const sidecarMeta: Record<string, unknown> = {
      file,
      savedAt: new Date().toISOString(),
      ...meta,
      // What the bytes are, which is not always what was asked for.
      format,
    };
    if (batchJobId) sidecarMeta.batch_job_id = batchJobId;
    await writeFile(
      path.join(dir, `${stem}.json`),
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
          id, rel, folder, file,
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

    return { file: rel, dir, path: full };
  } catch (err) {
    console.error("[qwen] saveImage failed:", err);
    return null;
  }
}
