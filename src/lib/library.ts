// The Library: one index of every video, AI-made file and dataset on this
// machine, so they can be browsed in one place.
//
// It reads and never writes the media. The index is its own DuckDB file
// (library.duckdb beside hangar.db): a scan writes thousands of rows, and on
// the console's shared connection that would make every other route's
// statement fail with "transaction within a transaction" while it ran.
//
// A scan walks the configured folders (config/library.local.json, plus
// Hangar's own studio outputs wherever their settings point). A file it has
// seen with the same size and time keeps the prompt read last time, so only
// new or changed files have their sidecars read again.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR, getDb, openDatabase, type Db } from "@/lib/db";
import { outputDir } from "@/lib/save-image";
import { archiveDir } from "@/lib/archive";
import { musicDir } from "@/lib/music-store";
import { audioDir } from "@/lib/audio-store";
import {
  COLLECTION_MIN, SHELVES, extOf, factionFor, isInside, kindOf, normPath, pickItems, pngText, projectName,
  promptFromComfy, promptFromSidecar, readReview, reviewStatus, spread, stemOf, studioFor, yamlActors,
  type MediaKind, type ReviewMap, type ReviewStatus, type Shelf, type StudioDirs,
} from "@/lib/library-classify";

export type { MediaKind, Shelf } from "@/lib/library-classify";

// ── configuration ──────────────────────────────────────────────────────────

export type LibraryRoot = { shelf: Shelf; path: string; project?: string; group?: string };
export type LibraryConfig = {
  cacheDir: string;
  rtsaiArt: string | null;
  rtsaiMod: string | null;
  rtsaiDrafts: string | null;
  roots: LibraryRoot[];
  projectRepos: Record<string, string[]>;
};

const CONFIG_FILE = process.env.HANGAR_LIBRARY_CONFIG || path.join(process.cwd(), "config", "library.local.json");
const SHELF_IDS = new Set<string>(SHELVES.map((s) => s.id));

function expand(p: unknown): string {
  return typeof p === "string" ? p.replace(/\$\{(\w+)\}/g, (_, name: string) => process.env[name] ?? "") : "";
}

export function studioDirs(): StudioDirs {
  return { gallery: outputDir(), archive: archiveDir(), music: musicDir(), effects: audioDir() };
}

export function libraryConfig(): LibraryConfig {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    /* no machine config: the Library shows Hangar's own outputs */
  }
  const roots: LibraryRoot[] = [];
  for (const r of Array.isArray(raw.roots) ? raw.roots : []) {
    const p = expand((r as LibraryRoot).path);
    if (!p || !SHELF_IDS.has((r as LibraryRoot).shelf)) continue;
    roots.push({ ...(r as LibraryRoot), path: path.resolve(p) });
  }
  // Hangar's studios write where their settings say, which today is still the
  // code folder. Once they point inside a configured root, that root covers them.
  const dirs = studioDirs();
  for (const dir of [dirs.gallery, dirs.archive, dirs.music, dirs.effects]) {
    if (!roots.some((r) => isInside(dir, r.path))) roots.push({ shelf: "generated", path: path.resolve(dir), project: "Hangar" });
  }
  // A root inside another one would be walked twice.
  const outer = roots.filter((r) => !roots.some((o) => o !== r && o.path !== r.path && isInside(r.path, o.path)));
  const unique = outer.filter((r, i) => outer.findIndex((o) => normPath(o.path) === normPath(r.path)) === i);
  const str = (v: unknown) => (expand(v) ? path.resolve(expand(v)) : null);
  return {
    cacheDir: str(raw.cacheDir) ?? path.join(DATA_DIR, "library-cache"),
    rtsaiArt: str(raw.rtsaiArt),
    rtsaiMod: str(raw.rtsaiMod),
    rtsaiDrafts: str(raw.rtsaiDrafts),
    roots: unique,
    projectRepos: (raw.projectRepos && typeof raw.projectRepos === "object" ? raw.projectRepos : {}) as Record<string, string[]>,
  };
}

/** The root a path is inside, or null: the file route serves nothing else. */
export function rootFor(file: string, config = libraryConfig()): LibraryRoot | null {
  return config.roots.find((r) => isInside(file, r.path)) ?? null;
}

// ── the index ──────────────────────────────────────────────────────────────

const COLUMNS = ["id", "path", "root", "shelf", "project", "grp", "studio", "kind", "faction", "status", "name", "size", "mtime", "poster", "prompt", "model", "sidecar", "count", "samples", "scan"] as const;

