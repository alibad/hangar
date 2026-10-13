import { NextRequest, NextResponse } from "next/server";
import { readdir, stat } from "fs/promises";
import path from "path";
import { outputDir } from "@/lib/save-image";
import { MESH_ROOT, hasFile, jobFromId, meshFileUrl, readJobMeta, type JobMeta } from "@/lib/mesh3d";
import { isJobId, latestByFile } from "@/lib/mesh3d-shared";

export const dynamic = "force-dynamic";

export type MeshJobSummary = {
  id: string;
  subject: string;
  /** The full prompt the image model drew from, when the image was generated. */
  prompt: string | null;
  /** When the job was made (from the id's timestamp), ISO. */
  createdAt: string | null;
  /** The named set a script made it in (`compareGroup` "<tool>:<set>"), if any. */
  group: string | null;
  groupLabel: string | null;
  sourceUrl: string;
  sourceNote: string;
  cutoutUrl: string | null;
  cutoutNote: string | null;
  /** The noun the cutout was made with, so reopening restores it. */
  concept: string | null;
  /** Object or person — reopening a job switches the Lab to its mode. */
  kind: "object" | "person";
  meshes: {
    file: string;
    url: string;
    model: string;
    resolution: number | null;
    seed: number | null;
    latencyMs: number | null;
    bytes: number | null;
    /** For a body: its pose JSON (joints + landmarks). */
    poseUrl?: string | null;
  }[];
};

export type MeshJobsPage = {
  jobs: MeshJobSummary[];
  /** Jobs matching the filters. */
  total: number;
  /** Every job, whatever the filters. */
  all: number;
  /** Named sets with their job counts, biggest first. */
  groups: { id: string; label: string; count: number }[];
};

/**
 * The 3D Lab's library: every job folder (objects and people), newest first,
 * each with its image, cutout and every mesh made from it — so any of them can
 * be found, orbited, and reopened to cut again or run another model.
 *
 *   ?limit=48&offset=0   a page (limit up to 120)
 *   ?q=fox               subject or prompt contains the words
 *   ?kind=object|person
 *   ?has=mesh|none       with or without a mesh
 *   ?group=<id>          one named set ("none" = made by hand in the Lab)
 *
 * Filtering needs every job's meta.json (about 40 ms for 1,400 jobs), so a
 * light index of all of them is kept for a few seconds; full summaries (file
 * stats, URLs) are built only for the page returned. The set a job belongs to
 * is `meta.group`, written by the run route from the run's compareGroup; it is
 * not looked up in the runs record, whose queries wait behind every write
 * while a long generation run is recording.
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const limit = Math.min(120, Math.max(1, Number(sp.get("limit")) || 24));
  const offset = Math.max(0, Number(sp.get("offset")) || 0);
  const words = (sp.get("q") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const kind = sp.get("kind");
  const has = sp.get("has");
  const group = sp.get("group");

  const index = await loadIndex();
  const matches = index.filter(
    (e) =>
      (!words.length || words.every((w) => e.text.includes(w))) &&
      (kind !== "object" && kind !== "person" ? true : e.kind === kind) &&
      (has === "mesh" ? e.meshCount > 0 : has === "none" ? e.meshCount === 0 : true) &&
      (!group ? true : group === "none" ? !e.group : e.group === group),
  );
  const counts = new Map<string, number>();
  for (const e of index) if (e.group) counts.set(e.group, (counts.get(e.group) ?? 0) + 1);
  const groups = [...counts].map(([id, count]) => ({ id, label: groupLabel(id), count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  const jobs: MeshJobSummary[] = [];
  for (const e of matches.slice(offset, offset + limit)) {
    const s = await summarize(e.id, e.meta, e.group);
    if (s) jobs.push(s);
  }
  const page: MeshJobsPage = { jobs, total: matches.length, all: index.length, groups };
  return NextResponse.json(page);
}

// ── the index ───────────────────────────────────────────────────────────────

type IndexEntry = { id: string; meta: JobMeta; text: string; kind: "object" | "person"; meshCount: number; group: string | null };

type IndexCache = { at: number; key: string; entries: Promise<IndexEntry[]>; refreshing?: boolean };
const g = globalThis as typeof globalThis & { __mesh3dIndex?: IndexCache };
const INDEX_TTL_MS = 15_000;

/**
 * The index, stale-while-revalidate: a new job folder (the folder list is a
 * cheap read) rebuilds it at once; otherwise the cached one answers and, once
 * it is older than the TTL, a rebuild runs in the background. The run route
 * drops the cache when it adds a mesh, so the Lab's own runs show at once.
 */
async function loadIndex(): Promise<IndexEntry[]> {
  let names: string[] = [];
  try {
    names = (await readdir(path.join(outputDir(), MESH_ROOT))).filter(isJobId).sort().reverse();
  } catch {
    return [];
  }
  const key = `${names.length}:${names[0] ?? ""}`;
  const cur = g.__mesh3dIndex;
  if (cur && cur.key === key) {
    if (Date.now() - cur.at > INDEX_TTL_MS && !cur.refreshing) {
      cur.refreshing = true;
      buildIndex(names)
        .then((entries) => {
          g.__mesh3dIndex = { at: Date.now(), key, entries: Promise.resolve(entries) };
        })
        .catch(() => {
          cur.refreshing = false;
        });
    }
    return cur.entries;
  }
  const entries = buildIndex(names).catch((err) => {
    g.__mesh3dIndex = undefined;
    throw err;
  });
  g.__mesh3dIndex = { at: Date.now(), key, entries };
  return entries;
}

