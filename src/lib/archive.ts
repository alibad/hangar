import path from "path";

// Where the Qwen server mirrors EVERY generation (a flat, source-tagged log).
// Read-only from the console's side — the server owns the writes. This mirrors
// the server's own default (QWEN_ARCHIVE_DIR env, else <console>/archive) so the
// two sides meet with zero configuration.
export function archiveDir(): string {
  return process.env.QWEN_ARCHIVE_DIR || path.join(process.cwd(), "archive");
}

// Resolve a relative path inside the archive dir, or null if it would escape it.
export function resolveInArchive(rel: string): string | null {
  const root = path.resolve(archiveDir());
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}
