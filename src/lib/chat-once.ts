import { getCatalogue, routerUrl } from "./providers";
import { withResourceLease, ResourceLeaseError } from "./resource-manager";
import { isResident, unloadOthers, ollamaModelFromTarget } from "./ollama";

/**
 * Run ONE chat model against one prompt, through the AI Router.
 *
 * Extracted from /api/arena/run so the Text Lab shares the Arena's exact path —
 * catalogue validation, the Ollama residency/lease rules, thinking split — rather
 * than a second copy that drifts. The reasoning behind each rule is kept here
 * with the code; see also src/lib/ollama.ts.
 *
 * Returns an HTTP-shaped answer ({ status, body }) instead of throwing, because
 * both callers turn it straight into a response and a refused admission is a
 * capacity answer, not a crash.
 *
 * Everything goes through the router rather than straight to the serving port,
 * even for local models: its callback records alias, latency, tokens and cost
 * into the Requests view, and `source` tags the rows (X-Source).
 */

export type ChatOnceInput = {
  model: string;
  prompt: string;
  /** data:image/ URL, optional. */
  image?: string;
  maxTokens?: number;
  temperature?: number;
  seed?: number | null;
  /** X-Source tag for the Requests view, e.g. "console-arena". */
  source: string;
  /** Lease owner, identifies the caller and carries no prompt. */
  owner: string;
  signal?: AbortSignal;
  timeoutMs: number;
  /**
   * Extra top-level request fields, sent as given. For provider switches the
   * common fields do not cover. Note the router runs with drop_params: a field
   * LiteLLM does not recognise for that provider is dropped silently, so wrap
   * provider-specific ones as `{ extra_body: { … } }`, which LiteLLM forwards
   * verbatim (e.g. Ollama's `reasoning_effort: "none"` — see decide-server.ts).
   */
  extraBody?: Record<string, unknown>;
};

export type ChatOnceOk = {
  model: string;
  content: string;
  thinking: string | null;
  latency: number;
  usage: Record<string, unknown> | null;
  costUsd: number | null;
  truncated: boolean;
  local: boolean;
  /** Parameters the model refused and the run went without. Empty = as asked. */
  adjusted: string[];
};

export type ChatOnceResult =
  | { status: 200; body: ChatOnceOk }
  | { status: number; body: { error: string; latency?: number; resourceBlocked?: boolean; details?: unknown } };

