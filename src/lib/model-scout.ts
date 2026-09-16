import fs from "fs";
import path from "path";
import { CAPABILITIES, getCatalogue, getRouting, type CatalogModel } from "./providers";
import { installedRepos, listDownloads, type DownloadJob, type InstalledRepo } from "./hf-download";
import { readMachineProfile, readOccupants, readKnownMachines } from "./machine";
import {
  evaluateFit,
  estimateFromParams,
  bestPrecisionFor,
  VERDICT_RANK,
  type Fit,
  type Requirement,
  type ParamSpec,
  type PrecisionFit,
  type Runtime,
  type KnownMachine,
} from "./model-fit";
import { listWired, handWrittenAliases, WIRABLE_PROVIDERS } from "./wired-models";
import { getLlmStats, indexByModelId, lookup, type LlmStatsModel } from "./llm-stats";

/**
 * The Models page's answer to "what am I missing?"
 *
 * Two halves, kept deliberately separate because they have different failure
 * modes and different refresh rates:
 *
 *  1. DISCOVERY — facts, pulled live from each vendor's own model-list endpoint.
 *     Nothing is inferred about quality or price; the only claims made are "this
 *     id exists", "it shipped on this date", and "you have not wired it". A
 *     model list cannot hallucinate, which is why this half runs on a timer and
 *     needs no review.
 *
 *  2. THE SCOUT REPORT — judgment, written weekly by a Claude routine into
 *     config/model-scout.json (see docs/models.md). Which local checkpoint
 *     is worth 20 GB of download, what a candidate actually needs to run, what it
 *     would replace. This half is reviewable, versioned in git, and carries a
 *     date so a stale opinion is visible as stale rather than silently trusted.
 *
 * Fit verdicts are computed HERE, at read time, against the live machine — never
 * baked into the report. A verdict written a week ago describes a machine that
 * had different services running and a different amount of free disk.
 */

const REPORT_FILE = path.join(process.cwd(), "config", "model-scout.json");

// ── the weekly report ───────────────────────────────────────────────────────

export type ScoutCandidate = {
  id: string;
  name: string;
  kind: "local" | "cloud";
  /** Which CAPABILITIES id this would serve. */
  capability: string;
  /** Why it is on the list at all — one sentence, comparative. */
  why: string;
  checkpoint?: string;
  provider?: string;
  /** For cloud candidates: the litellm target, ready to wire. */
  target?: string;
  mode?: string;
  params?: string;
  released?: string;
  license?: string;
  docs?: string;
  paper?: string;
  /** Sourced requirement. Preferred over `spec` whenever the authors published one. */
  requirement?: Requirement;
  /** Fallback: enough to estimate a requirement when nobody published one. */
  spec?: ParamSpec;
  /**
   * Runtimes these weights can execute on, when the checkpoint is tied to one
   * stack. Omit for portable weights, which is most of them — absent means
   * "runs anywhere", not "unknown".
   *
   * Sits on the candidate rather than inside `requirement` because it is a
   * property of the checkpoint, not of its memory cost, and because a candidate
   * that gives `spec` instead of `requirement` still needs to declare it.
   */
  runtimes?: Runtime[];
  /** Cloud pricing, as the report found it. */
  pricing?: { inPerMTok?: number; outPerMTok?: number; perImage?: number };
};

export type ScoutUpgrade = {
  alias: string;
  from: string;
  to: string;
  why: string;
};

export type ScoutReport = {
  generatedAt?: string;
  generatedBy?: string;
  candidates: ScoutCandidate[];
  upgrades: ScoutUpgrade[];
  notes: string[];
};

export function loadReport(): ScoutReport {
  try {
    const parsed = JSON.parse(fs.readFileSync(REPORT_FILE, "utf8"));
    return {
      generatedAt: typeof parsed?.generatedAt === "string" ? parsed.generatedAt : undefined,
      generatedBy: typeof parsed?.generatedBy === "string" ? parsed.generatedBy : undefined,
      candidates: Array.isArray(parsed?.candidates) ? parsed.candidates : [],
      upgrades: Array.isArray(parsed?.upgrades) ? parsed.upgrades : [],
      notes: Array.isArray(parsed?.notes) ? parsed.notes : [],
    };
  } catch {
    return { candidates: [], upgrades: [], notes: [] };
  }
}

// ── live discovery ──────────────────────────────────────────────────────────