type Row = {
  id: string; path: string; root: string; shelf: Shelf; project: string | null; grp: string | null;
  studio: string | null; kind: MediaKind; faction: string | null; status: ReviewStatus | null; name: string;
  size: number | null; mtime: number; poster: string | null; prompt: string | null; model: string | null;
  sidecar: string | null; count: number | null; samples: string | null; scan: string;
};

const g = globalThis as typeof globalThis & {
  __libraryDb?: Promise<Db>;
  __libraryWrites?: Promise<unknown>;
  __libraryScan?: ScanState;
  __libraryJob?: Promise<void>;
};

async function db(): Promise<Db> {
  g.__libraryDb ??= (async () => {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const d = await openDatabase(path.join(DATA_DIR, "library.duckdb"));
    await d.run(`CREATE TABLE IF NOT EXISTS media (
      id VARCHAR PRIMARY KEY, path VARCHAR NOT NULL, root VARCHAR NOT NULL, shelf VARCHAR NOT NULL,
      project VARCHAR, grp VARCHAR, studio VARCHAR, kind VARCHAR NOT NULL, faction VARCHAR, status VARCHAR,
      name VARCHAR NOT NULL, size BIGINT, mtime BIGINT NOT NULL, poster VARCHAR, prompt VARCHAR, model VARCHAR,
      sidecar VARCHAR, count INTEGER, samples VARCHAR, scan VARCHAR NOT NULL)`);
    await d.run(`CREATE TABLE IF NOT EXISTS library_state (key VARCHAR PRIMARY KEY, value VARCHAR)`);
    return d;
  })().catch((err) => {
    g.__libraryDb = undefined;
    throw err;
  });
  return g.__libraryDb;
}

// One connection: statements go one at a time, and a collision is retried.
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = (g.__libraryWrites ?? Promise.resolve()).then(fn, fn);
  g.__libraryWrites = next.catch(() => undefined);
  return next;
}

async function run(sql: string, params: unknown[] = []) {
  const d = await db();
  return serial(() => d.run(sql, params));
}

async function all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const d = await db();
  return serial(() => d.all<T>(sql, params));
}

export function mediaId(file: string): string {
  return crypto.createHash("sha1").update(normPath(file)).digest("hex").slice(0, 20);
}

async function writeRows(rows: Row[]) {
  // 250 rows × 20 columns stays well inside what one statement binds.
  for (let i = 0; i < rows.length; i += 250) {
    const chunk = rows.slice(i, i + 250);
    const marks = chunk.map(() => `(${COLUMNS.map(() => "?").join(",")})`).join(",");
    await run(`INSERT OR REPLACE INTO media VALUES ${marks}`, chunk.flatMap((r) => COLUMNS.map((c) => r[c])));
  }
}

// ── scanning ───────────────────────────────────────────────────────────────

export type ScanState = {
  state: "idle" | "scanning" | "error";
  startedAt?: number;
  finishedAt?: number;
  seen: number;
  current?: string;
  error?: string;
};

/** Dot folders, recycle bins and the per-frame dumps some pipelines leave. */
const SKIP_DIR = /^(\.|\$recycle\.bin$|system volume information$|node_modules$|__pycache__$|frames$)/i;
/** A scan this old is redone when the Library is opened. */
const RESCAN_AFTER_MS = 30 * 60 * 1000;
/** Bumped when the rules for reading prompts change, so every file is read again. */
const INDEX_VERSION = 2;

type Previous = { size: number | null; mtime: number; prompt: string | null; model: string | null; sidecar: string | null };

type ScanContext = {
  config: LibraryConfig;
  dirs: StudioDirs;
  review: ReviewMap;
  factions: Set<string>;
  unitFaction: Map<string, string>;
  videoPrompts: Map<string, { prompt: string | null; model: string | null }>;
  previous: Map<string, Previous>;
  pending: Row[];
  scan: string;
  state: ScanState;
};

export function scanState(): ScanState {
  return g.__libraryScan ?? { state: "idle", seen: 0 };
}

export async function lastScanAt(): Promise<number | null> {
  const rows = await all<{ value: string }>(`SELECT value FROM library_state WHERE key = 'lastScan'`).catch(() => []);
  return rows[0] ? Number(rows[0].value) : null;
}

