import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Mirror a generated image into the Activity archive.
 *
 * ── TWO STORES, ON PURPOSE ──────────────────────────────────────────────────
 * `generated/` is the studio GALLERY: what you chose to keep, in the folders
 * you chose. `archive/` is the Activity FIREHOSE: every image this box produced,
 * from any caller — the console, quote-forge, a script — tagged by source.
 *
 * ── THE BUG THIS FIXES ──────────────────────────────────────────────────────
 * This used to run only when `target === "comfyui"`, on the reasoning that the
 * native Qwen service writes its own archive entry. True on BeTenshi, and only
 * there. On every other host nothing ever wrote to `archive/`, so the Activity
 * tab — whose own subtitle promises "every image this box generates" — said
 * "No images yet" while four real images sat in the gallery. The 2026-09-21
 * audit found the Image Studio's "View saved images" button leading straight to
 * that empty page.
 *
 * So the rule is now stated as what it actually is: mirror unless the BACKEND
 * already mirrors for itself, which is a property of the driver and is declared
 * in the host profile rather than inferred from a service id.
 *
 * Returns the archive-relative path, so the caller can hand the Requests feed a
 * viewable artifact. Without it the detail panel's only option is to re-fetch
 * the URL — which it correctly refuses to do for a POST, and which for an image
 * would mean spending the GPU a second time to look at the answer.
 */
export async function mirrorImageHistory(
  png: Buffer,
  meta: Record<string, unknown>,
): Promise<string | null> {
  const now = new Date();
  const pad = (n: number, digits = 2) => String(n).padStart(digits, "0");
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const root = process.env.QWEN_ARCHIVE_DIR || path.join(process.cwd(), "archive");
  // Preserve the native writer's lexically chronological filename convention.
  const stamp = `${day.replace(/-/g, "")}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}`;
  const file = `${stamp}-console-${meta.kind === "edit" ? "edit" : "generate"}-${crypto.randomUUID()}.png`;
  try {
    await mkdir(path.join(root, day), { recursive: true });
    await writeFile(path.join(root, day, file), png);
    await writeFile(
      path.join(root, day, file.replace(/\.png$/, ".json")),
      JSON.stringify({ ...meta, source: "console", file, savedAt: now.toISOString(), bytes: png.length }, null, 2),
    );
    return `${day}/${file}`;
  } catch (error) {
    console.error("Image history mirror failed:", error);
    return null;
  }
}
