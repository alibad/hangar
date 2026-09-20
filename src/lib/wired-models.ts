import fs from "fs";
import path from "path";

/**
 * Wiring a cloud model into the router from the console.
 *
 * Cloud vendors ship models faster than anyone edits a YAML file by hand, and
 * config/ai-router.yaml is deliberately the ONLY place a vendor model id is
 * written — so "try the new model" meant opening an editor, matching the
 * surrounding style, restarting the router, and hoping. This module makes it a
 * button.
 *
 * ── Why a sidecar and not a YAML parser ─────────────────────────────────────
 * The console never parses or rewrites ai-router.yaml. That file is hand-written
 * and heavily commented — most of its value is in the comments recording what
 * was measured about litellm's retry behaviour — and a round-trip through any
 * YAML library would erase all of it. Instead:
 *
 *   config/wired-models.json  is the source of truth for console-added models
 *   ai-router.yaml            gets a single MANAGED BLOCK spliced in, rendered
 *                             from that JSON, between two marker comments
 *
 * Everything outside the markers is byte-for-byte untouched. Delete the block by
 * hand and it comes back on the next sync; delete the JSON and the block empties
 * itself. Models written into the YAML by hand are never touched by any of this.
 */

const CONFIG_DIR = path.join(process.cwd(), "config");
const WIRED_FILE = path.join(CONFIG_DIR, "wired-models.json");
const ROUTER_FILE = path.join(CONFIG_DIR, "ai-router.yaml");

const BEGIN = "  # ─── BEGIN console-managed models — generated from config/wired-models.json ───";
const END = "  # ─── END console-managed models ───────────────────────────────────────────────";

/** Modes the router understands, mirrored from the CAPABILITIES list. */
export const WIRABLE_MODES = [
  "chat",
  "image_generation",
  "audio_transcription",
  "audio_speech",
  "embedding",
  "video_generation",
] as const;

/**
 * Vendors the router can already authenticate. Adding one means adding its key
 * to .env AND to PROVIDER_KEY_ENV in providers.ts — deliberately not something
 * a UI button can do, since the key has to come from a human either way.
 */
export const WIRABLE_PROVIDERS: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

export type WiredModel = {
  /** The alias callers send. Must not collide with one in the YAML. */
  alias: string;
  /** Vendor id as litellm wants it, e.g. "openai/gpt-5.6-terra". */
  target: string;
  provider: string;
  mode: (typeof WIRABLE_MODES)[number];
  addedAt: string;
  /** Free-text breadcrumb: which scout run or which person asked for this. */
  source?: string;
};

type WiredFile = { _doc?: string; models: WiredModel[] };

/**
 * What callers hand in, before validation.
 *
 * Deliberately `unknown` per field rather than `Partial<WiredModel>`: these
 * values arrive from a JSON request body or a scraped vendor list, and typing
 * them as already-correct would let a `mode` the router cannot serve past the
 * compiler on its way to validate(), which is the one place that should decide.
 */
export type WireInput = {
  alias?: unknown;
  target?: unknown;
  provider?: unknown;
  mode?: unknown;
  addedAt?: unknown;
  source?: unknown;
};

const DOC =
  "Cloud models wired in from the console's Models page. Rendered into a managed block inside ai-router.yaml — edit through the console, or edit here and the block re-renders on the next sync. Models written directly into ai-router.yaml by hand are NOT listed here and are never touched.";

export function listWired(): WiredModel[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(WIRED_FILE, "utf8")) as WiredFile;
    return Array.isArray(parsed?.models) ? parsed.models : [];
  } catch {
    return [];
  }
}

function saveWired(models: WiredModel[]): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(WIRED_FILE, JSON.stringify({ _doc: DOC, models }, null, 2) + "\n");
}

/**
 * Aliases already defined by hand in ai-router.yaml, OUTSIDE the managed block.
 *
 * A duplicate `model_name` is not a YAML error — litellm would simply serve two
 * entries under one alias and pick one — so this is the only thing standing
 * between a careless "wire it in" and a silently repointed model.
 */