// Scans run one after another: two at once would each delete the rows the
// other just wrote.
function queueScan(only?: string[]): { state: ScanState; done: Promise<void> } {
  const state: ScanState = { state: "scanning", startedAt: Date.now(), seen: 0 };
  const done = (g.__libraryJob ?? Promise.resolve())
    .then(() => {
      g.__libraryScan = state;
      return runScan(state, only);
    })
    .catch((err) => {
      state.state = "error";
      state.error = err instanceof Error ? err.message : String(err);
      state.finishedAt = Date.now();
    });
  g.__libraryJob = done;
  return { state, done };
}

/** Start a full scan in the background unless one is running. */
export function startScan(): ScanState {
  if (g.__libraryScan?.state === "scanning") return g.__libraryScan;
  return queueScan().state;
}

/**
 * Re-read only Hangar's studio folders, and wait for it: a studio's History
 * shows a new picture as soon as it is saved. A few thousand files whose
 * prompts are already known take a second or two.
 */
export async function scanStudios(): Promise<ScanState> {
  const dirs = studioDirs();
  const job = queueScan([dirs.gallery, dirs.archive, dirs.music, dirs.effects]);
  await job.done;
  return job.state;
}

/** Scan when the index is missing or older than half an hour. */
export async function scanIfStale(): Promise<ScanState> {
  const state = scanState();
  if (state.state === "scanning") return state;
  const last = await lastScanAt();
  if (!last || Date.now() - last > RESCAN_AFTER_MS) return startScan();
  return state;
}

