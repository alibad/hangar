import fs from "fs";
import path from "path";

/**
 * The llm-stats.com leaderboard, pulled whole.
 *
 * config/model-meta.json used to link to this site under `_benchmarks` and stop
 * there — a link is an admission that the console cannot answer the question.
 * "Is gpt-5.6-terra actually better than the gpt-5.5 we route to, and at what
 * price?" is exactly the question the Models page exists for, and it was being
 * outsourced to a browser tab.
 *
 * ── Why scrape, and why this is not fragile in the usual way ─────────────────
 * There is no public API (every /api path 404s, and robots.txt disallows /api/
 * anyway; the homepage is explicitly allowed). The homepage is a Next.js App
 * Router page, so the full dataset ships INSIDE the HTML as an RSC flight
 * payload — `initialHomepageLLMModels`, 358 models at the time of writing, with
 * prices, benchmark scores, parameter counts and an is_open_source flag.
 *
 * That is a private key in someone else's markup and it can disappear without
 * notice. Three things keep that from being a problem:
 *   • every field is optional, and the UI degrades to "—" rather than breaking;
 *   • the last good pull is cached ON DISK, so a change upstream freezes the
 *     data rather than emptying it, and `fetchedAt` makes the freeze visible;
 *   • nothing here is load-bearing. Wiring, routing and fit all work with this
 *     module returning nothing at all — it adds judgment, it does not carry it.
 */

const CACHE_FILE = path.join(process.cwd(), "generated", "llm-stats.json");

/** One leaderboard row. Every field except the ids can be absent upstream. */
export type LlmStatsModel = {
  model_id: string;
  name: string;
  organization: string;
  organization_id: string;
  /** Graduate-level Q&A, 0-1. */
  gpqa_score: number | null;
  /** SWE-bench Verified, 0-1 — the one that tracks real coding work. */
  swe_bench_verified_score: number | null;
  /** Humanity's Last Exam, 0-1. */
  hle_score: number | null;
  /** Context window in tokens. */
  context: number | null;
  /** Total parameters. Present for most open-weights models, absent for closed. */
  param_count: number | null;
  /** USD per million input tokens. */
  input_price: number | null;
  output_price: number | null;
  /** Output tokens/sec. */
  throughput: number | null;
  is_open_source: boolean;
  announcement_date: string | null;
  release_date: string | null;
  arena_scores: Record<string, number> | null;
};

export type LlmStatsSnapshot = {
  fetchedAt: string;
  source: string;
  models: LlmStatsModel[];
  /** Set when the live pull failed and this is the last good copy from disk. */
  stale?: boolean;
  error?: string;
};

const SOURCE_URL = "https://llm-stats.com/";
/** The leaderboard moves on the timescale of model launches, not minutes. */
const TTL_MS = 12 * 60 * 60 * 1000;

let memo: LlmStatsSnapshot | null = null;

/**
 * Pull the RSC flight payload out of a Next.js App Router document.
 *
 * The page ships its data as a sequence of `self.__next_f.push([1,"…"])` calls
 * whose string arguments concatenate into one payload. Parsing each argument
 * with JSON.parse is what handles the escaping correctly — the naive approach
 * of stripping backslashes corrupts every embedded quote in the model names.
 */
function flightPayload(html: string): string {
  const re = /self\.__next_f\.push\(\[1,\s*("(?:[^"\\]|\\.)*")\]\)/g;
  const parts: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try {
      parts.push(JSON.parse(m[1]) as string);
    } catch {
      /* a chunk we cannot parse is a chunk we skip, not a failed pull */
    }
  }
  return parts.join("");
}

/**
 * Extract the array that follows `"<key>":` by walking brackets.
 *
 * A regex cannot do this: the array is ~400 KB of nested objects containing
 * strings with brackets in them. The string/escape tracking below is the whole
 * reason this is hand-written rather than a one-liner.
 */
function extractArray(payload: string, key: string): unknown[] | null {
  const at = payload.indexOf(`"${key}":`);
  if (at === -1) return null;
  const start = payload.indexOf("[", at);
  if (start === -1) return null;

  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < payload.length; i++) {
    const c = payload[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (inStr) { if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(payload.slice(start, i + 1)) as unknown[];
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function readCache(): LlmStatsSnapshot | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) as LlmStatsSnapshot;
    return Array.isArray(parsed?.models) ? parsed : null;
  } catch {
    return null;
  }
}

function writeCache(snap: LlmStatsSnapshot): void {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(snap));
  } catch {
    /* read-only FS — the in-memory copy still serves this process */
  }
}

/**
 * The leaderboard, from memory, then disk, then the network in that order.
 *
 * `force` skips the two caches. Nothing polls this: 1.6 MB of HTML per pull is
 * not something a dashboard should fetch on a timer, and the data changes when
 * a lab ships, not when the page refreshes.
 */