async function buildIndex(names: string[]): Promise<IndexEntry[]> {
  const out: IndexEntry[] = [];
  // In chunks: a thousand-odd small reads at once is slower than a few hundred at a time.
  for (let i = 0; i < names.length; i += 200) {
    const chunk = await Promise.all(
      names.slice(i, i + 200).map(async (id) => {
        const meta = await readJobMeta(jobFromId(id)!);
        if (!meta.source) return null;
        const src = meta.source as { prompt?: string };
        const gid = typeof meta.group === "string" && meta.group ? meta.group : null;
        return {
          id,
          meta,
          kind: meta.kind === "person" ? "person" : "object",
          meshCount: (meta.meshes ?? []).length,
          group: gid,
          text: `${meta.subject ?? ""} ${src.prompt ?? ""} ${gid ? groupLabel(gid) : ""} ${id}`.toLowerCase(),
        } satisfies IndexEntry;
      }),
    );
    for (const e of chunk) if (e) out.push(e);
  }
  return out;
}

const BOARDS: Record<string, string> = {
  vedic: "Vedic",
  tao: "Tao",
  sufi: "Sufi",
  tibetan: "Tibetan",
  christian: "Christian",
  jain: "Jain",
  vaikuntapali: "Vaikuntapali",
  kabbalah: "Kabbalah",
  quantum: "Quantum",
  "psych-jungian": "Jungian",
  "psych-maslow": "Maslow",
  "psych-developmental": "Developmental",
  "psych-integrative": "Integrative",
};
const STYLES: Record<string, string> = { relic: "sculptures", room: "rooms", figure: "characters", talisman: "talismans", shrine: "shrines", toy: "toys" };

/** "hangar-models:leela-tibetan-relic-s2" → "Leela · Tibetan sculptures (pass 2)". */
function groupLabel(id: string): string {
  const [tool, set = ""] = id.includes(":") ? [id.slice(0, id.indexOf(":")), id.slice(id.indexOf(":") + 1)] : ["", id];
  if (set === "ra2") return "Red Alert 2 units";
  if (set === "philosophy") return "Philosophy";
  const m = /^leela-(.+?)(?:-(relic|room|figure|talisman|shrine|toy))?(?:-s(\d+))?$/.exec(set);
  if (m && BOARDS[m[1]]) return `Leela · ${BOARDS[m[1]]} ${STYLES[m[2] ?? "relic"]}${m[3] ? ` (pass ${m[3]})` : ""}`;
  const words = set.replace(/[-_]+/g, " ").trim();
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}${tool && tool !== "hangar-models" ? ` · ${tool}` : ""}`;
}

// ── one job ─────────────────────────────────────────────────────────────────

async function summarize(id: string, meta: JobMeta, group: string | null): Promise<MeshJobSummary | null> {
  const job = jobFromId(id)!;
  if (!(await hasFile(job, "source.png"))) return null;
  const src = (meta.source ?? {}) as { kind?: string; model?: string; seed?: number; latencyMs?: number; name?: string; prompt?: string };
  const cut = meta.cutout as { concept?: string; score?: number; latencyMs?: number } | null | undefined;
  const cutoutUrl = await versioned(job.dir, `${job.rel}/cutout.png`);
  const meshes = latestByFile(
    (meta.meshes ?? [])
      .map((m) => m as { file?: string; model?: string; resolution?: number | null; seed?: number; latencyMs?: number; bytes?: number; pose?: string })
      .filter((m) => typeof m.file === "string"),
  );
  return {
    id,
    subject: meta.subject ?? id,
    prompt: src.kind === "generated" && typeof src.prompt === "string" ? src.prompt : null,
    createdAt: createdAt(id),
    group,
    groupLabel: group ? groupLabel(group) : null,
    sourceUrl: (await versioned(job.dir, `${job.rel}/source.png`)) ?? meshFileUrl(`${job.rel}/source.png`),
    sourceNote:
      src.kind === "generated"
        ? `${src.model ?? "image model"} · seed ${src.seed ?? "?"}${src.latencyMs ? ` · ${(src.latencyMs / 1000).toFixed(1)}s` : ""}`
        : `uploaded${src.name ? ` · ${src.name}` : ""}`,
    cutoutUrl,
    concept: cut?.concept ?? null,
    kind: meta.kind === "person" ? "person" : "object",
    cutoutNote: cutoutUrl && cut ? `SAM 3 · "${cut.concept}" · score ${(cut.score ?? 0).toFixed(2)}${cut.latencyMs ? ` · ${(cut.latencyMs / 1000).toFixed(1)}s` : ""}` : null,
    meshes: (
      await Promise.all(
        meshes.map(async (m) => {
          const url = await versioned(job.dir, `${job.rel}/${m.file}`);
          const poseUrl = m.pose ? await versioned(job.dir, `${job.rel}/${m.pose}`) : null;
          return url
            ? { file: m.file!, url, model: m.model ?? "?", resolution: m.resolution ?? null, seed: m.seed ?? null, latencyMs: m.latencyMs ?? null, bytes: m.bytes ?? null, poseUrl }
            : null;
        }),
      )
    ).filter((m): m is NonNullable<typeof m> => !!m),
  };
}

/** Job ids start with a local timestamp: 20261006-204512-… */
function createdAt(id: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(id);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).toISOString() : null;
}

/**
 * The artifact's URL with its mtime as a version, or null if it is gone. A file
 * rewritten under the same name (a re-cut) gets a new URL, so no cache anywhere
 * can show the old one.
 */
async function versioned(dir: string, rel: string): Promise<string | null> {
  try {
    const st = await stat(path.join(dir, path.basename(rel)));
    return `${meshFileUrl(rel)}&v=${Math.round(st.mtimeMs)}`;
  } catch {
    return null;
  }
}