async function readJsonFile(file: string, maxBytes = 512 * 1024): Promise<unknown> {
  try {
    const st = await fsp.stat(file);
    if (st.size > maxBytes) return null;
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function readHead(file: string, bytes: number): Promise<Uint8Array | null> {
  let handle: fsp.FileHandle | null = null;
  try {
    handle = await fsp.open(file, "r");
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Faction ids, and the faction of every unit its rules files define. */
async function loadFactions(config: LibraryConfig): Promise<{ factions: Set<string>; unitFaction: Map<string, string> }> {
  const factions = new Set<string>();
  const unitFaction = new Map<string, string>();
  if (!config.rtsaiMod) return { factions, unitFaction };
  const catalog = (await readJsonFile(path.join(config.rtsaiMod, "catalog", "factions.json"), 8 * 1024 * 1024)) as {
    factions?: { id: string }[];
    units?: { id: string; factionId: string; variants?: Record<string, { actorId?: string }> }[];
  } | null;
  for (const f of catalog?.factions ?? []) factions.add(f.id.toLowerCase());
  for (const u of catalog?.units ?? []) {
    unitFaction.set(u.id.toLowerCase(), u.factionId);
    for (const v of Object.values(u.variants ?? {})) if (v.actorId) unitFaction.set(v.actorId.toLowerCase(), u.factionId);
  }
  // The art desk names units by their actor ids (r2qilin); the faction's own
  // rules files are what define those actors.
  const rulesDir = path.join(config.rtsaiMod, "mods", "rtsai", "modern-factions");
  for (const faction of factions) {
    for (const file of [`${faction}.yaml`, `${faction}-roster.yaml`]) {
      const text = await fsp.readFile(path.join(rulesDir, file), "utf8").catch(() => "");
      for (const actor of yamlActors(text)) if (!unitFaction.has(actor)) unitFaction.set(actor, faction);
    }
  }
  return { factions, unitFaction };
}

/** Video Studio clips are named `<job id>-<model>.mp4`; their prompts are in its job store. */
async function loadVideoPrompts(): Promise<Map<string, { prompt: string | null; model: string | null }>> {
  const map = new Map<string, { prompt: string | null; model: string | null }>();
  try {
    const d = await getDb();
    const rows = await d.all<{ id: string; data: string }>(`SELECT id, data FROM video_jobs`);
    for (const row of rows) {
      try {
        map.set(row.id, promptFromSidecar(JSON.parse(row.data)));
      } catch {
        /* one bad record */
      }
    }
  } catch {
    /* no video jobs yet */
  }
  return map;
}

/** A full scan, or with `only` just those folders (each inside some root). */
async function runScan(state: ScanState, folders?: string[]) {
  const config = libraryConfig();
  // The archive can sit inside the gallery folder; walk it once.
  const only = folders?.filter((d) => !folders.some((o) => normPath(o) !== normPath(d) && isInside(d, o)));
  const scan = Date.now().toString(36);
  const [review, { factions, unitFaction }, videoPrompts, before, version] = await Promise.all([
    config.rtsaiArt ? readJsonFile(path.join(config.rtsaiArt, "review.json"), 32 * 1024 * 1024).then(readReview) : Promise.resolve(new Map() as ReviewMap),
    loadFactions(config),
    loadVideoPrompts(),
    all<Previous & { id: string }>(`SELECT id, size, mtime, prompt, model, sidecar FROM media`),
    all<{ value: string }>(`SELECT value FROM library_state WHERE key = 'indexVersion'`),
  ]);
  // Prompts read by an older version of the rules are read again.
  const reuse = version[0]?.value === String(INDEX_VERSION);
  const ctx: ScanContext = {
    config, dirs: studioDirs(), review, factions, unitFaction, videoPrompts,
    previous: new Map(reuse ? before.map((r) => [r.id, { ...r, size: r.size == null ? null : Number(r.size), mtime: Number(r.mtime) }]) : []),
    pending: [], scan, state,
  };
  const walked: string[] = [];
  for (const root of config.roots) {
    let st: fs.Stats;
    try {
      st = await fsp.stat(root.path);
    } catch {
      continue; // an unplugged drive keeps its rows until it is back
    }
    if (!st.isDirectory()) continue;
    if (only) {
      for (const dir of only.filter((d) => isInside(d, root.path))) {
        if (!(await fsp.stat(dir).catch(() => null))?.isDirectory()) continue;
        await walk(ctx, root, dir, path.relative(root.path, dir).split(path.sep).filter(Boolean).length);
        walked.push(dir);
      }
      continue;
    }
    await walk(ctx, root, root.path, 0);
    walked.push(root.path);
  }
  await flush(ctx, true);
  if (only) {
    // Gone from those folders since the last scan.
    for (const dir of walked) await run(`DELETE FROM media WHERE scan <> ? AND (path = ? OR starts_with(path, ?))`, [scan, dir, dir + path.sep]);
    state.state = "idle";
    state.current = undefined;
    state.finishedAt = Date.now();
    return;
  }
  // Gone from disk: rows of walked roots this scan didn't see, and rows of
  // roots no longer configured.
  if (walked.length) {
    await run(`DELETE FROM media WHERE scan <> ? AND root IN (${walked.map(() => "?").join(",")})`, [scan, ...walked]);
  }
  const configured = config.roots.map((r) => r.path);
  await run(`DELETE FROM media WHERE root NOT IN (${configured.map(() => "?").join(",")})`, configured);
  await run(`INSERT OR REPLACE INTO library_state VALUES ('lastScan', ?)`, [String(Date.now())]);
  await run(`INSERT OR REPLACE INTO library_state VALUES ('indexVersion', ?)`, [String(INDEX_VERSION)]);
  state.state = "idle";
  state.current = undefined;
  state.finishedAt = Date.now();
}

async function flush(ctx: ScanContext, force = false) {
  if (!force && ctx.pending.length < 1000) return;
  const rows = ctx.pending;
  ctx.pending = [];
  await writeRows(rows);
}

/** Project and group of a file, from where it sits under its root. */
function placeOf(root: LibraryRoot, file: string): { project: string | null; grp: string | null } {
  const rel = path.relative(root.path, file).split(path.sep);
  if (root.project) return { project: root.project, grp: root.group ?? (rel.length > 1 ? rel[0] : null) };
  if (rel.length < 2) return { project: projectName(path.basename(root.path)), grp: null };
  return { project: projectName(rel[0]), grp: rel.length > 2 ? rel[1] : null };
}

async function walk(ctx: ScanContext, root: LibraryRoot, dir: string, depth: number) {
  ctx.state.current = dir;
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const files: string[] = [];
  const dirs: string[] = [];
  for (const e of entries) {
    // Junctions and links are skipped: the Hangar folder's 3d junction points
    // into D:\Generated, which is walked on its own.
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      if (!SKIP_DIR.test(e.name)) dirs.push(e.name);
    } else if (e.isFile()) files.push(e.name);
  }

  if (files.length) await indexFolder(ctx, root, dir, files);

  // A dataset's set (Datasets\<project>\<set>) with thousands of files is one
  // card with samples, not 150,000 posters.
  const setDepth = root.project ? 0 : 1;
  for (const name of dirs) {
    const child = path.join(dir, name);
    if (root.shelf === "datasets" && depth === setDepth && (await indexCollection(ctx, root, child))) continue;
    await walk(ctx, root, child, depth + 1);
  }
}

/** Index a dataset set as one card when it is big or holds no viewable media. */
async function indexCollection(ctx: ScanContext, root: LibraryRoot, dir: string): Promise<boolean> {
  const media: string[] = [];
  let other = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    ctx.state.current = d;
    const entries = await fsp.readdir(d, { withFileTypes: true }).catch(() => [] as fs.Dirent[]);
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (!SKIP_DIR.test(e.name)) stack.push(path.join(d, e.name));
      } else if (e.isFile()) {
        const kind = kindOf(e.name);
        if (kind && kind !== "model") media.push(path.join(d, e.name));
        else other += 1;
      }
    }
  }
  if (media.length && media.length < COLLECTION_MIN) return false;
  if (!media.length && !other) return true;
  const st = await fsp.stat(dir).catch(() => null);
  media.sort();
  const samples = spread(media.filter((f) => kindOf(f) === "image").length ? media.filter((f) => kindOf(f) === "image") : media, 12);
  const { project, grp } = placeOf(root, path.join(dir, "x"));
  ctx.pending.push({
    id: mediaId(dir), path: dir, root: root.path, shelf: root.shelf, project, grp, studio: null,
    kind: "collection", faction: null, status: null, name: path.basename(dir), size: null,
    mtime: st ? Math.round(st.mtimeMs) : Date.now(), poster: samples[0] ?? null, prompt: null, model: null,
    sidecar: null, count: media.length || other, samples: JSON.stringify(samples), scan: ctx.scan,
  });
  ctx.state.seen += 1;
  await flush(ctx);
  return true;
}