export type DiscoveredModel = {
  provider: string;
  /** Vendor's own id, e.g. "gpt-5.6-terra". */
  modelId: string;
  /** Ready-to-wire litellm target, e.g. "openai/gpt-5.6-terra". */
  target: string;
  mode: string;
  /** ISO date, when the vendor publishes one. */
  released?: string;
  /** Already reachable through the router under this alias. */
  wiredAs?: string;
  /**
   * Same family as something already wired, but a later version — the strongest
   * signal in this list, and the one worth acting on first. Heuristic; see
   * familyKey().
   */
  supersedes?: string;
  /** Shipped after the newest model wired for this provider. */
  newerThanWired: boolean;
  /** Leaderboard row, when llm-stats.com has one for this id. */
  stats?: LlmStatsModel;
};

export type ProviderDiscovery = {
  provider: string;
  keyEnv: string;
  /** false when the key is absent — nothing was asked, nothing is claimed. */
  reachable: boolean;
  error?: string;
  models: DiscoveredModel[];
};

/**
 * Vendors publish long back-catalogues. Anything this old is not a candidate for
 * a box that already runs a current model, and listing it buries the two or
 * three ids that actually matter.
 */
const DISCOVERY_HORIZON_DAYS = 400;

/**
 * How recent a model in an unwired family has to be to surface on its own merit,
 * regardless of what is already wired. One quarter: long enough that a launch
 * cannot be missed between two visits to this page, short enough that a vendor's
 * back catalogue stays out.
 */
const NEW_FAMILY_WINDOW_DAYS = 120;

/** Modes the router can serve. Everything else is filtered out of discovery. */
const KEEP_MODES = new Set(["chat", "image_generation", "audio_transcription", "audio_speech"]);

/**
 * What a vendor id is for, read off the id itself.
 *
 * Order matters: "gpt-4o-mini-tts" is a speech model that also matches nothing
 * else, but "gpt-image-1" would fall through to chat if image were not tested
 * first. Returns null for ids the router has no mode for — embeddings,
 * moderation, realtime sockets, video — which is how they get dropped.
 */
function modeFromId(id: string): string | null {
  const s = id.toLowerCase();
  if (/embed|moderation|deep-research|search-api|search-preview/.test(s)) return null;
  if (/realtime|live|native-audio|bidi/.test(s)) return null;      // websocket APIs, not OpenAI-compatible REST
  if (/^(veo|sora|lyria)|video|robotics|computer-use|antigravity/.test(s)) return null;
  if (/-tts|tts-|text-to-speech/.test(s)) return "audio_speech";
  if (/transcribe|whisper/.test(s)) return "audio_transcription";
  if (/image|nano-banana/.test(s)) return "image_generation";
  if (/audio/.test(s)) return null;                                 // gpt-audio is a realtime family
  return "chat";
}

async function discoverOpenAI(key: string): Promise<DiscoveredModel[]> {
  const res = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`OpenAI /v1/models returned ${res.status}`);
  const body = await res.json();
  const rows: { id: string; created?: number }[] = Array.isArray(body?.data) ? body.data : [];
  return rows.flatMap((m) => {
    const mode = modeFromId(m.id);
    if (!mode) return [];
    return [{
      provider: "openai",
      modelId: m.id,
      target: `openai/${m.id}`,
      mode,
      released: m.created ? new Date(m.created * 1000).toISOString().slice(0, 10) : undefined,
      newerThanWired: false,
    }];
  });
}

