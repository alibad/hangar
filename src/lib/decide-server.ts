import { chatOnce, type ChatOnceOk } from "./chat-once";
import { getCatalogue } from "./providers";
import { servicesForCapability, servedModels } from "./host";
import { getServiceUrl, type ServiceEntry } from "./services";
import {
  buildLlmPrompt,
  buildSystemOneRequest,
  CLOUD_DECISION_MODELS,
  contextText,
  isCloudDecisionModel,
  isLayaModel,
  parseLlmDecision,
  parseSystemOneAnswer,
  type SystemOneAnswer,
  type DecideRequest,
  type DecideResult,
} from "./decide";

/**
 * Answer one decision, by a decision model or by an LLM, in the same shape.
 *
 * A decision model is found by asking the host profile which service declares
 * `serves.decision` with that model name — never by a service id in code — so
 * the same route works on a machine whose decision service is called
 * something else, or is not installed (a clear 503, not a crash).
 *
 * Any other model name is treated as a router chat alias and asked the same
 * question through chatOnce(): the Arena's exact path, with the Ollama lease
 * rules that keep a 19 GB model from being loaded behind the coordinator's
 * back. That is what makes the comparison fair — the LLM is called the way the
 * console calls it everywhere else.
 *
 * Returns an HTTP-shaped answer rather than throwing, like chatOnce.
 */

export type DecideOutcome =
  | { status: 200; body: DecideResult }
  | { status: number; body: { error: string; resourceBlocked?: boolean; latencyMs?: number } };

export function decisionServiceFor(model: string): ServiceEntry | undefined {
  return servicesForCapability("decision").find((s) => servedModels(s, "decision").includes(model));
}

/** Every decision model this host declares, for GET /api/decide and the MCP tool's description. */
export function hostDecisionModels(): { model: string; serviceId: string; serviceName: string }[] {
  return servicesForCapability("decision").flatMap((s) =>
    servedModels(s, "decision").map((model) => ({ model, serviceId: s.id, serviceName: s.name })),
  );
}

