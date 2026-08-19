import fs from "fs";
import path from "path";
import { getCatalogue } from "./providers";
import { readMachineProfile, readOccupants } from "./machine";
import { evaluateFit, estimateFromParams, VERDICT_RANK, type Fit, type Requirement, type ParamSpec } from "./model-fit";
import { listWired, handWrittenAliases, WIRABLE_PROVIDERS } from "./wired-models";

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
 *     config/model-scout.json (see docs/model-scout.md). Which local checkpoint
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
          // A family nothing here uses. Worth surfacing only if it shipped no
          // earlier than the newest model already wired for this provider —
          // that is what makes it news rather than history.
          if (m.released < newestWired) continue;
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

// ── the merged view ─────────────────────────────────────────────────────────

export type ScoutCandidateWithFit = ScoutCandidate & {
  fit: Fit;
  /** Already reachable through the router, so this is informational only. */
  alreadyWired?: string;
};

export type ScoutPayload = {
  machine: Awaited<ReturnType<typeof readMachineProfile>>;
  occupants: Awaited<ReturnType<typeof readOccupants>>;
  report: {
    generatedAt?: string;
    generatedBy?: string;
    /** Days since the weekly routine last wrote the file. */
    ageDays?: number;
    stale: boolean;
    notes: string[];
    upgrades: ScoutUpgrade[];
  };
  candidates: ScoutCandidateWithFit[];
  discovery: ProviderDiscovery[];
  wired: ReturnType<typeof listWired>;
  handWritten: string[];
};

/** A report older than this is shown as stale — the routine runs weekly. */
const STALE_AFTER_DAYS = 10;

export async function getScout(opts: { force?: boolean } = {}): Promise<ScoutPayload> {
  const report = loadReport();
  const [machine, occupants, discovery] = await Promise.all([
    readMachineProfile(),
    readOccupants(),
    discover(opts),
  ]);

  // Aliases already in the router, so a candidate the report still lists as
  // "new" after you wired it says so instead of nagging.
  let wiredAliasByTarget = new Map<string, string>();
  try {
    const { models } = await getCatalogue();
    wiredAliasByTarget = new Map(models.map((m) => [m.target, m.id]));
  } catch {
    /* router down */
  }

  const candidates: ScoutCandidateWithFit[] = report.candidates
    .map((c) => {
      // A sourced requirement always wins over an estimate; estimateFromParams
      // exists for the candidates whose authors published nothing usable.
      const requirement: Requirement =
        c.requirement ?? (c.spec ? estimateFromParams(c.spec) : {});
      return {
        ...c,
        fit: evaluateFit({ requirement, machine, occupants }),
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
  };
}
