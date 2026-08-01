import fs from "fs";
import path from "path";
import { SERVICE_REGISTRY, getServiceUrl } from "./services";

/**
 * Model catalogue, read from the AI Router (LiteLLM) rather than duplicated here.
 *
 * The router's config/ai-router.yaml is the single source of truth for which
 * models exist and which vendor id each alias maps to. This module's job is only
 * to answer "can I actually use this model right now, and if not, why not?" —
 * the question whose absence let a dead Ollama masquerade as "0 memes generated"
 * for weeks.
 */

const ROUTER_ID = "ai-router";

/** Which env var each cloud provider needs. Local models need none. */
const PROVIDER_KEY_ENV: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  vertex_ai: "GEMINI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

export type ModelStatus =
  | "ready"              // usable right now
  | "no-key"             // cloud model, API key absent from the environment
  | "service-stopped"    // local model, its backing service isn't running
  | "router-offline";    // the router itself is down, so nothing is usable

export type CatalogModel = {
  /** Alias callers send as `model` — stable across vendor id changes. */
  id: string;
  /** Underlying vendor id, e.g. "openai/gpt-image-2". */
  target: string;
  provider: string;
  /** "chat" | "image_generation" | … as reported by the router. */
  mode: string;
  local: boolean;
  /** For local models: the BeTenshi service id, so the UI can offer Start. */
  serviceId?: string;
  /** For cloud models: the env var that must be set. */
  keyEnv?: string;
  status: ModelStatus;
  /** Human-readable reason when status !== "ready". */
  detail?: string;
  /** Editorial facts from config/model-meta.json — all optional. */
  checkpoint?: string;
  params?: string;
  released?: string;
  docs?: string;
  paper?: string;
  note?: string;
  /** Memory cost of running this model locally. Absent for cloud models. */
  footprint?: Footprint;
  /** Rough cost signal for the compare view; 0/undefined for local. */
  costPerImage?: number;
  costPerMTokIn?: number;
  costPerMTokOut?: number;
};

type RawModelInfo = {
  model_name: string;
  litellm_params?: { model?: string; api_base?: string };
  model_info?: {
    mode?: string;
    litellm_provider?: string;
    input_cost_per_token?: number | null;
    output_cost_per_token?: number | null;
    input_cost_per_image?: number | null;
    output_cost_per_image?: number | null;
  };
};