async function indexFolder(ctx: ScanContext, root: LibraryRoot, dir: string, files: string[]) {
  const { items } = pickItems(files);
  if (!items.length) return;
  const lower = new Set(files.map((f) => f.toLowerCase()));
  let folderMeta: unknown | undefined;
  const folderInfo = async () => {
    if (folderMeta !== undefined) return folderMeta;
    folderMeta = lower.has("meta.json") ? await readJsonFile(path.join(dir, "meta.json")) : null;
    if (!folderMeta && lower.has("prompt.txt")) {
      const t = await fsp.readFile(path.join(dir, "prompt.txt"), "utf8").catch(() => "");
      folderMeta = t.trim() ? { prompt: t.trim().slice(0, 4000) } : null;
    }
    return folderMeta;
  };
  const isRtsai = (p: string | null) => p === "RTSAI";

  for (let i = 0; i < items.length; i += 64) {
    const batch = items.slice(i, i + 64);
    const stats = await Promise.all(batch.map((it) => fsp.stat(path.join(dir, it.name)).catch(() => null)));
    for (let j = 0; j < batch.length; j++) {
      const item = batch[j];
      const st = stats[j];
      if (!st) continue;
      const file = path.join(dir, item.name);
      const id = mediaId(file);
      const size = st.size;
      const mtime = Math.round(st.mtimeMs);
      const { project, grp } = placeOf(root, file);
      // D:\Generated\Hangar is laid out like the studio folder itself, before
      // and after its settings point there.
      const home = root.project ? null : path.join(root.path, "Hangar");
      const studio = studioFor(file, item.kind, home && isInside(file, home) ? { ...ctx.dirs, gallery: home } : ctx.dirs);
      let info: { prompt: string | null; model: string | null; sidecar: string | null };
      const prev = ctx.previous.get(id);
      if (prev && prev.size === size && prev.mtime === mtime) {
        info = { prompt: prev.prompt, model: prev.model, sidecar: prev.sidecar };
      } else {
        info = await readPrompt(ctx, dir, item.name, item.kind, studio, lower, folderInfo);
      }
      ctx.pending.push({
        id, path: file, root: root.path, shelf: root.shelf, project, grp, studio, kind: item.kind,
        faction: isRtsai(project) ? factionFor(file, ctx.factions, ctx.unitFaction) : null,
        status: isRtsai(project) ? reviewStatus(file, ctx.review, ctx.config.rtsaiDrafts) : null,
        name: item.name, size, mtime, poster: item.poster ? path.join(dir, item.poster) : null,
        prompt: info.prompt ? info.prompt.slice(0, 4000) : null, model: info.model, sidecar: info.sidecar,
        count: null, samples: null, scan: ctx.scan,
      });
      ctx.state.seen += 1;
    }
    await flush(ctx);
  }
}

