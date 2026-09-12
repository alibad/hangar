import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** Qwen mirrors natively; ComfyUI results need the same Activity history entry. */
export async function mirrorImageHistory(png: Buffer, meta: Record<string, unknown>) {
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
    await writeFile(path.join(root, day, file.replace(/\.png$/, ".json")), JSON.stringify({ ...meta, source: "console", file, savedAt: now.toISOString(), bytes: png.length }, null, 2));
  } catch (error) { console.error("Image history mirror failed:", error); }
}