async function discoverAnthropic(key: string): Promise<DiscoveredModel[]> {
  const res = await fetch("https://api.anthropic.com/v1/models?limit=100", {
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Anthropic /v1/models returned ${res.status}`);
  const body = await res.json();
  const rows: { id: string; created_at?: string }[] = Array.isArray(body?.data) ? body.data : [];
  return rows.map((m) => ({
    provider: "anthropic",
    modelId: m.id,
    target: `anthropic/${m.id}`,
    mode: "chat",
    released: m.created_at ? m.created_at.slice(0, 10) : undefined,
    newerThanWired: false,
  }));
}

/**
 * Gemini is the one vendor that publishes no release date, so `released` stays
 * absent rather than being back-filled from a version number. It also lists
 * models by what they can DO, which is more reliable than the id — a model with
 * only `bidiGenerateContent` is a websocket API the router cannot front, whatever
 * its name suggests.
 */
async function discoverGemini(key: string): Promise<DiscoveredModel[]> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(key)}`,
    { signal: AbortSignal.timeout(15000) },
  );
  if (!res.ok) throw new Error(`Gemini ListModels returned ${res.status}`);
  const body = await res.json();
  const rows: { name?: string; supportedGenerationMethods?: string[] }[] = Array.isArray(body?.models)
    ? body.models
    : [];
  return rows.flatMap((m) => {
    const id = String(m.name ?? "").replace(/^models\//, "");
    if (!id) return [];
    const methods = m.supportedGenerationMethods ?? [];
    if (!methods.includes("generateContent")) return [];
    const mode = modeFromId(id);
    if (!mode) return [];
    return [{ provider: "gemini", modelId: id, target: `gemini/${id}`, mode, newerThanWired: false }];
  });
}

/**
 * A trailing snapshot date, which every vendor bolts onto a stable id.
 *
 * gpt-5.5 and gpt-5.5-2026-04-23 are one model listed twice, as are
 * claude-haiku-4-5 and claude-haiku-4-5-20251001 — and the router wires the
 * stable form. Without collapsing these, a third of the "not wired" list was
 * models that are wired, under the name their vendor happens to also publish.
 */
const DATE_SUFFIX_RE = /-(\d{4}-\d{2}-\d{2}|\d{8})$/;

/**
 * The id with its snapshot date and `-preview` marker removed.
 *
 * `-preview` matters for the same reason the date does: Google lists
 * gemini-3-pro-image and gemini-3-pro-image-preview separately, and the router
 * wires one of them. Treating a model's preview as a different model produced a
 * "not wired" row for something already in use, next to the thing itself.
 */
function baseId(modelId: string): string {
  return modelId.replace(DATE_SUFFIX_RE, "").replace(/-preview$/, "");
}

/**
 * Strip version-ish tokens to get a family name.
 *
 * A HEURISTIC, and only ever used to sort a suggestion higher — never to change
 * a route. It reads claude-opus-4-8 and claude-opus-5 as the same family, which
 * is the case worth catching. It reads gpt-5.5 and gpt-5.6-terra as different
 * families, which is wrong, and gpt-4o-transcribe and gpt-transcribe likewise:
 * OpenAI's naming carries meaning in tokens that look like words. Those cases
 * still surface under `newerThanWired`, just without the stronger label. Sorting
 * out which new model actually replaces which is the weekly report's job.
 */
function familyKey(modelId: string): string {
  return baseId(modelId)
    .toLowerCase()
    .split(/[-_]/)
    .filter((t) => t && !/^v?\d+(\.\d+)*$/.test(t))
    .join("-");
}

/**
 * Version numbers, flattened for comparison: claude-opus-4-8 -> [4, 8],
 * gemini-3.7-flash -> [3, 7].
 *
 * Needed because Gemini publishes no release dates at all. Without this, the
 * date test below passed vacuously and the wired gemini-3.6-flash was reported
 * as superseded by gemini-2.5-flash — advice that is not merely useless but
 * backwards.
 */
function versionVector(modelId: string): number[] {
  return baseId(modelId)
    .toLowerCase()
    .split(/[-_]/)
    .filter((t) => /^\d+(\.\d+)*$/.test(t))
    .flatMap((t) => t.split(".").map(Number));
}

/** Strictly later than `other`, by version number. Ties and blanks are not. */
function versionNewerThan(id: string, other: string): boolean {
  const a = versionVector(id);
  const b = versionVector(other);
  if (!a.length || !b.length) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

let discoveryCache: { at: number; value: ProviderDiscovery[] } | null = null;
/** Vendors ship weekly at best; the page polls every 10s. Do not ask them that often. */
const DISCOVERY_TTL_MS = 15 * 60 * 1000;

/**
 * Every model each configured vendor will sell us, minus the ones already wired.
 *
 * A provider whose key is absent reports `reachable: false` and an empty list —
 * the same discipline getCatalogue() follows for a missing key. Listing nothing
 * and claiming nothing is the honest outcome; pretending the vendor has no new
 * models would not be.
 */
export async function discover(opts: { force?: boolean } = {}): Promise<ProviderDiscovery[]> {
  if (!opts.force && discoveryCache && Date.now() - discoveryCache.at < DISCOVERY_TTL_MS) {
    return discoveryCache.value;
  }

  // What the router serves today, so discovery can mark what is already wired.
  const wiredTargets = new Map<string, string>();  // target -> alias
  try {
    const { models } = await getCatalogue();
    for (const m of models) if (!m.local) wiredTargets.set(m.target, m.id);
  } catch {
    /* router down — everything simply reads as unwired */
  }

  const fetchers: Record<string, (key: string) => Promise<DiscoveredModel[]>> = {
    openai: discoverOpenAI,
    anthropic: discoverAnthropic,
    gemini: discoverGemini,
  };

  const horizon = Date.now() - DISCOVERY_HORIZON_DAYS * 86400_000;

  const out = await Promise.all(
    Object.entries(WIRABLE_PROVIDERS).map(async ([provider, keyEnv]): Promise<ProviderDiscovery> => {
      const key = process.env[keyEnv];
      if (!key) {
        return { provider, keyEnv, reachable: false, error: `${keyEnv} is not set.`, models: [] };
      }
      let models: DiscoveredModel[];
      try {
        models = await fetchers[provider](key);
      } catch (e) {
        return {
          provider,
          keyEnv,
          reachable: false,
          error: e instanceof Error ? e.message : String(e),
          models: [],
        };
      }

      // Match on the DATED-SUFFIX-STRIPPED id, so a vendor listing both
      // gpt-5.5 and gpt-5.5-2026-04-23 does not report the wired one as missing.
      const wiredBaseIds = new Map<string, string>();  // baseId -> alias
      for (const [target, alias] of wiredTargets) {
        if (!target.startsWith(`${provider}/`)) continue;
        wiredBaseIds.set(baseId(target.split("/").slice(1).join("/")), alias);
      }

      for (const m of models) {
        m.wiredAs = wiredTargets.get(m.target) ?? wiredBaseIds.get(baseId(m.modelId));
        if (!KEEP_MODES.has(m.mode)) m.mode = "chat";
      }

      const wiredHere = models.filter((m) => m.wiredAs);
      const newestWired = wiredHere
        .map((m) => m.released)
        .filter((d): d is string => !!d)
        .sort()
        .at(-1);
      const wiredFamilies = new Map<string, DiscoveredModel>();
      for (const m of wiredHere) wiredFamilies.set(familyKey(m.modelId), m);

      // Highest version number wired FOR EACH MODE, which is the only recency
      // signal Gemini gives us — it publishes no dates at all, so without this
      // its entire back catalogue read as "new". Per mode, not per provider:
      // the image line and the chat line version independently, and comparing
      // gemini-3.1-pro-preview against the flash line's 3.6 would bury it.
      const versionFloor = new Map<string, number[]>();
      for (const m of wiredHere) {
        const v = versionVector(m.modelId);
        if (!v.length) continue;
        const held = versionFloor.get(m.mode);
        if (!held || versionNewerThan(m.modelId, held.join("."))) versionFloor.set(m.mode, v);
      }

      // One row per model, preferring the stable id over its dated twin — the
      // stable one is what you would wire, and the one whose name stays valid.
      const byBase = new Map<string, DiscoveredModel>();
      for (const m of models) {
        if (m.wiredAs) continue;
        const key = baseId(m.modelId);
        const held = byBase.get(key);
        if (!held || m.modelId.length < held.modelId.length) byBase.set(key, m);
      }

      const fresh: DiscoveredModel[] = [];
      for (const m of byBase.values()) {
        // Below the version already wired for this mode, so it is history
        // whatever else is true of it. A model carrying no version number at all
        // (gemini-flash-latest, gpt-transcribe) is not judged here — there is
        // nothing to compare, and dropping it would hide the moving aliases.
        const floor = versionFloor.get(m.mode);
        if (floor && versionVector(m.modelId).length && versionNewerThan(floor.join("."), m.modelId)) {
          continue;
        }

        const sibling = wiredFamilies.get(familyKey(m.modelId));
        if (sibling) {
          // Same family as something wired. Keep it only if it is genuinely
          // LATER — otherwise this is the vendor's back catalogue, and listing
          // it as "not wired" invites a downgrade.
          const later = sibling.released && m.released
            ? m.released > sibling.released
            : versionNewerThan(m.modelId, sibling.modelId);
          if (!later) continue;
          m.supersedes = sibling.wiredAs;
        } else if (newestWired && m.released) {
          // A family nothing here uses. Two ways to earn a place: it shipped no
          // earlier than the newest model already wired for this provider, or
          // it is simply recent.
          //
          // The second clause is not redundant. Without it, wiring one new model
          // silently buried every OTHER new family behind it — wiring
          // claude-opus-5 (2026-07-24) hid claude-fable-5 (2026-06-07), which is
          // a distinct tier rather than an older version of anything here. The
          // date bar is meant to cut back-catalogue (gpt-5-mini, a year old),
          // not to cut this quarter's launches.
          const recent = new Date(m.released).getTime() >= Date.now() - NEW_FAMILY_WINDOW_DAYS * 86400_000;
          if (m.released < newestWired && !recent) continue;
          m.newerThanWired = m.released > newestWired;
        } else if (m.released && new Date(m.released).getTime() < horizon) {
          // No wired model to compare against (a provider wired for nothing
          // yet), so fall back to a plain recency cut.
          continue;
        }
        fresh.push(m);
      }

      fresh.sort((a, b) => {
        if (!!a.supersedes !== !!b.supersedes) return a.supersedes ? -1 : 1;
        return (b.released ?? "").localeCompare(a.released ?? "");
      });

      return { provider, keyEnv, reachable: true, models: fresh };
    }),
  );

  discoveryCache = { at: Date.now(), value: out };
  return out;
}

// ── open-weights catalogue, fitted to this card ─────────────────────────────

export type OpenWeightsCandidate = {
  stats: LlmStatsModel;
  /** Billions, from param_count. The whole reason this list can be fitted at all. */
  paramsB: number;
  /** Best precision that runs here, or null when nothing on the ladder does. */
  best: PrecisionFit | null;
  /** Every rung, so the UI can show what fitting cost in quality. */
  rungs: PrecisionFit[];
  /** Has at least one benchmark score. Drives which ranking bucket it lands in. */
  scored: boolean;
  /**
   * What each OTHER host would say — and only where it says something
   * different.
   *
   * Deliberately a summary rather than a second full ladder. The live machine
   * carries all six rungs because the details panel shows what fitting cost in
   * quality; another host only needs to answer "and over there?", so it carries
   * the chosen rung and nothing else. Two hundred models times six rungs times
   * a full Fit each is a payload nobody reads.
   *
   * Empty when every host agrees, which keeps the column quiet unless it has
   * something to say.
   */
  elsewhere: HostBest[];
};

/** One other machine's answer for a model, compactly. */
export type HostBest = {
  hostId: string;
  hostName: string;
  verdict: Fit["verdict"];
  /** The rung that machine would run it at. Absent when none does. */
  label?: string;
  vramGb?: number;
};

/**
 * Every open-weights model on the leaderboard, sorted by what this box can
 * actually run.
 *
 * This is the half of the leaderboard the console can act on in a way no cloud
 * dashboard can: llm-stats publishes `param_count` for open models, and a
 * parameter count plus a 32 GB card is enough to answer "could I run this, and
 * at what quantisation" for all ~200 of them at once. Sorted by capability
 * WITHIN what fits, not by capability overall — a 2.4T model topping the chart
 * is not information, it is noise, on a machine that cannot load it.
 *
 * Models with no `param_count` are dropped rather than guessed at. An unfitted
 * row in a list whose entire purpose is fit would be worse than absent.
 */
export function openWeightsCandidates(
  models: LlmStatsModel[],
  machine: Awaited<ReturnType<typeof readMachineProfile>>,
  occupants: Awaited<ReturnType<typeof readOccupants>>,
  others: KnownMachine[] = [],
): OpenWeightsCandidate[] {
  // Scaled against the WHOLE leaderboard, not just the open-weights subset —
  // "good" should mean the same thing here as it does for the cloud models on
  // the same page.
  const scales = buildQualityScales(models);
  const out: OpenWeightsCandidate[] = [];
  for (const stats of models) {
    if (!stats.is_open_source || !stats.param_count) continue;
    const paramsB = stats.param_count / 1e9;
    // Context drives the KV cache, and the KV cache is what turns a model that
    // fits into one that doesn't. 32k is the working default on this box (see
    // local-coder's launch flags); a model advertising less gets judged at what
    // it actually offers rather than at a number it cannot reach.
    const contextK = stats.context ? Math.min(32, Math.round(stats.context / 1000)) : 32;
    const { best, rungs } = bestPrecisionFor({ paramsB, machine, contextK, occupants });

    // Each other host answers the same question against its own ladder — a
    // Metal machine is not offered NVFP4, and a bigger pool reaches a better
    // rung. Kept only when the answer differs, so the column stays silent
    // where the two machines agree, which is most of the time.
    const here = best?.fit.verdict ?? "no";
    const elsewhere: HostBest[] = [];
    for (const m of others) {
      const alt = bestPrecisionFor({ paramsB, machine: m.machine, contextK, occupants: m.occupants });
      const verdict = alt.best?.fit.verdict ?? "no";
      if (verdict === here && alt.best?.label === best?.label) continue;
      elsewhere.push({
        hostId: m.hostId,
        hostName: m.hostName,
        verdict,
        label: alt.best?.label,
        vramGb: alt.best?.requirement.vramGb,
      });
    }

    out.push({ stats, paramsB, best, rungs, scored: quality(stats, scales) > 0, elsewhere });
  }

  /**
   * Ranked the way the question is actually asked: "what is the BEST model this
   * card can run", not "what is the smallest".
   *
   * Sorting by fit verdict first put qwen3.5-0.8b, which fits trivially and
   * scores 0.119 on GPQA, above qwen3-vl-32b-thinking at 0.731 — the exact
   * inversion of what the list is for. Runnable-vs-not stays the hard gate,
   * because an unrunnable model is not a choice; within runnable, quality leads
   * and the verdict is only a tiebreak.
   *
   * Unscored models are a third bucket rather than a zero score. The newest
   * checkpoints have no benchmark numbers yet — that is what makes them new, and
   * scoring them zero would bury the very models worth knowing about beneath a
   * two-year-old 1B that happens to have a GPQA entry.
   */
  const bucket = (c: OpenWeightsCandidate) => (!c.best ? 2 : c.scored ? 0 : 1);
  return out.sort((a, b) => {
    const ba = bucket(a);
    const bb = bucket(b);
    if (ba !== bb) return ba - bb;
    if (ba === 1) {
      // Unscored and runnable: newest first, since recency is the only signal
      // available and it is the one that matters for a model with no numbers.
      return (b.stats.release_date ?? "").localeCompare(a.stats.release_date ?? "");
    }
    const qa = quality(a.stats, scales);
    const qb = quality(b.stats, scales);
    if (qa !== qb) return qb - qa;
    const ra = a.best ? VERDICT_RANK[a.best.fit.verdict] : 99;
    const rb = b.best ? VERDICT_RANK[b.best.fit.verdict] : 99;
    if (ra !== rb) return ra - rb;
    return (b.stats.release_date ?? "").localeCompare(a.stats.release_date ?? "");
  });
}

/** The metrics that feed the ranking, in the order they are read off a row. */
const METRICS: ((m: LlmStatsModel) => number | null)[] = [
  (m) => m.gpqa_score,
  (m) => m.swe_bench_verified_score,
  (m) => m.hle_score,
  (m) => {
    const a = m.arena_scores ? Object.values(m.arena_scores) : [];
    return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  },
];

/** Sorted observed values per metric, for percentile lookup. */
type QualityScales = number[][];

/**
 * Per-benchmark distributions across the whole leaderboard.
 *
 * The benchmarks are not on one scale and their coverage is patchy, which makes
 * naive averaging wrong in two separate ways. Raw averaging punishes documented
 * models: HLE tops out near 0.65 where GPQA reaches 0.89, so a model with GPQA
 * 0.855 AND an HLE score averaged below one with GPQA 0.817 and nothing else.
 * Min-max normalising fixes the scale but not the coverage — a model with a
 * mediocre HLE still pays a penalty that a model with no HLE at all escapes.
 *
 * Percentile ranks fix the scale (and are robust to the outliers a min-max is
 * not); imputing a missing metric at the median fixes the coverage, because "no
 * score" then means "no information" rather than "free pass".
 */
function buildQualityScales(models: LlmStatsModel[]): QualityScales {
  return METRICS.map((read) => {
    const values: number[] = [];
    for (const m of models) {
      const v = read(m);
      if (typeof v === "number") values.push(v);
    }
    return values.sort((a, b) => a - b);
  });
}

/** Share of observed values at or below `v`, in 0-1. */
function percentile(sorted: number[], v: number): number {
  if (sorted.length < 2) return 0.5;
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo / sorted.length;
}

/**
 * One number for "how good is this", with benchmark coverage made neutral.
 *
 * Never shown as a score — it only decides row order among models that already
 * fit. A composite of four benchmarks with this much missing data is not a
 * number to put in front of a reader; the row shows the underlying scores
 * instead, so the ordering can be checked against them.
 */
function quality(m: LlmStatsModel, scales?: QualityScales): number {
  if (!scales) return 0;
  let sum = 0;
  let seen = 0;
  METRICS.forEach((read, i) => {
    const v = read(m);
    if (typeof v !== "number") {
      sum += 0.5;             // median — this benchmark says nothing either way
      return;
    }
    seen++;
    sum += percentile(scales[i], v);
  });
  // Zero means "no benchmark at all", which the caller reads as unscored and
  // routes into its own bucket rather than ranking against measured models.
  return seen ? sum / METRICS.length : 0;
}

// ── the merged view ─────────────────────────────────────────────────────────

export type ScoutCandidateWithFit = ScoutCandidate & {
  /** Against the machine this console is running on, with what is up right now. */
  fit: Fit;
  /**
   * The same candidate judged against every OTHER host the console knows,
   * from their declared specs — idle, and with unknown disk.
   *
   * This is the comparison the report could never make and the leaderboard
   * structurally cannot: the answer to "can I run this" stopped being one
   * answer the moment there were two machines, and for a good number of models
   * the two answers differ. Empty when only one host is configured.
   */
  elsewhere: MachineVerdict[];
  /** Already reachable through the router, so this is informational only. */
  alreadyWired?: string;
};

export type MachineVerdict = {
  hostId: string;
  hostName: string;
  /** False when the numbers are declared in config rather than measured. */
  live: boolean;
  fit: Fit;
};

export type ScoutPayload = {
  machine: Awaited<ReturnType<typeof readMachineProfile>>;
  occupants: Awaited<ReturnType<typeof readOccupants>>;
  /**
   * Every machine the console can answer for, live one first. Carried so the UI
   * can label a second verdict with the host it belongs to and say plainly that
   * its numbers are declared rather than measured.
   */
  machines: KnownMachine[];
  report: {
    generatedAt?: string;
    generatedBy?: string;
    /** Days since the weekly routine last wrote the file. */
    ageDays?: number;
    stale: boolean;
    notes: string[];
    upgrades: ScoutUpgrade[];
  };
  /**
   * The weekly report's hand-picked models, each with a verdict per machine.
   *
   * These are the most considered items on the page — four models a routine
   * argued for in prose, against everything already installed — and for a long
   * time the console shipped them to the browser and drew only the notes.
   */
  candidates: ScoutCandidateWithFit[];
  discovery: ProviderDiscovery[];
  wired: ReturnType<typeof listWired>;
  handWritten: string[];
  leaderboard: {
    fetchedAt: string;
    source: string;
    stale?: boolean;
    error?: string;
    total: number;
    /** Open-weights models with a parameter count, fitted to this card. */
    openWeights: OpenWeightsCandidate[];
    /** How many of those actually run here, for the headline. */
    runnable: number;
    /** The same count per machine, live host first. */
    runnableByHost: { hostId: string; hostName: string; live: boolean; runnable: number }[];
  };
  /**
   * Everything the router serves today, plus what each capability is routed to.
   *
   * Carried here so the Models page can be ONE fetch. It used to be a second
   * call to /api/providers, which meant the page could render a model as
   * "active for text" in one panel while another panel, a beat behind, showed a
   * different winner.
   */
  routerUp: boolean;
  /**
   * `stats` is joined on here too, not only onto unwired discoveries. Without
   * it a model showed benchmarks and throughput right up until you wired it,
   * at which point the columns went blank — the act of adopting a model made
   * the page know less about it.
   */
  catalogue: (CatalogModel & { stats?: LlmStatsModel })[];
  routing: Record<string, string>;
  capabilities: { id: string; label: string; modes: readonly string[]; hint: string }[];
  downloads: DownloadJob[];
  /** Repos already under HF_HOME — the definitive "do I have this" list. */
  installed: InstalledRepo[];
};

/** A report older than this is shown as stale — the routine runs weekly. */
const STALE_AFTER_DAYS = 10;

/**
 * One candidate's requirement, as THIS machine would pay it.
 *
 * Two things are machine-dependent and neither is visible in the report's JSON.
 * A `spec` has to be re-estimated per host, because a diffusion model's
 * CPU-offload charge is real on a discrete card and a double-count on unified
 * memory. And `runtimes` lives on the candidate rather than inside the
 * requirement, so it is folded in here — which also means a report that gives
 * `spec` instead of `requirement` still gets its runtime enforced.
 */
function requirementFor(c: ScoutCandidate, memoryModel: "discrete" | "unified"): Requirement {
  const base: Requirement =
    c.requirement ?? (c.spec ? estimateFromParams({ ...c.spec, memoryModel }) : {});
  return c.runtimes?.length ? { ...base, runtimes: c.runtimes } : base;
}

export async function getScout(opts: { force?: boolean } = {}): Promise<ScoutPayload> {
  const report = loadReport();
  const [known, discovery, stats] = await Promise.all([
    readKnownMachines(),
    discover(opts),
    getLlmStats(opts),
  ]);
  // known[0] is always the live machine; the rest are declared from
  // config/hosts/*.json. Everything that needs telemetry uses the first.
  const live = known[0];
  const machine = live.machine;
  const occupants = live.occupants;
  const others = known.slice(1);

  // Attach the leaderboard row to each discovered vendor model, so "wire this"
  // can be decided on price and benchmark rather than on the id looking newer.
  const statsIndex = indexByModelId(stats.models);
  for (const provider of discovery) {
    for (const m of provider.models) {
      m.stats = lookup(statsIndex, m.modelId);
    }
  }

  const openWeights = openWeightsCandidates(stats.models, machine, occupants, others);

  // Aliases already in the router, so a candidate the report still lists as
  // "new" after you wired it says so instead of nagging. This is also the
  // catalogue the page renders, so it is read once and shared.
  let wiredAliasByTarget = new Map<string, string>();
  let catalogue: (CatalogModel & { stats?: LlmStatsModel })[] = [];
  let routerUp = false;
  try {
    const cat = await getCatalogue();
    routerUp = cat.routerUp;
    wiredAliasByTarget = new Map(cat.models.map((m) => [m.target, m.id]));
    catalogue = cat.models.map((m) => ({
      ...m,
      // Cloud targets are "provider/model-id"; the leaderboard keys on the
      // model id alone. Local models are matched by checkpoint client-side,
      // where the open-weights list is already indexed by name.
      stats: m.local ? undefined : lookup(statsIndex, m.target.split("/").slice(1).join("/")),
    }));
  } catch {
    /* router down */
  }

  const candidates: ScoutCandidateWithFit[] = report.candidates
    .map((c) => {
      // A sourced requirement always wins over an estimate; estimateFromParams
      // exists for the candidates whose authors published nothing usable. The
      // memory model is the LIVE machine's, because that is the verdict the
      // page leads with; each other host re-estimates against its own below.
      const requirement = requirementFor(c, machine.memoryModel);
      return {
        ...c,
        fit: evaluateFit({ requirement, machine, occupants }),
        elsewhere: others.map((m) => ({
          hostId: m.hostId,
          hostName: m.hostName,
          live: m.live,
          fit: evaluateFit({
            requirement: requirementFor(c, m.machine.memoryModel),
            machine: m.machine,
            occupants: m.occupants,
          }),
        })),
        alreadyWired: c.target ? wiredAliasByTarget.get(c.target) : undefined,
      };
    })
    .sort((a, b) => {
      const rank = VERDICT_RANK[a.fit.verdict] - VERDICT_RANK[b.fit.verdict];
      return rank !== 0 ? rank : a.name.localeCompare(b.name);
    });

  const ageDays = report.generatedAt
    ? Math.floor((Date.now() - new Date(report.generatedAt).getTime()) / 86400_000)
    : undefined;

  return {
    machine,
    occupants,
    machines: known,
    report: {
      generatedAt: report.generatedAt,
      generatedBy: report.generatedBy,
      ageDays,
      stale: ageDays === undefined || ageDays > STALE_AFTER_DAYS,
      notes: report.notes,
      upgrades: report.upgrades,
    },
    candidates,
    discovery,
    wired: listWired(),
    handWritten: handWrittenAliases(),
    leaderboard: {
      fetchedAt: stats.fetchedAt,
      source: stats.source,
      stale: stats.stale,
      error: stats.error,
      total: stats.models.length,
      openWeights,
      runnable: openWeights.filter((c) => c.best).length,
      // The same count for every machine, so the header can say "0 of 218 here,
      // 146 on B5" rather than quietly meaning one box. Derived from the
      // per-row answers already computed: a row with no `elsewhere` entry for a
      // host is one that host agrees about, so it counts wherever this one does.
      runnableByHost: known.map((m) => ({
        hostId: m.hostId,
        hostName: m.hostName,
        live: m.live,
        runnable: m.live
          ? openWeights.filter((c) => c.best).length
          : openWeights.filter((c) => {
              const differs = c.elsewhere.find((h) => h.hostId === m.hostId);
              return differs ? differs.verdict !== "no" : !!c.best;
            }).length,
      })),
    },
    routerUp,
    catalogue,
    routing: getRouting(),
    capabilities: CAPABILITIES.map((c) => ({ ...c })),
    downloads: listDownloads(),
    installed: installedRepos(),
  };
}