/** Prompt and model for one file: its own sidecar, its folder's, its job's or its PNG text. */
async function readPrompt(
  ctx: ScanContext, dir: string, name: string, kind: MediaKind, studio: string | null,
  lower: Set<string>, folderInfo: () => Promise<unknown>,
): Promise<{ prompt: string | null; model: string | null; sidecar: string | null }> {
  const stem = stemOf(name);
  const own = `${stem}.json`;
  if (lower.has(own.toLowerCase())) {
    const sidecar = path.join(dir, own);
    const info = promptFromSidecar(await readJsonFile(sidecar));
    if (info.prompt || info.model) return { ...info, sidecar };
  }
  if (studio === "video" && kind === "video") {
    const job = ctx.videoPrompts.get(stem.split("-")[0]);
    if (job?.prompt) return { ...job, sidecar: null };
  }
  const folder = await folderInfo();
  if (folder) {
    const info = promptFromSidecar(folder, name);
    if (info.prompt || info.model) return { ...info, sidecar: lower.has("meta.json") ? path.join(dir, "meta.json") : null };
  }
  if (extOf(name) === ".png") {
    const head = await readHead(path.join(dir, name), 512 * 1024);
    if (head) {
      const chunks = pngText(head);
      if (chunks.prompt) {
        const info = promptFromComfy(chunks.prompt);
        if (info.prompt || info.model) return { ...info, sidecar: null };
      }
      if (chunks.parameters) return { prompt: chunks.parameters.split(/\nNegative prompt:/)[0].trim(), model: null, sidecar: null };
    }
  }
  return { prompt: null, model: null, sidecar: null };
}

// ── reading ────────────────────────────────────────────────────────────────

export type LibraryItem = {
  id: string; kind: MediaKind; name: string; shelf: Shelf; project: string | null; group: string | null;
  studio: string | null; faction: string | null; status: ReviewStatus | null; mtime: number; size: number | null;
  prompt: string | null; model: string | null; poster: boolean; count: number | null;
};

export type LibraryFilter = {
  shelf?: string; project?: string; group?: string; studio?: string; kind?: string; faction?: string; status?: string;
  q?: string; from?: number; to?: number;
};

const ITEM_COLUMNS = `id, kind, name, shelf, project, grp, studio, faction, status, mtime, size, prompt, model, poster, count`;

function toItem(r: Record<string, unknown>): LibraryItem {
  return {
    id: String(r.id), kind: r.kind as MediaKind, name: String(r.name), shelf: r.shelf as Shelf,
    project: (r.project as string) ?? null, group: (r.grp as string) ?? null, studio: (r.studio as string) ?? null,
    faction: (r.faction as string) ?? null, status: (r.status as ReviewStatus) ?? null, mtime: Number(r.mtime),
    size: r.size == null ? null : Number(r.size), prompt: r.prompt ? String(r.prompt).slice(0, 400) : null,
    model: (r.model as string) ?? null, poster: r.kind === "model" || r.kind === "collection" ? !!r.poster : r.kind !== "sound",
    count: r.count == null ? null : Number(r.count),
  };
}