export function handWrittenAliases(): string[] {
  let text: string;
  try {
    text = fs.readFileSync(ROUTER_FILE, "utf8");
  } catch {
    return [];
  }
  const { before, after } = splitOnMarkers(text);
  const outside = before + after;
  return [...outside.matchAll(/^\s*-\s*model_name:\s*(\S+)/gm)].map((m) => m[1]);
}

const ALIAS_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** provider/model-id — the shape litellm expects, and nothing that could break out of it. */
const TARGET_RE = /^[a-z0-9_-]+\/[A-Za-z0-9._@:-]+$/;

export class WireError extends Error {}

/**
 * Validate hard, and reject rather than sanitise.
 *
 * Everything here ends up as unquoted YAML scalars in a file that configures a
 * process holding three API keys. A colon or a newline smuggled through an alias
 * would restructure the document, so anything not matching these shapes is
 * refused outright — there is no input a user could give that we should be
 * guessing the intent of.
 */
export function validate(entry: WireInput): WiredModel {
  const alias = String(entry.alias ?? "").trim();
  const target = String(entry.target ?? "").trim();
  const provider = String(entry.provider ?? "").trim();
  const mode = String(entry.mode ?? "").trim();

  if (!ALIAS_RE.test(alias)) {
    throw new WireError(
      `Invalid alias "${alias}". Use lower-case letters, digits, dot, dash or underscore.`,
    );
  }
  if (!TARGET_RE.test(target)) {
    throw new WireError(
      `Invalid target "${target}". Expected "provider/model-id", e.g. "openai/gpt-5.6-terra".`,
    );
  }
  if (!WIRABLE_PROVIDERS[provider]) {
    throw new WireError(
      `Unknown provider "${provider}". The router can authenticate: ${Object.keys(WIRABLE_PROVIDERS).join(", ")}.`,
    );
  }
  if (!target.startsWith(`${provider}/`)) {
    throw new WireError(`Target "${target}" does not belong to provider "${provider}".`);
  }
  if (!(WIRABLE_MODES as readonly string[]).includes(mode)) {
    throw new WireError(`Unknown mode "${mode}". One of: ${WIRABLE_MODES.join(", ")}.`);
  }

  return {
    alias,
    target,
    provider,
    mode: mode as WiredModel["mode"],
    addedAt: typeof entry.addedAt === "string" && entry.addedAt ? entry.addedAt : new Date().toISOString(),
    source: entry.source ? String(entry.source).slice(0, 200) : undefined,
  };
}

/** Add or replace one alias, then re-render the managed block. Returns the new list. */
export function wire(entry: WireInput): WiredModel[] {
  const model = validate(entry);
  if (handWrittenAliases().includes(model.alias)) {
    throw new WireError(
      `"${model.alias}" is already defined by hand in ai-router.yaml. Pick a different alias, or edit that entry directly.`,
    );
  }
  const models = listWired().filter((m) => m.alias !== model.alias);
  models.push(model);
  models.sort((a, b) => a.alias.localeCompare(b.alias));
  saveWired(models);
  syncRouterConfig(models);
  return models;
}

/**
 * Wire a batch in ONE config write.
 *
 * Not a loop over wire(). Each wire() rewrites ai-router.yaml, and the caller
 * restarts the router afterwards — doing that twenty-one times means twenty-one
 * restarts, most of a minute each, with the router unusable throughout. This
 * writes once and lets the caller restart once.
 *
 * Partial success is the normal outcome, so it is reported rather than thrown:
 * one bad alias in a bulk wire should not discard the twenty that were fine.
 */