function isLocalBase(apiBase?: string): boolean {
  if (!apiBase) return false;
  return /(^|\/\/)(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(apiBase);
}

/** Map a local model's api_base port onto the BeTenshi service that serves it. */
function serviceForBase(apiBase?: string): string | undefined {
  if (!apiBase) return undefined;
  const port = Number(apiBase.match(/:(\d+)/)?.[1]);
  if (!port) return undefined;
  return SERVICE_REGISTRY.find((s) => s.localPort === port)?.id;
}

/**
 * What a local model costs to have running. Approximate by construction, so
 * `basis` is required reading — see `_footprint_doc` in config/model-meta.json.
 *
 * `kind` is the distinction that makes the numbers comparable at all:
 *  • "reserved" — claimed at startup and held (vLLM's gpu-memory-utilization).
 *    Subtract it from free VRAM the moment the service starts.
 *  • "peak"     — a transient high-water mark (Qwen-Image streams weights from
 *    host RAM and idles near zero). Two "peak" models can share a card in a way
 *    two "reserved" ones cannot.
 */
export type Footprint = {
  vramGb?: number;
  ramGb?: number;
  kind?: "reserved" | "peak";
  basis?: string;
};

export type ModelMeta = {
  checkpoint?: string;
  params?: string;
  released?: string;
  docs?: string;
  paper?: string;
  note?: string;
  /** BeTenshi service id — lets footprints resolve without the router. */
  service?: string;
  footprint?: Footprint;
};

export type BenchmarkLink = { label: string; url: string };

const META_FILE = path.join(process.cwd(), "config", "model-meta.json");

/**
 * Editorial metadata (parameter counts, doc links, benchmark entry points).
 *
 * Separate from ai-router.yaml because LiteLLM does not surface custom
 * `model_info` keys — /model/info returns only its own standard fields, so
 * anything extra written into the YAML would be silently dropped.
 * Re-read per request: it's a few KB and edits should show up without a restart.
 */
function loadMeta(): Record<string, ModelMeta> & {
  _benchmarks?: Record<string, BenchmarkLink>;
} {
  try {
    return JSON.parse(fs.readFileSync(META_FILE, "utf8"));
  } catch {
    return {};
  }
}

/** Benchmark leaderboards, by capability-ish key ("image", "text"). */
export function getBenchmarks(): Record<string, BenchmarkLink> {
  return loadMeta()._benchmarks ?? {};
}

export function routerUrl(): string {
  return getServiceUrl(ROUTER_ID);
}

/** Is the router process up? Cheap — no model is contacted. */
export async function routerAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${routerUrl()}/health/liveliness`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Health of a local backing service, by BeTenshi service id. Deliberately probes
 * the service directly rather than asking the router: LiteLLM's own /health does
 * a REAL inference call per model, which for an image model means generating an
 * image — far too expensive to poll a dashboard with.
 */
async function localServiceHealthy(serviceId: string): Promise<boolean> {
  const svc = SERVICE_REGISTRY.find((s) => s.id === serviceId);
  if (!svc) return false;
  try {
    const res = await fetch(getServiceUrl(serviceId) + svc.healthPath, {
      signal: AbortSignal.timeout(2500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** The full catalogue with a usable/why-not verdict per model. */
export async function getCatalogue(): Promise<{ routerUp: boolean; models: CatalogModel[] }> {
  const routerUp = await routerAlive();
  if (!routerUp) return { routerUp: false, models: [] };

  let raw: RawModelInfo[] = [];
  try {
    const res = await fetch(`${routerUrl()}/model/info`, { signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    raw = Array.isArray(data?.data) ? data.data : [];
  } catch {
    return { routerUp: false, models: [] };
  }

  // Probe each distinct local service once, not once per model.
  const base = raw.map((m) => ({ m, svcId: serviceForBase(m.litellm_params?.api_base) }));
  const localIds = [...new Set(base.map((b) => b.svcId).filter((x): x is string => !!x))];
  const health = new Map<string, boolean>(
    await Promise.all(
      localIds.map(async (id) => [id, await localServiceHealthy(id)] as const),
    ),
  );

  const meta = loadMeta();
  const models: CatalogModel[] = base.map(({ m, svcId }) => {
    const info = m.model_info ?? {};
    const md: ModelMeta = meta[m.model_name] ?? {};
    const provider = info.litellm_provider ?? "unknown";
    const local = isLocalBase(m.litellm_params?.api_base);
    const keyEnv = local ? undefined : PROVIDER_KEY_ENV[provider];

    let status: ModelStatus = "ready";
    let detail: string | undefined;
    if (local) {
      if (!svcId) {
        status = "service-stopped";
        detail = "No BeTenshi service is registered on this port.";
      } else if (!health.get(svcId)) {
        status = "service-stopped";
        const name = SERVICE_REGISTRY.find((s) => s.id === svcId)?.name ?? svcId;
        detail = `${name} isn't running.`;
      }
    } else if (keyEnv && !process.env[keyEnv]) {
      status = "no-key";
      detail = `${keyEnv} is not set. Add it to betenshi-console/.env and restart the router.`;
    }

    const perTokIn = info.input_cost_per_token ?? 0;
    const perTokOut = info.output_cost_per_token ?? 0;
    return {
      id: m.model_name,
      target: m.litellm_params?.model ?? m.model_name,
      provider,
      mode: info.mode ?? "chat",
      local,
      serviceId: svcId,
      keyEnv,
      status,
      detail,
      costPerImage: info.output_cost_per_image ?? info.input_cost_per_image ?? undefined,
      costPerMTokIn: perTokIn ? perTokIn * 1_000_000 : undefined,
      costPerMTokOut: perTokOut ? perTokOut * 1_000_000 : undefined,
      checkpoint: md.checkpoint,
      params: md.params,
      released: md.released,
      docs: md.docs,
      paper: md.paper,
      note: md.note,
      // Cloud models cost money, not memory — leaving this undefined is what
      // makes the UI say "off-box" rather than "0 GB".
      footprint: local ? md.footprint : undefined,
    };
  });

  return { routerUp: true, models };
}

/**
 * Footprints keyed by BeTenshi service id, read straight from disk.
 *
 * Deliberately does NOT go through getCatalogue(): the LLM picker polls every
 * few seconds and must keep working when the router is down — which is exactly
 * when you're looking at a stopped service wondering whether it will fit.
 */
export function getFootprintsByService(): Record<string, { alias: string; footprint: Footprint }> {
  const out: Record<string, { alias: string; footprint: Footprint }> = {};
  for (const [alias, md] of Object.entries(loadMeta())) {
    if (alias.startsWith("_")) continue; // _doc / _benchmarks / _footprint_doc
    const m = md as ModelMeta;
    if (m.service && m.footprint) out[m.service] = { alias, footprint: m.footprint };
  }
  return out;
}

// ── active routing ──────────────────────────────────────────────────────────
// Persisted to disk for the same reason src/lib/llm.ts does it: env can't change
// at runtime, and every server route (including the batch worker) must agree.

/**
 * The contexts a model can be chosen for. Adding one is a single entry here plus
 * a matching `mode` on some model in ai-router.yaml — the API and the UI are
 * both driven off this list rather than hardcoding "text" and "image".
 */
export const CAPABILITIES = [
  {
    id: "text",
    label: "Text",
    modes: ["chat", "completion"],
    hint: "Chat and completions — the playground, batch prompt variation, and quote-forge's generators.",
  },
  {
    id: "vision",
    label: "Vision",
    modes: ["chat"],
    hint: "Understanding images you supply. Uses a chat model; pick one that accepts image input.",
  },
  {
    id: "image",
    label: "Image generation",
    modes: ["image_generation"],
    hint: "Defaults to the local 20B Qwen-Image — free and private. Switch to a cloud model to compare.",
  },
  {
    id: "stt",
    label: "Speech → text",
    modes: ["audio_transcription"],
    hint: "Transcription. Prefer local Whisper when the audio is sensitive — it never leaves this box.",
  },
  {
    id: "tts",
    label: "Text → speech",
    modes: ["audio_speech"],
    hint: "Voice output.",
  },
] as const;

