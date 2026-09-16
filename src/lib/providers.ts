import fs from "fs";
import path from "path";
// Named import, not default: js-yaml v5's ESM build exports `load` and has no
// default export, so `import yaml from "js-yaml"` fails to compile.
import { load as parseYaml } from "js-yaml";
import { SERVICE_REGISTRY, getServiceUrl } from "./services";
import { defaultServiceFor } from "./host";

/**
 * Model catalogue, read from the AI Router (LiteLLM) rather than duplicated here.
 *
 * The router's config/ai-router.yaml is the single source of truth for which
 * models exist and which vendor id each alias maps to. This module's job is only
 * to answer "can I actually use this model right now, and if not, why not?" —
 * the question whose absence let a dead Ollama masquerade as "0 memes generated"
 * for weeks.
 *
 * The source of truth is that FILE, not the process that reads it. Asking the
 * running router was treated as the only way to enumerate models, so a dead
 * gateway collapsed every picker in the console to "AI Router is down — no
 * models can be listed" — no names, no footprints, no service status, no way in.
 * That was wrong twice over: it hid models whose own backing service was up and
 * usable, and it hid the Start buttons that would have fixed it. When the router
 * is not answering the YAML is parsed directly, so the catalogue keeps its shape
 * and only the ability to CALL a model is actually lost.
 */

const ROUTER_ID = "ai-router";

/** Which env var each cloud provider needs. Local models need none. */
const PROVIDER_KEY_ENV: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  vertex_ai: "GEMINI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

/**
 * Per-model readiness, and deliberately about the MODEL's own backing service —
 * `status === "ready"` is read across the console as "this service is up".
 *
 * The router being down is not expressed here. It is one fact about the whole
 * console, not a property of forty models, and stamping it on every row would
 * erase the only thing worth knowing while it is down: which services are warm.
 * Callers pair this with `getCatalogue().routerUp` and say it once.
 */
export type ModelStatus =
  | "ready"              // usable right now
  | "no-key"             // cloud model, API key absent from the environment
  | "service-stopped"    // local model, its backing service isn't running
  | "router-offline";    // reserved; see above — no model is given this today

/** Whether a catalogue came from the live router or from ai-router.yaml. */
export type CatalogueSource = "router" | "config";

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
  /**
   * Accepts image input. Declared in config/model-meta.json, NOT inferred.
   *
   * The router reports `mode: "chat"` for every conversational model, text-only
   * and multimodal alike, because that is the only mode LiteLLM has for them.
   * So without this flag the Vision capability offers every chat model on the
   * box and silently accepts a text-only one - which is exactly what had
   * happened: vision was routed to `local-small`, a 7B that cannot see.
   * Guessing from the alias would not fix it either, since the name that most
   * needs to be recognised (gemma4) says nothing about vision.
   */
  vision?: boolean;
  /**
   * For a model on a runtime that loads on demand (Ollama): is it resident RIGHT
   * NOW. Undefined for every other model, where "the service is up" already
   * answers the question.
   *
   * This exists because a shared runtime broke the assumption the rest of the UI
   * rests on - that one model means one service. Three Ollama aliases share the
   * `ollama` service, so `status: "ready"` is true for all three the moment the
   * runtime is up, and the picker showed three models "running" on a card that
   * can hold exactly one. `loaded` is the honest answer, asked of the runtime.
   */
  loaded?: boolean;
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
    /**
     * LiteLLM's own multimodal flag, from its model cost map. Present for cloud
     * models it recognises; absent for a locally-served one, which it has no
     * knowledge of. Used only as a fallback under the declaration in
     * model-meta.json — see the note on CatalogModel.vision.
     */
    supports_vision?: boolean;
  };
};

