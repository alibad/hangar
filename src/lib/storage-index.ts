import { DatabaseSync } from "node:sqlite";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

// Renamed from betenshi-console to Hangar: a machine that already has an index
// under the old directory keeps it rather than silently starting an empty one.
const STORAGE_ROOT = process.env.LOCALAPPDATA || (process.platform === "darwin"
  ? path.join(os.homedir(), "Library", "Application Support")
  : process.cwd());
const LEGACY_STORAGE = path.join(STORAGE_ROOT, "betenshi", "storage");
export const STORAGE_STATE_DIR = process.env.HANGAR_STORAGE_STATE_DIR || (fs.existsSync(LEGACY_STORAGE)
  ? LEGACY_STORAGE
  : path.join(STORAGE_ROOT, "Hangar", "storage"));
export const STORAGE_DB_PATH =
  process.env.HANGAR_STORAGE_DB ||
  process.env.BETENSHI_STORAGE_DB ||
  path.join(STORAGE_STATE_DIR, "storage-index.sqlite");
const STATUS_PATH = path.join(STORAGE_STATE_DIR, "scan-status.json");
const LOCK_PATH = path.join(STORAGE_STATE_DIR, "scan.lock");
const WATCHERS_PATH = path.join(STORAGE_STATE_DIR, "watchers.json");
const WORKER_PATH = path.join(process.cwd(), "scripts", "storage-indexer.cjs");
const LOG_PATH = path.join(STORAGE_STATE_DIR, "indexer.log");

export type StorageDrive = {
  root: string;
  label: string;
  kind: "fixed" | "removable" | "network" | "optical" | "other";
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  indexedBytes: number;
  fileCount: number;
  dirCount: number;
  scannedAt: string | null;
  status: "never" | "scanning" | "ready" | "error";
  dirty: boolean;
  watching: boolean;
  lastError: string | null;
};

export type StorageItem = {
  path: string;
  root: string;
  parent: string;
  name: string;
  kind: "file" | "folder";
  extension: string;
  size: number;
  fileCount: number;
  dirCount: number;
  modifiedAt: number;
};

export type ScanStatus = {
  state: "idle" | "scanning" | "complete" | "error";
  root?: string;
  pid?: number;
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
  files?: number;
  folders?: number;
  bytes?: number;
  errors?: number;
  currentPath?: string;
  error?: string;
};

type DriveRow = {
  DeviceID: string;
  VolumeName?: string | null;
  DriveType: number;
  Size?: number | string | null;
  FreeSpace?: number | string | null;
  ProviderName?: string | null;
};

type DiscoveredDrive = {
  root: string;
  label: string;
  kind: StorageDrive["kind"];
  totalBytes: number;
  freeBytes: number;
};

type RootRow = {
  root: string;
  indexed_bytes: number;
  file_count: number;
  dir_count: number;
  scanned_at: string | null;
  status: StorageDrive["status"];
  dirty: number;
  watching: number;
  last_error: string | null;
};