export type Capability = (typeof CAPABILITIES)[number]["id"];
export type Routing = Record<Capability, string>;

const ROUTING_FILE = path.join(process.cwd(), "generated", "ai-routing.json");

/**
 * Local for image generation (free, private, already loaded); cloud elsewhere so
 * nothing depends on a GPU service being warm. Every one of these is overridable
 * per-capability from the console's Models tab.
 */
export const DEFAULT_ROUTING: Routing = {
  text: "gpt-5.5",
  vision: "gpt-5.5",
  image: "local-qwen-image",
  stt: "openai-transcribe",
  tts: "openai-tts",
};

export function getRouting(): Routing {
  try {
    const parsed = JSON.parse(fs.readFileSync(ROUTING_FILE, "utf8"));
    // Merge over the defaults so a routing file written before a capability
    // existed still resolves — a missing key must not read as "no model".
    const out = { ...DEFAULT_ROUTING };
    for (const cap of CAPABILITIES) {
      if (typeof parsed?.[cap.id] === "string" && parsed[cap.id]) {
        out[cap.id] = parsed[cap.id];
      }
    }
    return out;
  } catch {
    // Materialise the defaults on first read. Other processes (quote-forge)
    // resolve their model from this file, so leaving it absent means each side
    // silently falls back to its OWN default and they drift apart.
    try {
      fs.mkdirSync(path.dirname(ROUTING_FILE), { recursive: true });
      fs.writeFileSync(ROUTING_FILE, JSON.stringify(DEFAULT_ROUTING, null, 2));
    } catch {
      /* read-only FS — defaults still apply in memory */
    }
    return { ...DEFAULT_ROUTING };
  }
}

export function setRouting(next: Partial<Routing>): Routing {
  const merged = { ...getRouting(), ...next };
  fs.mkdirSync(path.dirname(ROUTING_FILE), { recursive: true });
  fs.writeFileSync(ROUTING_FILE, JSON.stringify(merged, null, 2));
  return merged;
}

/**
 * Resolve the model to use for a capability, honouring an explicit override.
 * Callers pass the caller-supplied model straight through so a compare run can
 * target one model directly without disturbing the saved routing.
 */
export function resolveModel(capability: Capability, override?: string | null): string {
  return override?.trim() || getRouting()[capability];
}

/**
 * Where a capability's chosen model is actually reachable, and under what name.
 *
 * Two dispatch paths, deliberately:
 *  • local  → straight at the service's own OpenAI-compatible face. Skips a hop,
 *             and keeps working when the router is down (both the local Whisper
 *             and Kokoro services speak the OpenAI audio API natively).
 *  • cloud  → through the AI Router, which is the only place vendor ids and keys
 *             are written.
 *
 * `fallbackServiceId` is the local service to use when the router is offline, so
 * a picked-but-unresolvable capability degrades to the local model instead of
 * failing outright — the behaviour these test panels had before they honoured the
 * routing at all.
 */
export type CallTarget = {
  /** Router alias chosen for this capability. */
  alias: string;
  /** OpenAI-compatible base URL, without the trailing /v1. */
  baseUrl: string;
  /** What to send as `model` — the served-model-name locally, the alias via the router. */
  model: string;
  local: boolean;
  via: "service" | "router";
  /** Set when we could not honour the routing and fell back. */
  degraded?: string;
};

export async function resolveCallTarget(
  capability: Capability,
  fallbackServiceId: string,
  fallbackModel: string,
): Promise<CallTarget> {
  const alias = getRouting()[capability];
  const { routerUp, models } = await getCatalogue();
  const chosen = models.find((m) => m.id === alias);

  if (!routerUp || !chosen) {
    return {
      alias,
      baseUrl: getServiceUrl(fallbackServiceId),
      model: fallbackModel,
      local: true,
      via: "service",
      degraded: routerUp
        ? `"${alias}" isn't in the router's model list — used the local model instead.`
        : `AI Router is down — used the local model instead of "${alias}".`,
    };
  }

  if (chosen.local && chosen.serviceId) {
    return {
      alias,
      baseUrl: getServiceUrl(chosen.serviceId),
      // litellm_params.model is provider-prefixed ("openai/whisper-1"); the local
      // server only knows the part after the prefix.
      model: chosen.target.includes("/") ? chosen.target.split("/").slice(1).join("/") : chosen.target,
      local: true,
      via: "service",
    };
  }

  return { alias, baseUrl: routerUrl(), model: alias, local: false, via: "router" };
}

/** Models eligible for a capability, by the modes that capability accepts. */
export function modelsFor(capability: Capability, models: CatalogModel[]): CatalogModel[] {
  const cap = CAPABILITIES.find((c) => c.id === capability);
  if (!cap) return [];
  return models.filter((m) => (cap.modes as readonly string[]).includes(m.mode));
}