function isLocalBase(apiBase?: string): boolean {
  if (!apiBase) return false;
  return /(^|\/\/)(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(apiBase);
}

/**
 * Services that load a model on demand rather than pinning one at startup.
 * For these, service health says only that the runtime is up.
 */
export const ON_DEMAND_SERVICES = new Set(["ollama"]);

/**
 * Ollama model names currently resident, as the router spells them.
 *
 * Returned in router form (`openai/<name>`) as well as bare, so the caller can
 * match `litellm_params.model` directly rather than stripping a prefix at every
 * use. Failure is an empty set, never a throw: residency is extra detail on a
 * catalogue that must keep rendering when a runtime is down.
 */
async function residentOllamaTargets(): Promise<Set<string>> {
  try {
    const res = await fetch(`${getServiceUrl("ollama")}/api/ps`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return new Set();
    const data = (await res.json()) as { models?: { name?: string; model?: string }[] };
    const out = new Set<string>();
    for (const m of data.models ?? []) {
      const name = m.name ?? m.model;
      if (name) {
        out.add(`openai/${name}`);
        out.add(name);
      }
    }
    return out;
  } catch {
    return new Set();
  }
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
  /** Accepts image input. See CatalogModel.vision for why this is declared. */
  vision?: boolean;
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

const ROUTER_CONFIG_FILE = path.join(process.cwd(), "config", "ai-router.yaml");

/**
 * The catalogue as written on disk, for when the router is not answering.
 *
 * Returns the same shape LiteLLM's /model/info does, so the enrichment below
 * does not care which way the list arrived. Two fields the running router
 * computes are NOT recoverable here and are deliberately left undefined rather
 * than guessed: per-token cost (LiteLLM resolves it from its own price table)
 * and Ollama residency. The UI already renders both as unknown.
 *
 * `litellm_provider` is the one thing worth deriving, because every status that
 * matters for a cloud model — "no key configured" — keys off it, and LiteLLM
 * derives it from exactly this prefix.
 */
function readRouterConfig(): RawModelInfo[] {
  try {
    const doc = parseYaml(fs.readFileSync(ROUTER_CONFIG_FILE, "utf8")) as {
      model_list?: RawModelInfo[];
    };
    const list = Array.isArray(doc?.model_list) ? doc.model_list : [];
    return list
      .filter((m) => typeof m?.model_name === "string")
      .map((m) => {
        const target = m.litellm_params?.model ?? "";
        const prefix = target.includes("/") ? target.split("/")[0] : "";
        return {
          ...m,
          model_info: {
            ...m.model_info,
            // A local api_base means the `openai/` prefix is only LiteLLM's
            // "this speaks the OpenAI wire format" marker, not the vendor.
            litellm_provider:
              m.model_info?.litellm_provider ??
              (isLocalBase(m.litellm_params?.api_base) ? "local" : prefix || "unknown"),
          },
        };
      });
  } catch {
    return [];
  }
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
export async function getCatalogue(): Promise<{
  routerUp: boolean;
  /** Where the list came from. "config" means the router is not answering. */
  source: CatalogueSource;
  models: CatalogModel[];
}> {
  // `routerUp` keeps its narrow meaning — the gateway is alive and can serve a
  // call — because callers that refuse to run inference without it are right to.
  // What changes is that a dead router no longer empties the catalogue.
  const routerUp = await routerAlive();

  let raw: RawModelInfo[] = [];
  let source: CatalogueSource = "router";
  if (routerUp) {
    try {
      const res = await fetch(`${routerUrl()}/model/info`, { signal: AbortSignal.timeout(5000) });
      const data = await res.json();
      raw = Array.isArray(data?.data) ? data.data : [];
    } catch {
      raw = [];
    }
  }
  // Alive but unreadable counts as not answering: an empty list from a running
  // router is indistinguishable, to a reader, from no router at all.
  if (!raw.length) {
    raw = readRouterConfig();
    source = "config";
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

  // Which model an on-demand runtime is actually holding has to be asked; its
  // health endpoint only says the runtime is up.
  const residentTargets = health.get("ollama") ? await residentOllamaTargets() : new Set<string>();

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
      // Declaration first, LiteLLM's own flag second. The declaration has to
      // win: it is the only source for a locally-served model, and it is how a
      // text-only model is pinned to false. But making it the ONLY source is
      // what emptied this capability once already — the filter shipped before
      // any entry carried the flag, so Vision offered nothing at all. A cloud
      // model added later with no model-meta entry now still lands correctly.
      vision: md.vision ?? info.supports_vision === true,
      loaded: ON_DEMAND_SERVICES.has(svcId ?? "") ? residentTargets.has(m.litellm_params?.model ?? "") : undefined,
    };
  });

  return { routerUp, source, models };
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
  /**
   * WHICH local service this resolved to, when it resolved to one.
   *
   * Without it a caller had to name a service itself to get its headers, so
   * /api/stt asked for whisper's headers whatever the routing said — point the
   * stt capability at a different local ASR service and it would send one
   * service's Cloudflare-Access credentials to another. The resolution already
   * knows the answer; it just was not passing it on.
   */
  serviceId?: string;
  /** Set when we could not honour the routing and fell back. */
  degraded?: string;
};

/**
 * Where to send a call for `capability`, and what to call it.
 *
 * The fallback — used when the router is down or does not know the routed
 * alias — is derived from the host profile, so no caller has to name a service
 * in code. It used to be two required arguments and every audio route passed
 * ("whisper", "whisper-1"): correct until the day this box runs a different
 * ASR model, and silently wrong after. Pass them explicitly only to override.
 */
export async function resolveCallTarget(
  capability: Capability,
  fallbackServiceId?: string,
  fallbackModel?: string,
): Promise<CallTarget> {
  const alias = getRouting()[capability];
  const { routerUp, models } = await getCatalogue();
  const chosen = models.find((m) => m.id === alias);

  if (!routerUp || !chosen) {
    const declared = defaultServiceFor(capability);
    const svcId = fallbackServiceId ?? declared?.serviceId;
    const svcModel = fallbackModel ?? declared?.model;
    if (!svcId || !svcModel) {
      // Nothing on this host declares the capability and the router cannot
      // answer. Saying so beats calling a service that does not exist.
      throw new Error(
        `No local service on this host serves "${capability}", and the AI Router could not resolve "${alias}".`,
      );
    }
    return {
      alias,
      baseUrl: getServiceUrl(svcId),
      model: svcModel,
      local: true,
      via: "service",
      serviceId: svcId,
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
      serviceId: chosen.serviceId,
    };
  }

  return { alias, baseUrl: routerUrl(), model: alias, local: false, via: "router" };
}

/**
 * Models eligible for a capability, by the modes that capability accepts.
 *
 * Vision is the one capability that mode alone cannot decide: it accepts `chat`,
 * and so does every text-only model. It is narrowed by the explicit `vision`
 * flag instead - see the note on CatalogModel.vision for why this is declared
 * rather than inferred.
 */
export function modelsFor(capability: Capability, models: CatalogModel[]): CatalogModel[] {
  const cap = CAPABILITIES.find((c) => c.id === capability);
  if (!cap) return [];
  const byMode = models.filter((m) => (cap.modes as readonly string[]).includes(m.mode));
  return capability === "vision" ? byMode.filter((m) => m.vision) : byMode;
}