export async function getLlmStats(opts: { force?: boolean } = {}): Promise<LlmStatsSnapshot> {
  if (!opts.force) {
    if (memo && Date.now() - new Date(memo.fetchedAt).getTime() < TTL_MS) return memo;
    const disk = readCache();
    if (disk && Date.now() - new Date(disk.fetchedAt).getTime() < TTL_MS) {
      memo = disk;
      return disk;
    }
  }

  try {
    const res = await fetch(SOURCE_URL, {
      headers: {
        // Identify honestly. This is a once-every-twelve-hours read of a page
        // robots.txt allows; there is no reason to pretend to be a browser.
        "User-Agent": "Hangar/1.0 (local model dashboard; +https://github.com/alibad/betenshi-console)",
        Accept: "text/html",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`llm-stats.com returned ${res.status}`);
    const html = await res.text();

    const rows = extractArray(flightPayload(html), "initialHomepageLLMModels");
    if (!rows?.length) {
      throw new Error(
        "The leaderboard data was not found in the page. llm-stats.com has probably changed its markup — see src/lib/llm-stats.ts.",
      );
    }

    const models = rows
      .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
      .filter((r) => typeof r.model_id === "string")
      .map((r) => ({
        model_id: String(r.model_id),
        name: typeof r.name === "string" ? r.name : String(r.model_id),
        organization: typeof r.organization === "string" ? r.organization : "unknown",
        organization_id: typeof r.organization_id === "string" ? r.organization_id : "unknown",
        gpqa_score: num(r.gpqa_score),
        swe_bench_verified_score: num(r.swe_bench_verified_score),
        hle_score: num(r.hle_score),
        context: num(r.context),
        param_count: num(r.param_count),
        input_price: num(r.input_price),
        output_price: num(r.output_price),
        throughput: num(r.throughput),
        is_open_source: r.is_open_source === true,
        announcement_date: str(r.announcement_date),
        release_date: str(r.release_date),
        arena_scores:
          r.arena_scores && typeof r.arena_scores === "object"
            ? (r.arena_scores as Record<string, number>)
            : null,
      }));

    const snap: LlmStatsSnapshot = {
      fetchedAt: new Date().toISOString(),
      source: SOURCE_URL,
      models,
    };
    memo = snap;
    writeCache(snap);
    return snap;
  } catch (e) {
    // Serve the last good pull rather than nothing. A frozen leaderboard with a
    // visible date is useful; an empty one just looks broken.
    const disk = memo ?? readCache();
    const error = e instanceof Error ? e.message : String(e);
    if (disk) return { ...disk, stale: true, error };
    return { fetchedAt: new Date(0).toISOString(), source: SOURCE_URL, models: [], stale: true, error };
  }
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

/**
 * Index the leaderboard for lookup by a vendor's own model id.
 *
 * The join is not one-to-one and cannot be made so. llm-stats lists reasoning
 * variants the API does not expose as separate ids (gpt-5.1-high-2025-11-12),
 * and the API exposes snapshot ids the leaderboard folds together. So: exact id
 * first, then the id with its trailing date removed, then a prefix match. Each
 * step is a weaker claim than the last, which is why they are tried in that
 * order rather than all at once.
 */
export function indexByModelId(models: LlmStatsModel[]): Map<string, LlmStatsModel> {
  const out = new Map<string, LlmStatsModel>();
  for (const m of models) {
    const id = m.model_id.toLowerCase();
    out.set(id, m);
    const base = stripDate(id);
    if (!out.has(base)) out.set(base, m);
  }
  return out;
}

function stripDate(id: string): string {
  return id.replace(/-(\d{4}-\d{2}-\d{2}|\d{8})$/, "");
}

/** Best-effort lookup of one vendor model id against the leaderboard. */
export function lookup(index: Map<string, LlmStatsModel>, vendorModelId: string): LlmStatsModel | undefined {
  const id = vendorModelId.toLowerCase();
  const direct = index.get(id) ?? index.get(stripDate(id));
  if (direct) return direct;
  // Last resort: the leaderboard id is a prefix of the vendor id or vice versa,
  // which catches gpt-5.2 ↔ gpt-5.2-2025-12-11 style pairs the two steps above
  // miss. Longest match wins so gpt-5 does not swallow gpt-5.6.
  let best: LlmStatsModel | undefined;
  let bestLen = 0;
  for (const [key, model] of index) {
    if (key.length <= bestLen) continue;
    if (id.startsWith(`${key}-`) || key.startsWith(`${id}-`)) {
      best = model;
      bestLen = key.length;
    }
  }
  return best;
}
