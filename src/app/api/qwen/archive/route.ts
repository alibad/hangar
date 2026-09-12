import { NextRequest, NextResponse } from "next/server";
import { readdir, readFile, stat } from "fs/promises";
import path from "path";
import { archiveDir } from "@/lib/archive";

// The archive grows without bound (quote-forge's background runs mirror here too)
// and hydrating one image costs a sidecar read + a stat — so we never hydrate the
// whole set, we hydrate ONE PAGE. Listing filenames stays cheap (readdir only),
// which is what makes the full history reachable: `count` is the true total and
// any offset into it costs the same as the first page.
// rel starts with the date dir + a chronological stamp, so a lexical desc sort
// ≈ newest-first, letting us page before paying for any metadata.
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

async function walk(absDir: string, relDir: string, pngs: string[]) {
  let entries;
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const rel = relDir ? `${relDir}/${e.name}` : e.name;
    if (e.isDirectory()) await walk(path.join(absDir, e.name), rel, pngs);
    else if (e.name.toLowerCase().endsWith(".png")) pngs.push(rel);
  }
}

/**
 * Recover the source tag from the filename alone — the writer encodes it as
 * `{YYYYMMDD}-{HHMMSS}-{millis}-{source}-{kind}-{seed}-{slug}.png`. `kind` is a
 * known token, so everything between the 3-part stamp and it is the source
 * (which may itself contain hyphens, e.g. "quote-forge").
 *
 * Deriving this WITHOUT opening the sidecar is what lets the filter chips count
 * the whole archive and filter across every page while only ever hydrating one.
 */
function sourceFromName(file: string): string {
  const parts = file.replace(/\.png$/i, "").split("-");
  const kindAt = parts.findIndex((p, i) => i >= 3 && (p === "generate" || p === "edit"));
  if (kindAt <= 3) return parts.slice(3, Math.max(4, kindAt)).join("-") || "misc";
  return parts.slice(3, kindAt).join("-") || "misc";
}

/**
 * rel -> { model, source }, for filtering and counting across the WHOLE archive.
 *
 * SOURCE COMES FROM THE SIDECAR FIRST, filename second. The filename is only a
 * fallback for images whose sidecar is missing or predates the field — it is a
 * derived copy, and the sidecar is the record. Trusting the name meant a
 * corrected `source` showed on the image itself while the chips, counts and
 * filter still reported the old value, so a re-attributed image was invisible
 * under its own tag. Model was never in the filename at all.
 *
 * Reading every sidecar per request would undo the paging work, so this is built
 * once and reused, rebuilt only when the archive grows.
 */
type MetaIndex = { version: 2; size: number; byRel: Map<string, { model: string | null; source: string | null; at: number }> };
const g = globalThis as unknown as { __archiveMetaIndex?: MetaIndex };

async function metaIndex(dir: string, pngs: string[], rebuild = false) {
  // The cache turns over when the archive GROWS, which misses sidecars being
  // edited in place — exactly what a source backfill does. Re-attributing 1,700
  // images left the chips reporting the old tags until the count happened to
  // change. `?reindex=1` is the escape hatch; statting every sidecar on each
  // request would undo the paging this index exists to protect.
  if (!rebuild && g.__archiveMetaIndex?.version === 2 && g.__archiveMetaIndex.size === pngs.length) {
    return g.__archiveMetaIndex.byRel;
  }
  const prev = rebuild || g.__archiveMetaIndex?.version !== 2 ? undefined : g.__archiveMetaIndex?.byRel;
  const byRel: MetaIndex["byRel"] = new Map();
  const CHUNK = 200; // bounded concurrency — this can be thousands of files
  for (let i = 0; i < pngs.length; i += CHUNK) {
    await Promise.all(
      pngs.slice(i, i + CHUNK).map(async (rel) => {
        const cached = prev?.get(rel);
        if (cached) { byRel.set(rel, cached); return; } // reuse
        try {
          const meta = JSON.parse(
            await readFile(path.join(dir, rel.replace(/\.png$/i, ".json")), "utf8"),
          );
          byRel.set(rel, {
            model: typeof meta.model === "string" ? meta.model : null,
            source: typeof meta.source === "string" && meta.source ? meta.source : null,
            at: Date.parse(meta.savedAt) || 0,
          });
        } catch {
          byRel.set(rel, { model: null, source: null, at: 0 });
        }
      }),
    );
  }
  g.__archiveMetaIndex = { version: 2, size: pngs.length, byRel };
  return byRel;
}

const UNTAGGED = "untagged";

