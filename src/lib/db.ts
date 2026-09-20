import * as duckdb from "duckdb";
import { existsSync } from "fs";
import path from "path";
import fs from "fs/promises";

// Store outside the project root so Turbopack's file watcher never touches it.
//
// The project was renamed from betenshi-console to Hangar. New installs use
// ~/hangar/hangar.db; a machine that already has ~/betenshi/betenshi.db keeps
// using it, because silently pointing at a fresh empty database would look
// exactly like losing every record. BETENSHI_DB_PATH still works too.
const DATA_ROOT = process.env.LOCALAPPDATA || process.env.HOME || process.cwd();
const LEGACY_DB = path.join(DATA_ROOT, "betenshi", "betenshi.db");
const DB_PATH =
  process.env.NEXT_PHASE === "phase-production-build"
    ? ":memory:"
    : process.env.HANGAR_DB_PATH ||
      process.env.BETENSHI_DB_PATH ||
      (existsSync(LEGACY_DB) ? LEGACY_DB : path.join(DATA_ROOT, "hangar", "hangar.db"));

type Row = Record<string, unknown>;

export type Db = {
  run(sql: string, params?: unknown[]): Promise<void>;
  all<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T = Row>(sql: string, params?: unknown[]): Promise<T | null>;
};

function makeDb(db: duckdb.Database): Db {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = db as any;

  function run(sql: string, params: unknown[] = []): Promise<void> {
    return new Promise((resolve, reject) => {
      d.run(sql, ...params, (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  function all<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    return new Promise((resolve, reject) => {
      d.all(sql, ...params, (err: Error | null, rows: T[]) => {
        if (err) reject(err);
        else resolve(rows ?? []);
      });
    });
  }

  return {
    run,
    all,
    get: <T = Row>(sql: string, params: unknown[] = []) =>
      all<T>(sql, params).then((rows) => rows[0] ?? null),
  };
}

function open(): Promise<Db> {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = new duckdb.Database(DB_PATH, (err: any) => {
      if (err) reject(err as Error);
      else resolve(makeDb(db));
    });
  });
}

async function createSchema(db: Db) {
  await db.run(`CREATE TABLE IF NOT EXISTS batch_jobs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'queued',
    idea TEXT NOT NULL,
    prompts TEXT NOT NULL,
    params TEXT NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL,
    current_index INTEGER,
    created_at TEXT NOT NULL,
    started_at TEXT,
    done_at TEXT,
    last_error TEXT
  )`);

  await db.run(`CREATE TABLE IF NOT EXISTS images (
    id TEXT PRIMARY KEY,
    rel TEXT NOT NULL UNIQUE,
    folder TEXT NOT NULL DEFAULT '',
    filename TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'generate',
    prompt TEXT DEFAULT '',
    negative_prompt TEXT DEFAULT '',
    seed INTEGER,
    width INTEGER,
    height INTEGER,
    steps INTEGER,
    cfg DOUBLE,
    latency INTEGER,
    input_count INTEGER,
    bytes INTEGER,
    favorite BOOLEAN NOT NULL DEFAULT false,
    saved_at TEXT NOT NULL,
    batch_job_id TEXT,
    model TEXT NOT NULL DEFAULT 'qwen-image'
  )`);

  // The gallery holds output from more than one image model now, so rows have to
  // record which one made them. Existing rows all predate FLUX, so the column
  // default backfills them correctly.
  //
  // Isolated in its own try/catch: a migration that throws here would reject the
  // whole getDb() promise, and every image, job and gallery route would fail on
  // a schema detail. Losing the column degrades to "everything reads as
  // qwen-image"; losing the connection loses the app.
  try {
    await db.run(`ALTER TABLE images ADD COLUMN IF NOT EXISTS model TEXT DEFAULT 'qwen-image'`);
  } catch (err) {
    console.error("[db] images.model migration failed — model attribution will be wrong:", err);
  }
}

async function migrateJobs(db: Db) {
  const row = await db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM batch_jobs`);
  if (row && Number(row.c) > 0) return;

  const jobsDir = path.join(process.cwd(), "var", "batch-jobs");
  let files: string[];
  try {
    files = (await fs.readdir(jobsDir)).filter((f) => f.endsWith(".json"));
  } catch {
    return;
  }

  for (const f of files) {
    try {
      const job = JSON.parse(await fs.readFile(path.join(jobsDir, f), "utf8"));
      if (!job.id) continue;
      await db.run(
        `INSERT INTO batch_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          job.id,
          job.status || "queued",
          job.idea || "",
          JSON.stringify(job.prompts || []),
          JSON.stringify(job.params || {}),
          job.completed || 0,
          job.failed || 0,
          job.total || 0,
          job.currentIndex ?? null,
          job.createdAt || new Date().toISOString(),
          job.startedAt || null,
          job.doneAt || null,
          job.lastError || null,
        ],
      );
    } catch {
      /* skip malformed */
    }
  }

  // One-shot import. Without this rename, an empty batch_jobs table — which is
  // exactly what you get after deleting every job — re-imports these legacy files
  // on the next boot and the deleted jobs come back from the dead.
  await fs.rename(jobsDir, `${jobsDir}.imported`).catch(() => {});
}

async function migrateImages(db: Db) {
  const row = await db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM images`);
  if (row && Number(row.c) > 0) return;

  const outputDir = process.env.QWEN_OUTPUT_DIR || path.join(process.cwd(), "generated");
  const pngs: string[] = [];

  async function walk(absDir: string, relDir: string) {
    let entries;
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(absDir, e.name), rel);
      else if (e.name.toLowerCase().endsWith(".png")) pngs.push(rel);
    }
  }

  await walk(outputDir, "");

  for (const rel of pngs) {
    try {
      const filename = rel.includes("/") ? rel.slice(rel.lastIndexOf("/") + 1) : rel;
      const folder = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";

      let meta: Record<string, unknown> = {};
      try {
        meta = JSON.parse(
          await fs.readFile(path.join(outputDir, rel.replace(/\.png$/i, ".json")), "utf8"),
        );
      } catch {
        /* no sidecar */
      }

      let bytes: number | null = null;
      let savedAt = (meta.savedAt as string) || null;
      try {
        const st = await fs.stat(path.join(outputDir, rel));
        bytes = st.size;
        if (!savedAt) savedAt = st.mtime.toISOString();
      } catch {
        /* ignore */
      }

      const id = `img_m${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      await db.run(
        `INSERT INTO images VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id, rel, folder, filename,
          (meta.kind as string) || (filename.includes("-edit-") ? "edit" : "generate"),
          (meta.prompt as string) || "",
          (meta.negative_prompt as string) || "",
          (meta.seed as number) ?? null,
          (meta.width as number) ?? null,
          (meta.height as number) ?? null,
          (meta.steps as number) ?? null,
          (meta.cfg as number) ?? null,
          (meta.latency as number) ?? null,
          (meta.inputCount as number) || (meta.input_count as number) || null,
          bytes,
          meta.favorite === true,
          savedAt || new Date().toISOString(),
          (meta.batch_job_id as string) || null,
        ],
      );
    } catch {
      /* skip */
    }
  }
}

const g = globalThis as typeof globalThis & { __bDb?: Promise<Db> };

export function getDb(): Promise<Db> {
  if (!g.__bDb) {
    g.__bDb = (async () => {
      if (DB_PATH !== ":memory:") await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
      const db = await open();
      await createSchema(db);
      await migrateJobs(db);
      await migrateImages(db);
      return db;
    })().catch((err) => {
      g.__bDb = undefined;
      throw err;
    });
  }
  return g.__bDb;
}