export async function chatOnce(input: ChatOnceInput): Promise<ChatOnceResult> {
  const { model, prompt, image } = input;
  // 4096 by default: this path does not disable reasoning, and a thinking model
  // can spend most of a small budget before it begins answering — which
  // surfaces as a mysteriously empty answer.
  const maxTokens = input.maxTokens || 4096;

  // Validate against the live catalogue rather than trusting the body. An
  // unknown alias would otherwise reach the router and come back as an opaque
  // 400, with nothing saying which of the two is wrong.
  const { routerUp, models } = await getCatalogue();
  if (!routerUp) {
    return { status: 503, body: { error: "AI Router is not running. Start it from Services." } };
  }
  const entry = models.find((m) => m.id === model);
  if (!entry) return { status: 400, body: { error: `Unknown model "${model}".` } };
  if (entry.mode !== "chat") {
    return { status: 400, body: { error: `"${model}" is an ${entry.mode} model — this runs chat models.` } };
  }
  // Refuse rather than silently drop the image: a vision comparison where one
  // answer quietly came from the prompt alone is worse than an error, because
  // its output looks like a real (and terrible) result.
  if (image && !entry.vision) {
    return { status: 400, body: { error: `"${model}" does not accept image input.` } };
  }
  if (entry.status !== "ready") {
    return { status: 409, body: { error: entry.detail ?? `"${model}" is not ready.` } };
  }

  const content = image
    // Image BEFORE text: Gemma 4's model card asks for it explicitly, and no
    // model is harmed by the ordering.
    ? [{ type: "image_url", image_url: { url: image } }, { type: "text", text: prompt }]
    : prompt;

  const started = Date.now();

  // What the request actually sends. A model that refuses one of these is
  // retried with it adapted — see `adapt` below — and each change is reported.
  const sent = {
    tokenParam: "max_tokens" as "max_tokens" | "max_completion_tokens",
    // Greedy by default: every Arena task is convergent, and greedy decoding
    // makes a re-run reproducible — the difference between a comparison and
    // an anecdote.
    temperature: (input.temperature ?? 0) as number | undefined,
    seed: input.seed ?? undefined,
  };
  const adjusted: string[] = [];

  const call = async () => {
    const res = await fetch(`${routerUrl()}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Source": input.source },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content }],
        [sent.tokenParam]: maxTokens,
        ...(sent.temperature !== undefined ? { temperature: sent.temperature } : {}),
        ...(sent.seed !== undefined ? { seed: sent.seed } : {}),
        ...(input.extraBody ?? {}),
      }),
      signal: AbortSignal.timeout(input.timeoutMs),
    });
    // The router's own cost figure for the call. LiteLLM puts it in a header,
    // not the body — `usage.response_cost` is absent from the response, which
    // is why every cost here used to read "n/a".
    const cost = Number(res.headers.get("x-litellm-response-cost"));
    return { status: res.status, ok: res.ok, text: await res.text(), costUsd: Number.isFinite(cost) ? cost : null };
  };

  /**
   * Adapt to a parameter the model explicitly refused, or return false.
   *
   * OpenAI's newest models (chat-latest, gpt-5.6-*) reject `max_tokens` and any
   * temperature but their default, and LiteLLM passes the 400 through rather
   * than translating. The rejection names the parameter, so the retry is exact
   * and never guessed. A dropped temperature or seed is REPORTED in `adjusted`:
   * that run was not greedy, and a comparison must not present it as if it were.
   */
  const adapt = (text: string): boolean => {
    if (sent.tokenParam === "max_tokens" && /max_completion_tokens/.test(text)) {
      sent.tokenParam = "max_completion_tokens";
      return true;
    }
    if (sent.temperature !== undefined && /'temperature'/.test(text)) {
      adjusted.push(`temperature ${sent.temperature} refused — ran at the model's default`);
      sent.temperature = undefined;
      return true;
    }
    if (sent.seed !== undefined && /'seed'/.test(text)) {
      adjusted.push("seed refused — ran unseeded");
      sent.seed = undefined;
      return true;
    }
    return false;
  };

  try {
    /*
     * Only OLLAMA models take the `ollama-chat` lease.
     *
     * vLLM needs no per-request lease: it RESERVES its VRAM at service start,
     * and that start already went through the coordinator. Branching on `local`
     * alone once deadlocked a vLLM request behind memory it had itself
     * reserved. Ollama allocates on demand, per model, so it does need one —
     * unless the target is already resident (no new VRAM), and otherwise after
     * evicting whatever else Ollama holds, so the coordinator sees a freed card.
     */
    let res: { status: number; ok: boolean; text: string; costUsd: number | null };
    if (!entry.local || entry.serviceId !== "ollama") {
      res = await call();
    } else {
      const ollamaModel = ollamaModelFromTarget(entry.target);
      const alreadyLoaded = ollamaModel ? await isResident(ollamaModel) : false;
      if (alreadyLoaded) {
        res = await call();
      } else {
        if (ollamaModel) await unloadOthers(ollamaModel);
        res = await withResourceLease(
          "ollama-chat",
          { owner: input.owner, lane: "interactive", signal: input.signal, waitMs: 120_000 },
          call,
        );
      }
    }

    // At most one retry per adaptable parameter. Only cloud models have been
    // seen to do this, and a retried call counts in latency, which is honest
    // about what the run cost.
    for (let i = 0; i < 3 && !res.ok && res.status === 400 && adapt(res.text); i++) {
      res = await call();
    }

    const latency = Date.now() - started;
    if (!res.ok) return { status: res.status, body: { error: res.text.slice(0, 600), latency } };

    const data = JSON.parse(res.text);
    const msg = data.choices?.[0]?.message ?? {};
    const { content: answer, thinking } = splitThinking(msg.content ?? "", msg.reasoning_content);

    return {
      status: 200,
      body: {
        model,
        content: answer,
        thinking,
        latency,
        usage: data.usage ?? null,
        // Local models are not metered: reporting 0 would read as "free to
        // run" rather than "not metered", so a local call reports null.
        costUsd: entry.local ? null : (res.costUsd ?? data.usage?.response_cost ?? null),
        truncated: data.choices?.[0]?.finish_reason === "length",
        local: entry.local,
        adjusted,
      },
    };
  } catch (err) {
    // A refused admission carries the coordinator's own explanation of what is
    // holding the card, so the caller can say what to stop rather than "failed".
    if (err instanceof ResourceLeaseError) {
      return {
        status: err.status || 409,
        body: { error: err.message, resourceBlocked: true, details: err.details, latency: Date.now() - started },
      };
    }
    const message = err instanceof Error && err.name === "TimeoutError"
      ? `Timed out after ${Math.round(input.timeoutMs / 1000)}s. A cold local model can take minutes to load.`
      : String(err);
    return { status: 502, body: { error: message, latency: Date.now() - started } };
  }
}

/**
 * Split a reasoning model's thinking from its answer.
 *
 * Same two shapes /api/chat handles: a separate `reasoning_content` field (what
 * LiteLLM normalises every provider's reasoning to) and inline <think> tags
 * (what local Qwen3 emits). Scoring the thinking as part of the answer would
 * report a near-total error for a model that answered correctly after thinking.
 */
export function splitThinking(content: string, reasoningField?: string | null) {
  if (typeof content !== "string") return { content: "", thinking: reasoningField ?? null };
  const inline = content.match(/^\s*<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>\s*/i);
  if (inline) {
    return {
      content: content.slice(inline[0].length),
      thinking: [reasoningField, inline[1].trim()].filter(Boolean).join("\n\n") || null,
    };
  }
  const openOnly = content.match(/^\s*<think(?:ing)?>([\s\S]*)$/i);
  if (openOnly) return { content: "", thinking: (reasoningField ?? "") + openOnly[1].trim() };
  return { content, thinking: reasoningField ?? null };
}