function where(f: LibraryFilter): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const eq = (column: string, value?: string) => {
    if (!value) return;
    if (value === "none") clauses.push(`${column} IS NULL`);
    else {
      clauses.push(`${column} = ?`);
      params.push(value);
    }
  };
  eq("shelf", f.shelf);
  eq("project", f.project);
  eq("grp", f.group);
  eq("studio", f.studio);
  eq("kind", f.kind);
  eq("faction", f.faction);
  eq("status", f.status);
  if (f.from) {
    clauses.push("mtime >= ?");
    params.push(f.from);
  }
  if (f.to) {
    clauses.push("mtime < ?");
    params.push(f.to);
  }
  for (const word of (f.q ?? "").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8)) {
    clauses.push(`(lower(coalesce(prompt, '')) LIKE ? OR lower(coalesce(model, '')) LIKE ? OR lower(name) LIKE ? OR lower(coalesce(grp, '')) LIKE ?)`);
    const like = `%${word.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    params.push(like, like, like, like);
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

/** One page of the wall, newest first. `cursor` is the last item's "mtime:id". */
export async function listMedia(f: LibraryFilter & { cursor?: string; limit?: number }): Promise<{ items: LibraryItem[]; next: string | null }> {
  const limit = Math.min(Math.max(f.limit ?? 120, 1), 300);
  const w = where(f);
  let sql = w.sql;
  const params = [...w.params];
  const m = /^(\d+):([0-9a-f]+)$/.exec(f.cursor ?? "");
  if (m) {
    sql += `${sql ? " AND" : "WHERE"} (mtime < ? OR (mtime = ? AND id < ?))`;
    params.push(Number(m[1]), Number(m[1]), m[2]);
  }
  const rows = await all<Record<string, unknown>>(`SELECT ${ITEM_COLUMNS} FROM media ${sql} ORDER BY mtime DESC, id DESC LIMIT ${limit + 1}`, params);
  const items = rows.slice(0, limit).map(toItem);
  const last = items[items.length - 1];
  return { items, next: rows.length > limit && last ? `${last.mtime}:${last.id}` : null };
}

export type FacetSet = { kinds: Facet[]; projects: Facet[]; studios: Facet[]; factions: Facet[]; statuses: Facet[] };

/**
 * What each filter can still narrow to, given the others: a dimension's counts
 * ignore its own choice, so picking one project still lists the rest.
 */
export async function facetCounts(f: LibraryFilter): Promise<FacetSet> {
  const dims = [["kinds", "kind"], ["projects", "project"], ["studios", "studio"], ["factions", "faction"], ["statuses", "status"]] as const;
  const out = { kinds: [], projects: [], studios: [], factions: [], statuses: [] } as FacetSet;
  for (const [key, column] of dims) {
    const w = where({ ...f, [column]: undefined });
    const rows = await all<{ v: string | null; n: number | bigint }>(`SELECT ${column} AS v, count(*) AS n FROM media ${w.sql} GROUP BY 1 ORDER BY 2 DESC`, w.params);
    out[key] = rows.filter((r) => r.v).map((r) => ({ value: String(r.v), count: Number(r.n) }));
  }
  return out;
}

export async function countMedia(f: LibraryFilter): Promise<number> {
  const w = where(f);
  const rows = await all<{ n: number | bigint }>(`SELECT count(*) AS n FROM media ${w.sql}`, w.params);
  return Number(rows[0]?.n ?? 0);
}

export type Facet = { value: string; count: number };
export type ShelfSummary = {
  id: Shelf; label: string; count: number; kinds: Record<string, number>; samples: LibraryItem[];
  projects: Facet[]; studios: Facet[]; factions: Facet[]; statuses: Facet[];
};

/** Each faction's accent colour from the catalog, so its chips match the game. */
async function factionAccents(config: LibraryConfig): Promise<Record<string, string>> {
  if (!config.rtsaiMod) return {};
  const catalog = (await readJsonFile(path.join(config.rtsaiMod, "catalog", "factions.json"), 8 * 1024 * 1024)) as { factions?: { id: string; name?: string; accent?: string }[] } | null;
  return Object.fromEntries((catalog?.factions ?? []).filter((f) => f.accent).map((f) => [f.id, f.accent!]));
}

/** Each shelf's size, its banner's posters and the values its filters offer. */
export async function librarySummary(): Promise<{ shelves: ShelfSummary[]; scan: ScanState; lastScan: number | null; roots: { path: string; shelf: Shelf; present: boolean }[]; factionColors: Record<string, string> }> {
  const config = libraryConfig();
  const [groups, samples, lastScan, factionColors] = await Promise.all([
    all<{ shelf: Shelf; project: string | null; studio: string | null; faction: string | null; status: string | null; kind: string; n: number | bigint }>(
      `SELECT shelf, project, studio, faction, status, kind, count(*) AS n FROM media GROUP BY ALL`,
    ),
    // The newest few of each project, so a banner shows the shelf's range.
    all<Record<string, unknown>>(
      `SELECT ${ITEM_COLUMNS} FROM (
         SELECT *, row_number() OVER (PARTITION BY shelf, project ORDER BY kind = 'sound', mtime DESC) AS rn FROM media
         WHERE kind IN ('image', 'video', 'sound') OR (kind IN ('model', 'collection') AND poster IS NOT NULL)
       ) WHERE rn <= 4 ORDER BY mtime DESC`,
    ),
    lastScanAt(),
    factionAccents(config),
  ]);
  const shelves = SHELVES.map(({ id, label }) => {
    const mine = groups.filter((r) => r.shelf === id);
    const facet = (key: "project" | "studio" | "faction" | "status") => {
      const counts = new Map<string, number>();
      for (const r of mine) if (r[key]) counts.set(r[key]!, (counts.get(r[key]!) ?? 0) + Number(r.n));
      return [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
    };
    const kinds: Record<string, number> = {};
    for (const r of mine) kinds[r.kind] = (kinds[r.kind] ?? 0) + Number(r.n);
    // Round-robin across projects, so one busy project doesn't fill the banner.
    const byProject = new Map<string, LibraryItem[]>();
    for (const s of samples.map(toItem).filter((s) => s.shelf === id)) {
      const k = s.project ?? "";
      byProject.set(k, [...(byProject.get(k) ?? []), s]);
    }
    const picked: LibraryItem[] = [];
    for (let round = 0; picked.length < 6 && round < 4; round++) {
      for (const list of byProject.values()) if (list[round] && picked.length < 6) picked.push(list[round]);
    }
    return {
      id, label, count: mine.reduce((n, r) => n + Number(r.n), 0), kinds, samples: picked,
      projects: facet("project"), studios: facet("studio"), factions: facet("faction"), statuses: facet("status"),
    };
  });
  const roots = await Promise.all(config.roots.map(async (r) => ({ path: r.path, shelf: r.shelf, present: !!(await fsp.stat(r.path).catch(() => null)) })));
  return { shelves, scan: scanState(), lastScan, roots, factionColors };
}

/** Everything known about one file, for the viewer. */
export async function getMedia(id: string): Promise<(LibraryItem & { path: string; sidecar: Record<string, unknown> | null; samples: { name: string; kind: MediaKind | null }[] }) | null> {
  if (!/^[0-9a-f]{20}$/.test(id)) return null;
  const rows = await all<Record<string, unknown>>(`SELECT * FROM media WHERE id = ?`, [id]);
  const r = rows[0];
  if (!r) return null;
  const sidecar = r.sidecar ? ((await readJsonFile(String(r.sidecar), 256 * 1024)) as Record<string, unknown> | null) : null;
  return { ...toItem(r), path: String(r.path), sidecar, samples: samplePaths(r).map((p) => ({ name: path.basename(p), kind: kindOf(p) })) };
}

function samplePaths(row: Record<string, unknown>): string[] {
  try {
    return row.samples ? (JSON.parse(String(row.samples)) as string[]) : [];
  } catch {
    return [];
  }
}

export type ServedFile = { path: string; kind: MediaKind | null; size: number | null; mtime: number };

/**
 * The file behind an id, or one of its parts: its poster, or a collection's
 * n-th sample. Only paths inside a configured root are ever returned.
 */
export async function resolveMediaFile(id: string, part?: { poster?: boolean; sample?: number }): Promise<(ServedFile & { row: Record<string, unknown> }) | null> {
  if (!/^[0-9a-f]{20}$/.test(id)) return null;
  const rows = await all<Record<string, unknown>>(`SELECT * FROM media WHERE id = ?`, [id]);
  const row = rows[0];
  if (!row) return null;
  let file = String(row.path);
  let kind = row.kind as MediaKind | null;
  if (part?.poster) {
    if (!row.poster) return null;
    file = String(row.poster);
    kind = "image";
  } else if (part?.sample != null) {
    const sample = samplePaths(row)[part.sample];
    if (!sample) return null;
    file = sample;
    kind = kindOf(sample);
  }
  if (!rootFor(file)) return null;
  const st = await fsp.stat(file).catch(() => null);
  if (!st || !(st.isFile() || (kind === "collection" && st.isDirectory()))) return null;
  return { path: file, kind, size: st.isFile() ? st.size : null, mtime: Math.round(st.mtimeMs), row };
}

/** A collection's sample paths, for its mosaic. */
export function collectionSamples(row: Record<string, unknown>): string[] {
  return samplePaths(row).filter((p) => !!rootFor(p));
}

/** The newest posters of the projects a World repo maps to. */
export async function projectMedia(repo: string, limit = 8): Promise<{ project: string | null; items: LibraryItem[]; total: number }> {
  const config = libraryConfig();
  const wanted = repo.toLowerCase().split("/").pop() ?? "";
  const project = Object.entries(config.projectRepos).find(([, repos]) => repos.some((r) => r.toLowerCase() === wanted))?.[0] ?? null;
  if (!project) return { project: null, items: [], total: 0 };
  const rows = await all<Record<string, unknown>>(
    `SELECT ${ITEM_COLUMNS} FROM media WHERE project = ? AND (kind IN ('image', 'video') OR (kind = 'model' AND poster IS NOT NULL)) ORDER BY mtime DESC LIMIT ${Math.min(limit, 24)}`,
    [project],
  );
  return { project, items: rows.map(toItem), total: await countMedia({ project }) };
}