// Read-only firehose: every image the Qwen server has produced, from any caller,
// newest first, tagged by source. Distinct from /api/qwen/images (the curated
// Studio) — this reads the archive dir the server mirrors into.
export async function GET(req: NextRequest) {
  const dir = archiveDir();
  const all: string[] = [];
  await walk(dir, "", all);

  all.sort((a, b) => b.localeCompare(a)); // newest first (date + stamp are chronological)

  const sp = req.nextUrl.searchParams;
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(sp.get("limit")) || DEFAULT_LIMIT));
  const source = sp.get("source");
  const model = sp.get("model");

  // Whole-archive facts, so the chips describe everything rather than one page.
  // Source resolves sidecar-first: a re-attributed image must appear under its
  // corrected tag here too, not just on the image itself.
  const meta = await metaIndex(dir, all, sp.get("reindex") === "1");
  // Native Qwen writes local timestamps; the console writes ISO UTC. Compare
  // instants rather than raw strings, before paging as well as within a page.
  all.sort((a, b) => (meta.get(b)?.at || 0) - (meta.get(a)?.at || 0) || b.localeCompare(a));
  const counts: Record<string, number> = {};
  const modelCounts: Record<string, number> = {};
  const srcOf = new Map<string, string>();
  const modelOf = new Map<string, string | null>();
  for (const rel of all) {
    const entry = meta.get(rel);
    const s = entry?.source ?? sourceFromName(rel.slice(rel.lastIndexOf("/") + 1));
    srcOf.set(rel, s);
    counts[s] = (counts[s] ?? 0) + 1;
    const m = entry?.model ?? null;
    modelOf.set(rel, m);
    modelCounts[m ?? UNTAGGED] = (modelCounts[m ?? UNTAGGED] ?? 0) + 1;
  }

  // Filter across the FULL archive before paging, so "quote-forge" reaches its
  // oldest image instead of only the ones that happened to land on this page.
  let pngs = source && source !== "all" ? all.filter((r) => srcOf.get(r) === source) : all;
  if (model && model !== "all") {
    pngs = pngs.filter((r) => (modelOf.get(r) ?? UNTAGGED) === model);
  }
  const offset = Math.max(0, Math.min(Number(sp.get("offset")) || 0, Math.max(0, pngs.length)));
  const shown = pngs.slice(offset, offset + limit);

  const images = await Promise.all(
    shown.map(async (rel) => {
      const file = rel.includes("/") ? rel.slice(rel.lastIndexOf("/") + 1) : rel;
      let meta: Record<string, unknown> = {};
      try {
        meta = JSON.parse(await readFile(path.join(dir, rel.replace(/\.png$/i, ".json")), "utf8"));
      } catch {
        /* no sidecar yet (server writes png then json) — degrade gracefully */
      }
      let bytes = meta.bytes as number | undefined;
      let savedAt = meta.savedAt as string | undefined;
      try {
        const s = await stat(path.join(dir, rel));
        bytes = bytes ?? s.size;
        if (!savedAt) savedAt = s.mtime.toISOString();
      } catch {
        /* ignore */
      }
      return {
        rel,
        file,
        url: `/api/qwen/archive/file?rel=${encodeURIComponent(rel)}`,
        source: (meta.source as string) ?? srcOf.get(rel) ?? "misc",
        kind: (meta.kind as string) ?? "generate",
        prompt: (meta.prompt as string) ?? "",
        seed: meta.seed as number | undefined,
        width: meta.width as number | undefined,
        height: meta.height as number | undefined,
        steps: meta.steps as number | undefined,
        cfg: meta.cfg as number | undefined,
        ms: meta.ms as number | undefined,
        inputCount: meta.inputCount as number | undefined,
        // Which model produced this. Absent on images generated before model
        // tagging existed — the UI shows nothing rather than guessing.
        model: meta.model as string | undefined,
        via: meta.via as string | undefined,
        modelRevision: meta.model_revision as string | undefined,
        modelParams: meta.model_params as string | undefined,
        modelParamsTotal: meta.model_params_total as string | undefined,
        savedAt,
        bytes,
      };
    }),
  );

  images.sort((a, b) => (Date.parse(b.savedAt ?? "") || 0) - (Date.parse(a.savedAt ?? "") || 0) || b.rel.localeCompare(a.rel));
  const sources = Object.keys(counts).sort();
  const models = Object.keys(modelCounts).sort();
  return NextResponse.json({
    images,
    sources,
    counts,              // whole-archive tally per source (not just this page)
    models,
    modelCounts,         // whole-archive tally per model
    dir,
    total: all.length,   // every image on disk
    count: pngs.length,  // matching the active source filter
    offset,
    limit,
    shown: images.length,
    hasMore: offset + images.length < pngs.length,
  });
}
