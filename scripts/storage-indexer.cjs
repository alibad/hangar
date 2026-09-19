/*
 * BeTenshi Storage Indexer
 *
 * A deterministic, token-free background worker for whole-drive metadata.
 * It deliberately runs outside Next.js so a long scan survives route reloads,
 * writes progress to disk, and never blocks the console request loop.
 */

const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

// Mirrors the resolution in src/lib/storage-index.ts exactly. It has to: the
// console and this worker write the same status, lock and watcher files, so
// resolving them differently gives two half-states that each look like the
// other side never ran.
const STATE_ROOT = process.env.LOCALAPPDATA || process.cwd();
const LEGACY_STATE = path.join(STATE_ROOT, "betenshi", "storage");
const STATE_DIR = fs.existsSync(LEGACY_STATE)
  ? LEGACY_STATE
  : path.join(STATE_ROOT, "hangar", "storage");
// Both names: the parent passes HANGAR_STORAGE_DB since the rename, and a
// machine whose environment still sets the old one must keep working. Reading
// only one of them makes the worker index a DIFFERENT database from the one
// the console reads, which looks like a scan that silently found nothing.
const DB_PATH =
  process.env.HANGAR_STORAGE_DB ||
  process.env.BETENSHI_STORAGE_DB ||
  path.join(STATE_DIR, "storage-index.sqlite");
const STATUS_PATH = path.join(STATE_DIR, "scan-status.json");
const LOCK_PATH = path.join(STATE_DIR, "scan.lock");
const WATCHERS_PATH = path.join(STATE_DIR, "watchers.json");

const SKIP_NAMES = new Set([
  "$recycle.bin",
  "system volume information",
  "recovery",
  "config.msi",
  "msocache",
]);

const PROTECTED_PARTS = [
  "\\windows",
  "\\program files",
  "\\program files (x86)",
  "\\programdata",
  "\\system volume information",
  "\\$recycle.bin",
];

function nowIso() {
  return new Date().toISOString();
}

function normalizeAbsolute(input) {
  if (typeof input !== "string" || !path.win32.isAbsolute(input)) throw new Error("An absolute Windows path is required.");
  return path.win32.normalize(input);
}

function rootOf(input) {
  return path.win32.parse(normalizeAbsolute(input)).root.toUpperCase();
}

function isInside(root, candidate) {
  const normalizedRoot = normalizeAbsolute(root).toLowerCase();
  const normalizedCandidate = normalizeAbsolute(candidate).toLowerCase();
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(normalizedRoot.endsWith("\\") ? normalizedRoot : `${normalizedRoot}\\`);
}

function assertManageable(input) {
  const normalized = normalizeAbsolute(input);
  const lower = normalized.toLowerCase();
  if (normalized === path.win32.parse(normalized).root) throw new Error("A drive root cannot be moved.");
  if (PROTECTED_PARTS.some((part) => lower.includes(part))) throw new Error("Protected Windows system paths cannot be moved by Storage Manager.");
  const base = path.win32.basename(lower);
  if (["pagefile.sys", "hiberfil.sys", "swapfile.sys"].includes(base)) throw new Error("Protected Windows system files cannot be moved.");
  return normalized;
}

function assertDestination(input) {
  const normalized = normalizeAbsolute(input);
  const lower = normalized.toLowerCase();
  if (PROTECTED_PARTS.some((part) => lower.includes(part))) throw new Error("Protected Windows system paths cannot be used as move destinations.");
  return normalized;
}