export async function decide(
  req: DecideRequest,
  opts: { source: string; owner: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<DecideOutcome> {
  if (isCloudDecisionModel(req.model)) return decideWithCloud(req, opts);
  return isLayaModel(req.model) || decisionServiceFor(req.model) ? decideWithService(req, opts) : decideWithLlm(req, opts);
}

/**
 * A hosted decision model (Jev via OpenRouter), called directly: it is not a
 * chat model, so the AI Router — a chat proxy — cannot carry it. The key is
 * read from the console's own env (betenshi-console/.env, the file the router
 * also reads). The cost is the provider's own figure from `usage.cost`.
 */
async function decideWithCloud(
  req: DecideRequest,
  opts: { source: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<DecideOutcome> {
  const m = CLOUD_DECISION_MODELS[req.model];
  const key = process.env[m.keyEnv];
  if (!key) {
    return { status: 503, body: { error: `${m.name} needs ${m.keyEnv} in betenshi-console/.env.` } };
  }
  const started = performance.now();
  let res: Response;
  try {
    res = await fetch(m.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-Title": "BeTenshi console" },
      body: JSON.stringify(buildSystemOneRequest(req, m.upstream)),
      signal: opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
  } catch (err) {
    return { status: 502, body: { error: `Could not reach ${m.name}: ${String(err)}`, latencyMs: Math.round(performance.now() - started) } };
  }
  const latencyMs = Math.round((performance.now() - started) * 10) / 10;
  const text = await res.text();
  let j: { answers?: Record<string, SystemOneAnswer>; usage?: { cost?: number }; error?: { message?: string } | string } = {};
  try {
    j = JSON.parse(text);
  } catch {
    /* reported below */
  }
  const answer = j.answers?.decision;
  if (!res.ok || !answer) {
    const detail = typeof j.error === "string" ? j.error : j.error?.message ?? text.slice(0, 300);
    const why = res.status === 402 ? "the OpenRouter account is out of credit" : res.status === 401 ? "the OpenRouter key was refused" : detail;
    return { status: res.ok ? 502 : res.status, body: { error: `${m.name}: ${why}`, latencyMs } };
  }
  return {
    status: 200,
    body: {
      ...parseSystemOneAnswer(answer, req),
      latencyMs,
      model: req.model,
      local: false,
      costUsd: typeof j.usage?.cost === "number" ? j.usage.cost : null,
      parsed: true,
    },
  };
}

/**
 * Where the decision service runs, from its own /health, cached for a minute.
 * It decides whether a run's card-wide VRAM reading means anything: on CPU the
 * service holds no GPU context, so any VRAM movement during the run is other
 * people's work and reporting it would be wrong.
 */
const deviceCache = new Map<string, { at: number; device: string | null }>();
export async function serviceDevice(svc: ServiceEntry): Promise<string | null> {
  const hit = deviceCache.get(svc.id);
  if (hit && Date.now() - hit.at < 60_000) return hit.device;
  let device: string | null = null;
  try {
    const r = await fetch(`${getServiceUrl(svc.id)}${svc.healthPath}`, { signal: AbortSignal.timeout(2000) });
    const j = await r.json().catch(() => null);
    device = typeof j?.device === "string" ? j.device : null;
  } catch {
    /* unknown */
  }
  deviceCache.set(svc.id, { at: Date.now(), device });
  return device;
}

async function decideWithService(
  req: DecideRequest,
  opts: { source: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<DecideOutcome> {
  const svc = decisionServiceFor(req.model);
  if (!svc) {
    return { status: 404, body: { error: `Nothing on this host serves the decision model "${req.model}".` } };
  }
  const started = performance.now();
  let res: Response;
  try {
    res = await fetch(`${getServiceUrl(svc.id)}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Source": opts.source },
      body: JSON.stringify({
        question: req.question,
        type: req.type,
        // Laya scores each option beside its description; a label that is its
        // own description is sent as a bare list.
        choices: req.type === "yesno" ? undefined : req.choices,
        context: req.context,
        model: req.model,
      }),
      signal: opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
  } catch (err) {
    const refused = String((err as { cause?: { code?: string } })?.cause?.code ?? err).includes("ECONNREFUSED");
    return {
      status: 503,
      body: {
        error: refused
          ? `${svc.name} isn't running. Start it from Services, or with the Start button in the Decision Lab.`
          : `Could not reach ${svc.name}: ${String(err)}`,
        latencyMs: Math.round(performance.now() - started),
      },
    };
  }
  const latencyMs = Math.round((performance.now() - started) * 10) / 10;
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 400);
    try {
      const j = JSON.parse(text);
      detail = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail ?? j);
    } catch {
      /* keep the raw text */
    }
    // 503 from the service means "still loading its checkpoints".
    return { status: res.status, body: { error: `${svc.name}: ${detail}`, latencyMs } };
  }
  const j = JSON.parse(text) as {
    choice: string;
    probabilities: Record<string, number>;
    confidence?: number | null;
    checkpoint?: string | null;
    routing?: { reason?: string | null };
    latencyMs?: number;
    score?: number;
  };
  return {
    status: 200,
    body: {
      choice: j.choice,
      probabilities: j.probabilities,
      confidence: j.probabilities[j.choice] ?? j.confidence ?? 0,
      latencyMs,
      modelLatencyMs: j.latencyMs ?? null,
      model: req.model,
      local: true,
      checkpoint: j.checkpoint ?? null,
      routingReason: j.routing?.reason ?? null,
      device: await serviceDevice(svc),
      costUsd: null,
      ...(j.score != null ? { score: j.score } : {}),
    },
  };
}

async function decideWithLlm(
  req: DecideRequest,
  opts: { source: string; owner: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<DecideOutcome> {
  const labels = Object.keys(req.choices);
  // A decision needs no deliberation, and a local thinking model left to
  // reason takes 5-30 s per answer instead of ~1 s (Gemma 4, measured in
  // docs/arabic-model-experiment-2026-09-14.md). Ollama's OpenAI-compatible API
  // switches reasoning off with `reasoning_effort: "none"`; cloud models are
  // left as their providers default them (Claude Haiku does not reason unless
  // asked). Wrapped in `extra_body` ON PURPOSE: the router runs with
  // drop_params, and LiteLLM does not list reasoning_effort as supported for an
  // unrecognised model on the openai provider, so a bare field is dropped
  // silently and the model reasons anyway. Verified against the router's own
  // litellm with an echo server: bare → not forwarded; extra_body → forwarded.
  const entry = (await getCatalogue()).models.find((m) => m.id === req.model);
  const noReasoning = entry?.local && entry.serviceId === "ollama";
  const r = await chatOnce({
    model: req.model,
    prompt: buildLlmPrompt(req),
    // Room for a model that reasons anyway; the JSON itself is under 100
    // tokens. Greedy, so a re-run is the same answer.
    maxTokens: 2048,
    temperature: 0,
    source: opts.source,
    owner: opts.owner,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs ?? 600_000,
    ...(noReasoning ? { extraBody: { extra_body: { reasoning_effort: "none" } } } : {}),
  });
  if (r.status !== 200) {
    const b = r.body as { error: string; latency?: number; resourceBlocked?: boolean };
    return { status: r.status, body: { error: b.error, resourceBlocked: b.resourceBlocked, latencyMs: b.latency } };
  }
  const ok = r.body as ChatOnceOk;
  const parsed = parseLlmDecision(ok.content, labels);
  return {
    status: 200,
    body: {
      choice: parsed.choice,
      probabilities: parsed.probabilities,
      confidence: parsed.probabilities[parsed.choice] ?? 0,
      latencyMs: ok.latency,
      model: req.model,
      local: ok.local,
      costUsd: ok.costUsd,
      parsed: parsed.parsed,
    },
  };
}

/** One line for the runs record: what was asked, never the whole context. */
export function decideSummary(req: DecideRequest): string {
  const ctx = contextText(req.context).replace(/\s+/g, " ").trim();
  return `${req.question} [${Object.keys(req.choices).join(" | ")}]${ctx ? ` — ${ctx.slice(0, 120)}` : ""}`;
}