const CATEGORY_EXTENSIONS: Record<string, string[]> = {
  Images: [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".svg", ".heic"],
  Video: [".mp4", ".mov", ".mkv", ".avi", ".webm", ".wmv", ".m4v"],
  Audio: [".mp3", ".wav", ".flac", ".aac", ".m4a", ".ogg", ".opus"],
  Archives: [".zip", ".7z", ".rar", ".tar", ".gz", ".bz2", ".xz", ".iso"],
  "AI models": [".pt", ".pth", ".safetensors", ".bin", ".gguf", ".onnx", ".ckpt"],
  Code: [".js", ".jsx", ".ts", ".tsx", ".py", ".rs", ".go", ".java", ".cs", ".cpp", ".c", ".h", ".json", ".yaml", ".yml", ".toml"],
  Documents: [".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".md", ".rtf"],
  Applications: [".exe", ".msi", ".dll", ".sys", ".appx", ".app", ".dmg", ".pkg"],
};
const KNOWN_CATEGORY_EXTENSIONS = Object.values(CATEGORY_EXTENSIONS).flat();

function openDb() {
  fs.mkdirSync(STORAGE_STATE_DIR, { recursive: true });
  const db = new DatabaseSync(STORAGE_DB_PATH);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS roots (root TEXT PRIMARY KEY,label TEXT,total_bytes INTEGER DEFAULT 0,free_bytes INTEGER DEFAULT 0,scanned_at TEXT,scan_id TEXT,file_count INTEGER DEFAULT 0,dir_count INTEGER DEFAULT 0,indexed_bytes INTEGER DEFAULT 0,status TEXT DEFAULT 'never',dirty INTEGER DEFAULT 0,watching INTEGER DEFAULT 0,last_error TEXT);
    CREATE TABLE IF NOT EXISTS entries (path TEXT PRIMARY KEY,root TEXT NOT NULL,parent TEXT NOT NULL,name TEXT NOT NULL,ext TEXT NOT NULL DEFAULT '',size INTEGER NOT NULL DEFAULT 0,mtime_ms INTEGER NOT NULL DEFAULT 0,created_ms INTEGER NOT NULL DEFAULT 0,hidden INTEGER NOT NULL DEFAULT 0,scan_id TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS entries_root_size ON entries(root,size DESC);
    CREATE INDEX IF NOT EXISTS entries_parent ON entries(parent);
    CREATE INDEX IF NOT EXISTS entries_name ON entries(name);
    CREATE TABLE IF NOT EXISTS folders (path TEXT PRIMARY KEY,root TEXT NOT NULL,parent TEXT NOT NULL,name TEXT NOT NULL,size INTEGER NOT NULL DEFAULT 0,file_count INTEGER NOT NULL DEFAULT 0,dir_count INTEGER NOT NULL DEFAULT 0,mtime_ms INTEGER NOT NULL DEFAULT 0,scan_id TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS folders_parent ON folders(parent);
    CREATE INDEX IF NOT EXISTS folders_root_size ON folders(root,size DESC);
    CREATE TABLE IF NOT EXISTS category_summary (root TEXT NOT NULL,category TEXT NOT NULL,size INTEGER NOT NULL DEFAULT 0,files INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(root,category));
    CREATE TABLE IF NOT EXISTS summary_state (root TEXT PRIMARY KEY,status TEXT NOT NULL DEFAULT 'pending',pid INTEGER,updated_at TEXT NOT NULL,error TEXT);
    CREATE TABLE IF NOT EXISTS changes (id INTEGER PRIMARY KEY AUTOINCREMENT,root TEXT NOT NULL,path TEXT NOT NULL,event TEXT NOT NULL,old_size INTEGER,new_size INTEGER,observed_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS scan_errors (id INTEGER PRIMARY KEY AUTOINCREMENT,root TEXT NOT NULL,path TEXT NOT NULL,message TEXT NOT NULL,observed_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY,kind TEXT NOT NULL,source TEXT,destination TEXT,status TEXT NOT NULL,message TEXT,started_at TEXT NOT NULL,completed_at TEXT);
  `);
  return db;
}

function execFileText(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

function driveKind(type: number): StorageDrive["kind"] {
  if (type === 2) return "removable";
  if (type === 3) return "fixed";
  if (type === 4) return "network";
  if (type === 5) return "optical";
  return "other";
}

const storagePath = process.platform === "win32" ? path.win32 : path.posix;

function storagePathKey(value: string) {
  const normalized = storagePath.normalize(value);
  return process.platform === "win32" ? normalized.toUpperCase() : normalized;
}

function decodeMountPath(value: string) {
  return value
    .replace(/\\040/g, " ")
    .replace(/\\011/g, "\t")
    .replace(/\\134/g, "\\");
}

function parseDarwinMounts(raw: string) {
  return raw.split("\n").flatMap((line) => {
    const match = /^.+ on (.+) \(([^,()]+)(?:, (.*))?\)$/.exec(line.trim());
    if (!match) return [];
    return [{
      root: decodeMountPath(match[1]),
      fsType: match[2],
      options: new Set((match[3] || "").split(/,\s*/).filter(Boolean)),
    }];
  });
}

async function discoverDarwinDrives(): Promise<DiscoveredDrive[]> {
  const raw = await execFileText("/sbin/mount", []);
  const mounts = parseDarwinMounts(raw).filter((mount) =>
    mount.root === "/" ||
    (mount.root.startsWith("/Volumes/") && !mount.options.has("nobrowse")),
  );
  const seen = new Set<string>();
  const rows: DiscoveredDrive[] = [];
  const networkTypes = new Set(["afpfs", "nfs", "smbfs", "webdav"]);
  for (const mount of mounts) {
    const root = storagePath.normalize(mount.root);
    if (seen.has(root)) continue;
    seen.add(root);
    const stats = await fsp.statfs(root);
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    if (!Number.isFinite(totalBytes) || totalBytes <= 0) continue;
    rows.push({
      root,
      label: root === "/" ? "Macintosh HD" : storagePath.basename(root),
      kind: networkTypes.has(mount.fsType) ? "network" : root === "/" ? "fixed" : "removable",
      totalBytes,
      freeBytes: Math.max(0, freeBytes),
    });
  }
  return rows;
}

async function discoverWindowsDrives(): Promise<DiscoveredDrive[]> {
  const script = "$ErrorActionPreference='Stop'; Get-CimInstance Win32_LogicalDisk | Where-Object {$_.DriveType -in 2,3,4} | Select-Object DeviceID,VolumeName,DriveType,Size,FreeSpace,ProviderName | ConvertTo-Json -Compress";
  const raw = await execFileText("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
  const parsed = JSON.parse(raw || "[]") as DriveRow | DriveRow[];
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows
    .filter((row) => row.DeviceID && Number(row.Size || 0) > 0)
    .map((row) => {
      const root = `${row.DeviceID.toUpperCase()}\\`;
      const label = String(row.VolumeName || row.DeviceID);
      return {
        root,
        label,
        kind: row.ProviderName || /google drive/i.test(label) ? "network" : driveKind(Number(row.DriveType)),
        totalBytes: Number(row.Size || 0),
        freeBytes: Number(row.FreeSpace || 0),
      };
    });
}

/**
 * Thrown when a storage operation cannot run on this platform at all, as
 * opposed to failing. The distinction matters to the caller: one is a bug to
 * report, the other is a fact about the machine.
 */
export class StorageUnsupportedError extends Error {
  readonly code = "unsupported-platform";
}

export async function discoverDrives(): Promise<StorageDrive[]> {
  if (process.platform !== "win32" && process.platform !== "darwin") {
    throw new StorageUnsupportedError(
      `Storage Manager supports Windows and macOS hosts. This host is ${process.platform}.`,
    );
  }
  const rows = process.platform === "win32"
    ? await discoverWindowsDrives()
    : await discoverDarwinDrives();
  const db = openDb();
  try {
    const rootRows = db.prepare("SELECT root,indexed_bytes,file_count,dir_count,scanned_at,status,dirty,watching,last_error FROM roots").all() as unknown as RootRow[];
    const indexed = new Map(rootRows.map((row) => [storagePathKey(row.root), row]));
    const upsert = db.prepare(`INSERT INTO roots(root,label,total_bytes,free_bytes) VALUES (?,?,?,?)
      ON CONFLICT(root) DO UPDATE SET label=excluded.label,total_bytes=excluded.total_bytes,free_bytes=excluded.free_bytes`);
    return rows.map((row) => {
      const cached = indexed.get(storagePathKey(row.root));
      upsert.run(row.root, row.label, row.totalBytes, row.freeBytes);
      return {
        root: row.root,
        label: row.label,
        kind: row.kind,
        totalBytes: row.totalBytes,
        freeBytes: row.freeBytes,
        usedBytes: Math.max(0, row.totalBytes - row.freeBytes),
        indexedBytes: Number(cached?.indexed_bytes || 0),
        fileCount: Number(cached?.file_count || 0),
        dirCount: Number(cached?.dir_count || 0),
        scannedAt: cached?.scanned_at || null,
        status: cached?.status || "never",
        dirty: Boolean(cached?.dirty && cached?.scanned_at),
        watching: Boolean(cached?.watching),
        lastError: cached?.last_error || null,
      } satisfies StorageDrive;
    });
  } finally {
    db.close();
  }
}

async function readJson<T>(target: string, fallback: T): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { return JSON.parse(await fsp.readFile(target, "utf8")) as T; } catch {
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  return fallback;
}

async function writeJsonAtomic(target: string, value: unknown) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const data = JSON.stringify(value, null, 2);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fsp.writeFile(target, data, "utf8");
      return;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (!/^(EPERM|EBUSY|EACCES)$/.test(code) || attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}

async function updateWatcherRecord(root: string, patch: Record<string, unknown>) {
  const records = await readJson<Record<string, Record<string, unknown>>>(WATCHERS_PATH, {});
  await writeJsonAtomic(WATCHERS_PATH, { ...records, [root]: { ...(records[root] || {}), ...patch } });
}

function processAlive(pid: number | undefined) {
  if (!pid || !Number.isInteger(pid)) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function getScanStatus(): Promise<ScanStatus> {
  const status = await readJson<ScanStatus>(STATUS_PATH, { state: "idle" });
  if (status.state === "scanning" && !processAlive(status.pid)) {
    // The worker writes the final status immediately before exiting. A poll can
    // read the previous progress snapshot, then observe the process exit, even
    // though the completed snapshot is already replacing it. Re-read before
    // declaring a crash, and use the committed root row as the final authority.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const latest = await readJson<ScanStatus>(STATUS_PATH, status);
    if (latest.state !== "scanning") return latest;
    const database = openDb();
    try {
      const root = database.prepare("SELECT status,scanned_at,last_error FROM roots WHERE root=?").get(status.root || "") as { status?: string; scanned_at?: string | null; last_error?: string | null } | undefined;
      if (root?.status === "ready") {
        const completed = { ...latest, state: "complete" as const, completedAt: root.scanned_at || new Date().toISOString(), currentPath: status.root };
        await writeJsonAtomic(STATUS_PATH, completed).catch(() => {});
        return completed;
      }
      if (root?.status === "error") {
        const failed = { ...latest, state: "error" as const, error: root.last_error || "Indexer process stopped unexpectedly.", completedAt: new Date().toISOString() };
        await writeJsonAtomic(STATUS_PATH, failed).catch(() => {});
        return failed;
      }
    } finally {
      database.close();
    }
    const recovered = { ...status, state: "error" as const, error: "Indexer process stopped unexpectedly.", completedAt: new Date().toISOString() };
    await writeJsonAtomic(STATUS_PATH, recovered).catch(() => {});
    await fsp.unlink(LOCK_PATH).catch(() => {});
    const db = openDb();
    try {
      db.prepare("UPDATE roots SET status='error',last_error=? WHERE root=?").run(recovered.error, status.root || "");
    } finally {
      db.close();
    }
    return recovered;
  }
  return status;
}

export async function getWatcherStates() {
  const records = await readJson<Record<string, { pid?: number; state?: string; desired?: boolean; updatedAt?: string; startedAt?: string }>>(WATCHERS_PATH, {});
  return Object.fromEntries(Object.entries(records).map(([root, value]) => [root, { ...value, alive: processAlive(value.pid) }]));
}

function spawnWorker(command: "scan" | "watch" | "move" | "summarize", argument: string) {
  fs.mkdirSync(STORAGE_STATE_DIR, { recursive: true });
  const logFd = fs.openSync(LOG_PATH, "a");
  const child = spawn(process.execPath, [WORKER_PATH, command, argument], {
    cwd: process.cwd(),
    detached: true,
    windowsHide: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, HANGAR_STORAGE_DB: STORAGE_DB_PATH },
  });
  child.unref();
  fs.closeSync(logFd);
  return child.pid;
}

export async function startScan(root: string) {
  const normalized = normalizeIndexedPath(root);
  const allowed = (await discoverDrives()).some((drive) => storagePathKey(drive.root) === storagePathKey(normalized));
  if (!allowed) throw new Error("Unknown or unavailable drive root.");
  const status = await getScanStatus();
  if (status.state === "scanning") throw new Error(`A scan is already running on ${status.root}.`);
  return { pid: spawnWorker("scan", normalized) };
}

export async function stopScan() {
  const status = await getScanStatus();
  if (status.state !== "scanning" || !status.pid) return { stopped: false };
  try { process.kill(status.pid, "SIGTERM"); } catch {}
  const db = openDb();
  try {
    db.prepare("UPDATE roots SET status=CASE WHEN scanned_at IS NULL THEN 'never' ELSE 'ready' END,last_error='Scan cancelled' WHERE root=?").run(status.root || "");
  } finally {
    db.close();
  }
  await fsp.unlink(LOCK_PATH).catch(() => {});
  await fsp.writeFile(STATUS_PATH, JSON.stringify({ ...status, state: "error", error: "Scan cancelled", completedAt: new Date().toISOString() }, null, 2), "utf8");
  return { stopped: true };
}

export async function setWatching(root: string, enabled: boolean) {
  const normalized = normalizeIndexedPath(root);
  const allowed = (await discoverDrives()).some((drive) => storagePathKey(drive.root) === storagePathKey(normalized));
  if (!allowed) throw new Error("Unknown or unavailable drive root.");
  if (enabled) {
    const db = openDb();
    try {
      const indexed = db.prepare("SELECT scanned_at FROM roots WHERE root=?").get(normalized) as { scanned_at?: string | null } | undefined;
      if (!indexed?.scanned_at) throw new Error("Scan this drive before enabling change watching.");
    } finally {
      db.close();
    }
  }
  const records = await getWatcherStates();
  const existing = records[normalized];
  if (enabled) {
    if (existing?.alive) return { pid: existing.pid, unchanged: true };
    const pid = spawnWorker("watch", normalized);
    await updateWatcherRecord(normalized, { desired: true, pid, state: "starting", updatedAt: new Date().toISOString() });
    return { pid };
  }
  if (existing?.alive && existing.pid) process.kill(existing.pid, "SIGTERM");
  await updateWatcherRecord(normalized, { desired: false, state: "stopping", updatedAt: new Date().toISOString() });
  const db = openDb();
  try { db.prepare("UPDATE roots SET watching=0 WHERE root=?").run(normalized); } finally { db.close(); }
  return { stopped: Boolean(existing?.alive) };
}

function normalizeIndexedPath(input: string) {
  if (!storagePath.isAbsolute(input)) throw new Error("An absolute storage path is required.");
  return storagePath.normalize(input);
}

export async function getStorageOverview() {
  const [drives, scan, initialWatchers] = await Promise.all([discoverDrives(), getScanStatus(), getWatcherStates()]);
  let watchers = initialWatchers;
  for (const [root, watcher] of Object.entries(initialWatchers)) {
    const drive = drives.find((candidate) => candidate.root === root);
    if (!watcher.desired || watcher.alive || !drive?.scannedAt) continue;
    const pid = spawnWorker("watch", root);
    await updateWatcherRecord(root, { pid, state: "starting", updatedAt: new Date().toISOString() });
  }
  if (Object.values(initialWatchers).some((watcher) => watcher.desired && !watcher.alive)) watchers = await getWatcherStates();
  const db = openDb();
  try {
    const folderQuery = db.prepare("SELECT path,root,parent,name,size,file_count,dir_count,mtime_ms FROM folders WHERE root=? AND path<>root ORDER BY size DESC LIMIT 24");
    const fileQuery = db.prepare("SELECT path,root,parent,name,ext,size,mtime_ms FROM entries WHERE root=? ORDER BY size DESC LIMIT 40");
    const topFolders = drives.flatMap((drive) => folderQuery.all(drive.root));
    const largestFiles = drives.flatMap((drive) => fileQuery.all(drive.root));
    const recentChanges = db.prepare("SELECT id,root,path,event,old_size,new_size,observed_at FROM changes ORDER BY id DESC LIMIT 80").all();
    const operations = db.prepare("SELECT id,kind,source,destination,status,message,started_at,completed_at FROM operations ORDER BY started_at DESC LIMIT 20").all();
    const categoryRows = db.prepare("SELECT root,category,size,files FROM category_summary ORDER BY root,size DESC").all() as Array<{ root: string; category: string; size: number; files: number }>;
    const summaryRows = db.prepare("SELECT root,status,pid,updated_at,error FROM summary_state").all() as unknown as Array<{ root: string; status: string; pid: number | null; updated_at: string; error: string | null }>;
    const summaries = new Map(summaryRows.map((row) => [row.root, row]));
    const summarizedRoots = new Set(categoryRows.map((row) => row.root));
    const saveSummaryState = db.prepare(`INSERT INTO summary_state(root,status,pid,updated_at,error) VALUES (?, 'starting', ?, ?, NULL)
      ON CONFLICT(root) DO UPDATE SET status='starting',pid=excluded.pid,updated_at=excluded.updated_at,error=NULL`);
    for (const drive of drives) {
      if (!drive.scannedAt || summarizedRoots.has(drive.root) || summaries.get(drive.root)?.status === "ready") continue;
      const existing = summaries.get(drive.root);
      if (existing && ["starting", "running"].includes(existing.status) && processAlive(existing.pid || undefined)) continue;
      if (existing?.status === "error") continue;
      const pid = spawnWorker("summarize", drive.root);
      const state = { root: drive.root, status: "starting", pid: pid || null, updated_at: new Date().toISOString(), error: null };
      saveSummaryState.run(drive.root, pid || null, state.updated_at);
      summaries.set(drive.root, state);
    }
    const errorRows = db.prepare("SELECT root,COUNT(*) AS count FROM scan_errors GROUP BY root").all();
    return { drives, scan, watchers, topFolders, largestFiles, recentChanges, operations, categories: categoryRows, summaries: Object.fromEntries(summaries), duplicateCandidates: [], scanErrors: errorRows };
  } finally {
    db.close();
  }
}

export async function getDuplicateCandidates(root?: string) {
  const db = openDb();
  try {
    const normalizedRoot = root ? normalizeIndexedPath(root) : undefined;
    const rootClause = normalizedRoot ? " AND root=?" : "";
    const query = db.prepare(`SELECT size,COUNT(*) AS files,GROUP_CONCAT(path, char(10)) AS paths
      FROM entries WHERE size >= 10485760${rootClause}
      GROUP BY size HAVING COUNT(*) > 1 ORDER BY size * COUNT(*) DESC LIMIT 20`);
    return normalizedRoot ? query.all(normalizedRoot) : query.all();
  } finally {
    db.close();
  }
}

export async function getCategoryFiles(root: string, category: string) {
  const normalizedRoot = normalizeIndexedPath(root);
  if (![...Object.keys(CATEGORY_EXTENSIONS), "Other"].includes(category)) throw new Error("Unknown storage category.");
  const extensions = category === "Other" ? KNOWN_CATEGORY_EXTENSIONS : CATEGORY_EXTENSIONS[category];
  const placeholders = extensions.map(() => "?").join(",");
  const operator = category === "Other" ? "NOT IN" : "IN";
  const db = openDb();
  try {
    const rows = db.prepare(`SELECT path,root,parent,name,ext,size,mtime_ms FROM entries
      WHERE root=? AND ext ${operator} (${placeholders}) ORDER BY size DESC LIMIT 100`).all(normalizedRoot, ...extensions) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      path: String(row.path), root: String(row.root), parent: String(row.parent), name: String(row.name),
      kind: "file" as const, extension: String(row.ext || ""), size: Number(row.size), fileCount: 1, dirCount: 0, modifiedAt: Number(row.mtime_ms),
    }));
  } finally {
    db.close();
  }
}

export async function browseStorage(input: string): Promise<{ path: string; parent: string | null; items: StorageItem[] }> {
  const target = normalizeIndexedPath(input);
  const roots = (await discoverDrives()).map((drive) => drive.root).sort((a, b) => b.length - a.length);
  const root = roots.find((candidate) => {
    const relative = storagePath.relative(candidate, target);
    return relative === "" || (!relative.startsWith(`..${storagePath.sep}`) && relative !== "..");
  }) || storagePath.parse(target).root;
  const db = openDb();
  try {
    const folders = db.prepare("SELECT path,root,parent,name,size,file_count,dir_count,mtime_ms FROM folders WHERE parent=? ORDER BY size DESC,name COLLATE NOCASE").all(target) as Array<Record<string, unknown>>;
    const files = db.prepare("SELECT path,root,parent,name,ext,size,mtime_ms FROM entries WHERE parent=? ORDER BY size DESC,name COLLATE NOCASE LIMIT 2000").all(target) as Array<Record<string, unknown>>;
    const items: StorageItem[] = [
      ...folders.map((row) => ({ path: String(row.path), root: String(row.root), parent: String(row.parent), name: String(row.name), kind: "folder" as const, extension: "", size: Number(row.size), fileCount: Number(row.file_count), dirCount: Number(row.dir_count), modifiedAt: Number(row.mtime_ms) })),
      ...files.map((row) => ({ path: String(row.path), root: String(row.root), parent: String(row.parent), name: String(row.name), kind: "file" as const, extension: String(row.ext || ""), size: Number(row.size), fileCount: 1, dirCount: 0, modifiedAt: Number(row.mtime_ms) })),
    ];
    return { path: target, parent: target === root ? null : storagePath.dirname(target), items };
  } finally {
    db.close();
  }
}

export async function searchStorage(query: string, root?: string) {
  const needle = query.trim();
  if (needle.length < 2) return [];
  const db = openDb();
  try {
    const like = `%${needle.replace(/[\\%_]/g, "\\$&")}%`;
    const rootClause = root ? " AND root=?" : "";
    const params = root ? [like, normalizeIndexedPath(root)] : [like];
    const folders = db.prepare(`SELECT path,root,parent,name,size,file_count,dir_count,mtime_ms FROM folders WHERE name LIKE ? ESCAPE '\\'${rootClause} ORDER BY size DESC LIMIT 100`).all(...params) as Array<Record<string, unknown>>;
    const files = db.prepare(`SELECT path,root,parent,name,ext,size,mtime_ms FROM entries WHERE name LIKE ? ESCAPE '\\'${rootClause} ORDER BY size DESC LIMIT 200`).all(...params) as Array<Record<string, unknown>>;
    return [
      ...folders.map((row) => ({ path: String(row.path), root: String(row.root), parent: String(row.parent), name: String(row.name), kind: "folder", extension: "", size: Number(row.size), fileCount: Number(row.file_count), dirCount: Number(row.dir_count), modifiedAt: Number(row.mtime_ms) })),
      ...files.map((row) => ({ path: String(row.path), root: String(row.root), parent: String(row.parent), name: String(row.name), kind: "file", extension: String(row.ext || ""), size: Number(row.size), fileCount: 1, dirCount: 0, modifiedAt: Number(row.mtime_ms) })),
    ].sort((a, b) => b.size - a.size).slice(0, 200);
  } finally {
    db.close();
  }
}

export async function revealStoragePath(input: string) {
  const target = normalizeIndexedPath(input);
  const stats = await fsp.stat(target);
  if (process.platform === "win32") {
    const args = stats.isDirectory() ? [target] : ["/select,", target];
    execFile("explorer.exe", args, { windowsHide: false }, () => {});
  } else if (process.platform === "darwin") {
    execFile("/usr/bin/open", stats.isDirectory() ? [target] : ["-R", target], () => {});
  } else {
    throw new StorageUnsupportedError(`Reveal is not supported on ${process.platform}.`);
  }
  return { path: target, selected: !stats.isDirectory() };
}

export async function startMove(source: string, destinationDirectory: string, conflict: "error" | "rename") {
  const operationId = crypto.randomUUID();
  const payload = Buffer.from(JSON.stringify({ operationId, source: normalizeIndexedPath(source), destinationDirectory: normalizeIndexedPath(destinationDirectory), conflict }), "utf8").toString("base64url");
  return { operationId, pid: spawnWorker("move", payload) };
}