function openDb() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS roots (
      root TEXT PRIMARY KEY,
      label TEXT,
      total_bytes INTEGER DEFAULT 0,
      free_bytes INTEGER DEFAULT 0,
      scanned_at TEXT,
      scan_id TEXT,
      file_count INTEGER DEFAULT 0,
      dir_count INTEGER DEFAULT 0,
      indexed_bytes INTEGER DEFAULT 0,
      status TEXT DEFAULT 'never',
      dirty INTEGER DEFAULT 0,
      watching INTEGER DEFAULT 0,
      last_error TEXT
    );
    CREATE TABLE IF NOT EXISTS entries (
      path TEXT PRIMARY KEY,
      root TEXT NOT NULL,
      parent TEXT NOT NULL,
      name TEXT NOT NULL,
      ext TEXT NOT NULL DEFAULT '',
      size INTEGER NOT NULL DEFAULT 0,
      mtime_ms INTEGER NOT NULL DEFAULT 0,
      created_ms INTEGER NOT NULL DEFAULT 0,
      hidden INTEGER NOT NULL DEFAULT 0,
      scan_id TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS entries_root_size ON entries(root, size DESC);
    CREATE INDEX IF NOT EXISTS entries_parent ON entries(parent);
    CREATE INDEX IF NOT EXISTS entries_name ON entries(name);
    CREATE INDEX IF NOT EXISTS entries_ext ON entries(ext);
    CREATE TABLE IF NOT EXISTS folders (
      path TEXT PRIMARY KEY,
      root TEXT NOT NULL,
      parent TEXT NOT NULL,
      name TEXT NOT NULL,
      size INTEGER NOT NULL DEFAULT 0,
      file_count INTEGER NOT NULL DEFAULT 0,
      dir_count INTEGER NOT NULL DEFAULT 0,
      mtime_ms INTEGER NOT NULL DEFAULT 0,
      scan_id TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS folders_parent ON folders(parent);
    CREATE INDEX IF NOT EXISTS folders_root_size ON folders(root, size DESC);
    CREATE TABLE IF NOT EXISTS category_summary (
      root TEXT NOT NULL,
      category TEXT NOT NULL,
      size INTEGER NOT NULL DEFAULT 0,
      files INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(root, category)
    );
    CREATE TABLE IF NOT EXISTS summary_state (
      root TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'pending',
      pid INTEGER,
      updated_at TEXT NOT NULL,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      root TEXT NOT NULL,
      path TEXT NOT NULL,
      event TEXT NOT NULL,
      old_size INTEGER,
      new_size INTEGER,
      observed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS changes_root_id ON changes(root, id DESC);
    CREATE TABLE IF NOT EXISTS scan_errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      root TEXT NOT NULL,
      path TEXT NOT NULL,
      message TEXT NOT NULL,
      observed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS operations (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      source TEXT,
      destination TEXT,
      status TEXT NOT NULL,
      message TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT
    );
  `);
  return db;
}

async function writeJsonAtomic(target, value) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const data = JSON.stringify(value, null, 2);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fsp.writeFile(target, data, "utf8");
      return;
    } catch (error) {
      if (!/^(EPERM|EBUSY|EACCES)$/.test(String(error && error.code || "")) || attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}

async function readJson(target, fallback) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { return JSON.parse(await fsp.readFile(target, "utf8")); } catch {
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  return fallback;
}

function categoryForExtension(ext) {
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".svg", ".heic"].includes(ext)) return "Images";
  if ([".mp4", ".mov", ".mkv", ".avi", ".webm", ".wmv", ".m4v"].includes(ext)) return "Video";
  if ([".mp3", ".wav", ".flac", ".aac", ".m4a", ".ogg", ".opus"].includes(ext)) return "Audio";
  if ([".zip", ".7z", ".rar", ".tar", ".gz", ".bz2", ".xz", ".iso"].includes(ext)) return "Archives";
  if ([".pt", ".pth", ".safetensors", ".bin", ".gguf", ".onnx", ".ckpt"].includes(ext)) return "AI models";
  if ([".js", ".jsx", ".ts", ".tsx", ".py", ".rs", ".go", ".java", ".cs", ".cpp", ".c", ".h", ".json", ".yaml", ".yml", ".toml"].includes(ext)) return "Code";
  if ([".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".md", ".rtf"].includes(ext)) return "Documents";
  if ([".exe", ".msi", ".dll", ".sys", ".appx"].includes(ext)) return "Applications";
  return "Other";
}

function visibleName(name) {
  return !name.startsWith(".");
}

async function scanDrive(rootInput) {
  const root = normalizeAbsolute(rootInput);
  if (root !== path.win32.parse(root).root) throw new Error("Whole-drive scans must start at a drive root.");
  await fsp.mkdir(STATE_DIR, { recursive: true });
  let lock;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      lock = await fsp.open(LOCK_PATH, "wx");
      await lock.writeFile(JSON.stringify({ pid: process.pid, root, startedAt: nowIso() }));
      break;
    } catch {
      const previous = await readJson(LOCK_PATH, {});
      let alive = false;
      try { if (previous.pid) { process.kill(previous.pid, 0); alive = true; } } catch {}
      if (alive || attempt > 0) throw new Error("Another storage scan is already running.");
      await fsp.unlink(LOCK_PATH).catch(() => {});
    }
  }
  if (!lock) throw new Error("Could not acquire the storage scan lock.");

  const db = openDb();
  const scanId = crypto.randomUUID();
  const startedAt = nowIso();
  const progress = { state: "scanning", root, scanId, pid: process.pid, startedAt, updatedAt: startedAt, files: 0, folders: 0, bytes: 0, errors: 0, currentPath: root };
  const categories = new Map();
  const upsertEntry = db.prepare(`INSERT INTO entries(path, root, parent, name, ext, size, mtime_ms, created_ms, hidden, scan_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET root=excluded.root,parent=excluded.parent,name=excluded.name,ext=excluded.ext,size=excluded.size,mtime_ms=excluded.mtime_ms,created_ms=excluded.created_ms,hidden=excluded.hidden,scan_id=excluded.scan_id`);
  const upsertFolder = db.prepare(`INSERT INTO folders(path, root, parent, name, size, file_count, dir_count, mtime_ms, scan_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET root=excluded.root,parent=excluded.parent,name=excluded.name,size=excluded.size,file_count=excluded.file_count,dir_count=excluded.dir_count,mtime_ms=excluded.mtime_ms,scan_id=excluded.scan_id`);
  const insertError = db.prepare("INSERT INTO scan_errors(root,path,message,observed_at) VALUES (?,?,?,?)");
  const upsertRoot = db.prepare(`INSERT INTO roots(root,status,scan_id,last_error) VALUES (?, 'scanning', ?, NULL)
    ON CONFLICT(root) DO UPDATE SET status='scanning', scan_id=excluded.scan_id, last_error=NULL`);
  upsertRoot.run(root, scanId);
  db.prepare("DELETE FROM scan_errors WHERE root = ?").run(root);

  let lastStatusAt = 0;
  async function updateProgress(force = false) {
    const now = Date.now();
    if (!force && now - lastStatusAt < 350) return;
    lastStatusAt = now;
    progress.updatedAt = nowIso();
    await writeJsonAtomic(STATUS_PATH, progress);
  }

  async function walk(directory) {
    progress.currentPath = directory;
    progress.folders += 1;
    let totalSize = 0;
    let fileCount = 0;
    let dirCount = 0;
    let newest = 0;
    let handle;
    try {
      handle = await fsp.opendir(directory);
    } catch (error) {
      progress.errors += 1;
      insertError.run(root, directory, error instanceof Error ? error.message : String(error), nowIso());
      await updateProgress();
      return { totalSize, fileCount, dirCount, newest };
    }

    try {
      for await (const entry of handle) {
        if (SKIP_NAMES.has(entry.name.toLowerCase())) continue;
        const absolute = path.win32.join(directory, entry.name);
        if (!isInside(root, absolute)) continue;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          const child = await walk(absolute);
          totalSize += child.totalSize;
          fileCount += child.fileCount;
          dirCount += child.dirCount + 1;
          newest = Math.max(newest, child.newest);
          continue;
        }
        if (!entry.isFile()) continue;
        try {
          const stat = await fsp.stat(absolute);
          const size = Number(stat.size || 0);
          const ext = path.win32.extname(entry.name).toLowerCase();
          upsertEntry.run(absolute, root, directory, entry.name, ext, size, stat.mtimeMs || 0, stat.birthtimeMs || 0, visibleName(entry.name) ? 0 : 1, scanId);
          const category = categoryForExtension(ext);
          const categoryTotal = categories.get(category) || { size: 0, files: 0 };
          categoryTotal.size += size;
          categoryTotal.files += 1;
          categories.set(category, categoryTotal);
          totalSize += size;
          fileCount += 1;
          newest = Math.max(newest, stat.mtimeMs || 0);
          progress.files += 1;
          progress.bytes += size;
          if (progress.files % 250 === 0) await updateProgress();
        } catch (error) {
          progress.errors += 1;
          insertError.run(root, absolute, error instanceof Error ? error.message : String(error), nowIso());
        }
      }
    } catch (error) {
      progress.errors += 1;
      insertError.run(root, directory, error instanceof Error ? error.message : String(error), nowIso());
    }

    let directoryMtime = newest;
    try { directoryMtime = Math.max(directoryMtime, (await fsp.stat(directory)).mtimeMs || 0); } catch {}
    const parent = directory === root ? "" : path.win32.dirname(directory);
    const name = directory === root ? root : path.win32.basename(directory);
    upsertFolder.run(directory, root, parent, name, totalSize, fileCount, dirCount, directoryMtime, scanId);
    await updateProgress();
    return { totalSize, fileCount, dirCount, newest: directoryMtime };
  }

  try {
    await updateProgress(true);
    const totals = await walk(root);
    db.exec("BEGIN");
    db.prepare("DELETE FROM entries WHERE root = ? AND scan_id <> ?").run(root, scanId);
    db.prepare("DELETE FROM folders WHERE root = ? AND scan_id <> ?").run(root, scanId);
    db.prepare("DELETE FROM category_summary WHERE root = ?").run(root);
    const insertCategory = db.prepare("INSERT INTO category_summary(root,category,size,files) VALUES (?,?,?,?)");
    for (const [category, totals] of categories) insertCategory.run(root, category, totals.size, totals.files);
    db.prepare(`INSERT INTO summary_state(root,status,pid,updated_at,error) VALUES (?, 'ready', NULL, ?, NULL)
      ON CONFLICT(root) DO UPDATE SET status='ready',pid=NULL,updated_at=excluded.updated_at,error=NULL`).run(root, nowIso());
    db.prepare(`UPDATE roots SET scanned_at=?, file_count=?, dir_count=?, indexed_bytes=?, status='ready', dirty=0, last_error=NULL WHERE root=?`).run(nowIso(), totals.fileCount, totals.dirCount, totals.totalSize, root);
    db.exec("COMMIT");
    Object.assign(progress, { state: "complete", completedAt: nowIso(), currentPath: root, files: totals.fileCount, folders: totals.dirCount + 1, bytes: totals.totalSize });
    await updateProgress(true);
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    const message = error instanceof Error ? error.message : String(error);
    db.prepare("UPDATE roots SET status='error', last_error=? WHERE root=?").run(message, root);
    Object.assign(progress, { state: "error", error: message, completedAt: nowIso() });
    await updateProgress(true);
    throw error;
  } finally {
    db.close();
    await lock.close().catch(() => {});
    await fsp.unlink(LOCK_PATH).catch(() => {});
  }
}

async function summarizeDrive(rootInput) {
  const root = normalizeAbsolute(rootInput);
  if (root !== path.win32.parse(root).root) throw new Error("Storage summaries require a drive root.");
  const db = openDb();
  const setState = db.prepare(`INSERT INTO summary_state(root,status,pid,updated_at,error) VALUES (?,?,?,?,?)
    ON CONFLICT(root) DO UPDATE SET status=excluded.status,pid=excluded.pid,updated_at=excluded.updated_at,error=excluded.error`);
  setState.run(root, "running", process.pid, nowIso(), null);
  try {
    const extensionRows = db.prepare("SELECT ext,SUM(size) AS size,COUNT(*) AS files FROM entries WHERE root=? GROUP BY ext").all(root);
    const categories = new Map();
    for (const row of extensionRows) {
      const category = categoryForExtension(String(row.ext || ""));
      const current = categories.get(category) || { size: 0, files: 0 };
      current.size += Number(row.size || 0);
      current.files += Number(row.files || 0);
      categories.set(category, current);
    }
    db.exec("BEGIN");
    db.prepare("DELETE FROM category_summary WHERE root=?").run(root);
    const insert = db.prepare("INSERT INTO category_summary(root,category,size,files) VALUES (?,?,?,?)");
    for (const [category, totals] of categories) insert.run(root, category, totals.size, totals.files);
    setState.run(root, "ready", null, nowIso(), null);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    setState.run(root, "error", null, nowIso(), error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    db.close();
  }
}

function updateWatcherRecord(root, patch) {
  return readJson(WATCHERS_PATH, {}).then((records) => writeJsonAtomic(WATCHERS_PATH, { ...records, [root]: { ...(records[root] || {}), ...patch } }));
}

async function watchDrive(rootInput) {
  const root = normalizeAbsolute(rootInput);
  const db = openDb();
  await updateWatcherRecord(root, { pid: process.pid, root, state: "watching", startedAt: nowIso(), updatedAt: nowIso() });
  db.prepare("UPDATE roots SET watching=1 WHERE root=?").run(root);
  const insertChange = db.prepare("INSERT INTO changes(root,path,event,old_size,new_size,observed_at) VALUES (?,?,?,?,?,?)");
  const knownFile = db.prepare("SELECT size FROM entries WHERE path=?");
  const upsertEntry = db.prepare(`INSERT INTO entries(path,root,parent,name,ext,size,mtime_ms,created_ms,hidden,scan_id)
    VALUES (?,?,?,?,?,?,?,?,?,COALESCE((SELECT scan_id FROM roots WHERE root=?),'watch'))
    ON CONFLICT(path) DO UPDATE SET parent=excluded.parent,name=excluded.name,ext=excluded.ext,size=excluded.size,mtime_ms=excluded.mtime_ms,created_ms=excluded.created_ms`);
  const deleteEntry = db.prepare("DELETE FROM entries WHERE path=?");
  const markDirty = db.prepare("UPDATE roots SET dirty=1 WHERE root=?");
  const pending = new Map();
  let flushTimer = null;

  async function flush() {
    flushTimer = null;
    const items = [...pending.values()];
    pending.clear();
    for (const item of items) {
      const absolute = normalizeAbsolute(item.path);
      if (!isInside(root, absolute)) continue;
      const previous = knownFile.get(absolute);
      try {
        const stat = await fsp.stat(absolute);
        if (stat.isFile()) {
          const nextSize = Number(stat.size || 0);
          upsertEntry.run(absolute, root, path.win32.dirname(absolute), path.win32.basename(absolute), path.win32.extname(absolute).toLowerCase(), nextSize, stat.mtimeMs || 0, stat.birthtimeMs || 0, 0, root);
          insertChange.run(root, absolute, previous ? "modified" : "created", previous ? Number(previous.size) : null, nextSize, nowIso());
        } else {
          markDirty.run(root);
          insertChange.run(root, absolute, item.event || "directory", null, null, nowIso());
        }
      } catch {
        if (previous) {
          deleteEntry.run(absolute);
          insertChange.run(root, absolute, "deleted", Number(previous.size), null, nowIso());
        } else {
          markDirty.run(root);
          insertChange.run(root, absolute, item.event || "changed", null, null, nowIso());
        }
      }
    }
    db.prepare("DELETE FROM changes WHERE id NOT IN (SELECT id FROM changes ORDER BY id DESC LIMIT 5000)").run();
    await updateWatcherRecord(root, { pid: process.pid, state: "watching", updatedAt: nowIso(), lastBatch: items.length });
  }

  let watcher;
  try {
    watcher = fs.watch(root, { recursive: true }, (event, filename) => {
      if (!filename) return;
      const absolute = path.win32.join(root, filename.toString());
      pending.set(absolute.toLowerCase(), { path: absolute, event });
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = setTimeout(() => void flush(), 700);
    });
  } catch (error) {
    db.prepare("UPDATE roots SET watching=0 WHERE root=?").run(root);
    db.close();
    await updateWatcherRecord(root, { state: "error", error: error instanceof Error ? error.message : String(error), updatedAt: nowIso() });
    throw error;
  }

  const stop = async () => {
    watcher.close();
    if (flushTimer) clearTimeout(flushTimer);
    await flush().catch(() => {});
    db.prepare("UPDATE roots SET watching=0 WHERE root=?").run(root);
    db.close();
    await updateWatcherRecord(root, { state: "stopped", stoppedAt: nowIso(), updatedAt: nowIso() });
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());
  await new Promise(() => {});
}

async function moveItem(payloadText) {
  const payload = JSON.parse(Buffer.from(payloadText, "base64url").toString("utf8"));
  const source = assertManageable(payload.source);
  const destinationDirectory = assertDestination(payload.destinationDirectory);
  if (isInside(source, destinationDirectory)) throw new Error("A folder cannot be moved inside itself.");
  const sourceStat = await fsp.stat(source);
  const originalName = path.win32.basename(source);
  let destination = path.win32.join(destinationDirectory, originalName);
  const operationId = String(payload.operationId || crypto.randomUUID());
  const conflict = payload.conflict === "rename" ? "rename" : "error";
  const db = openDb();
  db.prepare("INSERT OR REPLACE INTO operations(id,kind,source,destination,status,message,started_at,completed_at) VALUES (?,?,?,?,?,?,?,NULL)").run(operationId, "move", source, destination, "running", null, nowIso());
  try {
    await fsp.mkdir(destinationDirectory, { recursive: true });
    try {
      await fsp.access(destination);
      if (conflict !== "rename") throw new Error(`Destination already exists: ${destination}`);
      const parsed = path.win32.parse(originalName);
      for (let i = 2; ; i += 1) {
        const candidate = path.win32.join(destinationDirectory, `${parsed.name} (${i})${parsed.ext}`);
        try { await fsp.access(candidate); } catch { destination = candidate; break; }
      }
    } catch (error) {
      if (error instanceof Error && !error.message.includes("ENOENT") && !error.message.includes("no such file") && error.message.startsWith("Destination")) throw error;
    }

    const sameVolume = rootOf(source) === rootOf(destination);
    if (sameVolume) {
      await fsp.rename(source, destination);
    } else {
      await fsp.cp(source, destination, { recursive: sourceStat.isDirectory(), errorOnExist: true, force: false, preserveTimestamps: true });
      await fsp.rm(source, { recursive: sourceStat.isDirectory(), force: false });
    }
    db.prepare("UPDATE operations SET destination=?, status='complete', message=?, completed_at=? WHERE id=?").run(destination, sameVolume ? "Moved" : "Copied, verified, then removed source", nowIso(), operationId);
    db.prepare("UPDATE roots SET dirty=1 WHERE root IN (?,?)").run(rootOf(source), rootOf(destination));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    db.prepare("UPDATE operations SET status='error', message=?, completed_at=? WHERE id=?").run(message, nowIso(), operationId);
    throw error;
  } finally {
    db.close();
  }
}

async function main() {
  const [command, argument] = process.argv.slice(2);
  if (command === "scan") return scanDrive(argument);
  if (command === "watch") return watchDrive(argument);
  if (command === "move") return moveItem(argument);
  if (command === "summarize") return summarizeDrive(argument);
  throw new Error(`Unknown storage worker command: ${command || "(none)"}`);
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