export function wireMany(entries: WireInput[]): {
  wired: WiredModel[];
  added: string[];
  skipped: { alias: string; reason: string }[];
} {
  const hand = new Set(handWrittenAliases());
  const models = listWired();
  const byAlias = new Map(models.map((m) => [m.alias, m]));
  const added: string[] = [];
  const skipped: { alias: string; reason: string }[] = [];

  for (const entry of entries) {
    let model: WiredModel;
    try {
      model = validate(entry);
    } catch (e) {
      skipped.push({
        alias: String(entry.alias ?? entry.target ?? "?"),
        reason: e instanceof Error ? e.message : String(e),
      });
      continue;
    }
    if (hand.has(model.alias)) {
      skipped.push({ alias: model.alias, reason: "already defined by hand in ai-router.yaml" });
      continue;
    }
    if (byAlias.has(model.alias)) {
      skipped.push({ alias: model.alias, reason: "already wired" });
      continue;
    }
    byAlias.set(model.alias, model);
    added.push(model.alias);
  }

  const next = [...byAlias.values()].sort((a, b) => a.alias.localeCompare(b.alias));
  if (added.length) {
    saveWired(next);
    syncRouterConfig(next);
  }
  return { wired: next, added, skipped };
}

/** Remove one alias. Silently succeeds when it was never wired. */
export function unwire(alias: string): WiredModel[] {
  const models = listWired().filter((m) => m.alias !== alias);
  saveWired(models);
  syncRouterConfig(models);
  return models;
}

/** The YAML text for the managed block, markers included. */
export function renderBlock(models: WiredModel[]): string {
  const lines = [BEGIN];
  lines.push(
    "  # Added from the console's Models page. Safe to delete an entry here, but",
    "  # config/wired-models.json is the source of truth and will re-render it.",
  );
  if (models.length === 0) {
    lines.push("  # (none wired yet)");
  }
  for (const m of models) {
    const keyEnv = WIRABLE_PROVIDERS[m.provider];
    lines.push(
      "",
      `  - model_name: ${m.alias}`,
      "    litellm_params:",
      `      model: ${m.target}`,
      `      api_key: os.environ/${keyEnv}`,
      "    model_info:",
      `      mode: ${m.mode}`,
      `    # wired ${m.addedAt.slice(0, 10)}${m.source ? ` — ${m.source.replace(/[\r\n]+/g, " ")}` : ""}`,
    );
  }
  lines.push(END);
  return lines.join("\n");
}

function splitOnMarkers(text: string): { before: string; after: string; found: boolean } {
  const start = text.indexOf(BEGIN);
  if (start === -1) return { before: text, after: "", found: false };
  const endIdx = text.indexOf(END, start);
  if (endIdx === -1) return { before: text, after: "", found: false };
  return { before: text.slice(0, start), after: text.slice(endIdx + END.length), found: true };
}

/**
 * Splice the managed block into ai-router.yaml.
 *
 * On the first run there are no markers, so the block is inserted at the END of
 * `model_list` — found as the first top-level key that follows it. Appending to
 * the bottom of the file instead would have put `- model_name:` under
 * `general_settings`, which litellm accepts as a settings key and then ignores,
 * producing a wired model that never appears and never errors.
 */
export function syncRouterConfig(models: WiredModel[] = listWired()): void {
  let text: string;
  try {
    text = fs.readFileSync(ROUTER_FILE, "utf8");
  } catch {
    throw new WireError(`Cannot read ${ROUTER_FILE}.`);
  }

  const block = renderBlock(models);
  const { before, after, found } = splitOnMarkers(text);
  let next: string;

  if (found) {
    next = before + block + after;
  } else {
    const lines = text.split("\n");
    const modelListAt = lines.findIndex((l) => /^model_list:\s*$/.test(l));
    if (modelListAt === -1) {
      throw new WireError("ai-router.yaml has no `model_list:` key — refusing to guess where models go.");
    }
    let insertAt = lines.length;
    for (let i = modelListAt + 1; i < lines.length; i++) {
      if (/^[A-Za-z_][A-Za-z0-9_]*:/.test(lines[i])) {
        insertAt = i;
        break;
      }
    }
    lines.splice(insertAt, 0, block, "");
    next = lines.join("\n");
  }

  // Only touch the file when the bytes actually change. The router is restarted
  // off the back of this, and rewriting an identical file to trigger a needless
  // restart is exactly the kind of churn a dashboard should not cause.
  if (next !== text) fs.writeFileSync(ROUTER_FILE, next);
}
