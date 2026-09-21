import { NextRequest, NextResponse } from "next/server";
import { getServiceHeaders } from "@/lib/services";
import { resolveCallTarget, type CallTarget } from "@/lib/providers";
import { TARGET_HEADER, withTraffic } from "@/lib/with-traffic";

/**
 * Reasoning models emit their thinking in one of two shapes, and this endpoint
 * used to discard both.
 *
 *  1. A separate `reasoning_content` field on the message. This is what LiteLLM
 *     normalises every provider's reasoning to (types/utils.py), so it covers
 *     the cloud models regardless of vendor.
 *  2. Inline <think>...</think> at the start of the content. Local Qwen3 does
 *     this, and since the playground rendered raw text the tags showed up
 *     verbatim in the reply.
 *
 * Splitting them apart lets the UI collapse the thinking instead of either
 * hiding it (losing the most interesting part of a reasoning model) or dumping
 * it inline (burying the answer).
 */
function splitThinking(content: string, reasoningField?: string | null) {
  if (typeof content !== "string") return { content: "", thinking: reasoningField ?? null };

  const inline = content.match(/^\s*<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>\s*/i);
  if (inline) {
    return {
      content: content.slice(inline[0].length),
      // Both can be present; keep them in one block rather than dropping either.
      thinking: [reasoningField, inline[1].trim()].filter(Boolean).join("\n\n") || null,
    };
  }
  // An unterminated <think> means the reply hit max_tokens mid-thought — show it
  // as thinking rather than as an empty answer.
  const openOnly = content.match(/^\s*<think(?:ing)?>([\s\S]*)$/i);
  if (openOnly) return { content: "", thinking: (reasoningField ?? "") + openOnly[1].trim() };

  return { content, thinking: reasoningField ?? null };
}

/**
 * Chat with whatever model the `text` capability is pointed at.
 *
 * This used to read `generated/active-llm.json` through getActiveLlm(), a
 * SECOND and entirely separate record of "which model" from the routing the
 * console's own picker writes to `generated/ai-routing.json`. So the picker on
 * the Chat page did not control the chat: selecting local-gemma4 (Ollama, up)
 * still called whatever active-llm.json last said — vllm-small, on a port with
 * nothing listening — and the playground answered "TypeError: fetch failed" in
 * three milliseconds while showing the name of a model it never contacted.
 *
 * resolveCallTarget is the one place that answers "which model, where, and by
 * what route", and /api/stt and /api/tts already go through it.
 */
/** Room for a real answer from a model that thinks out loud. See max_tokens below. */
const DEFAULT_MAX_TOKENS = 4096;
const MAX_MAX_TOKENS = 32768;

/**
 * How much prior conversation to carry, as characters of message content.
 *
 * A budget rather than a message count, because ten one-line exchanges and ten
 * thousand-word ones are not the same request. ~24k characters is roughly 6k
 * tokens, which leaves most of a 32k-context local model free for the answer.
 * Older turns are dropped first; the current message is never dropped.
 */
const HISTORY_BUDGET_CHARS = 24_000;

type Turn = { role: "user" | "assistant"; content: string };

/**
 * The tail of the conversation that fits the budget, oldest turns dropped first.
 *
 * Trimming happens HERE rather than in the browser so that every caller gets the
 * same ceiling, and so the reply can report what was actually sent.
 */
function fitHistory(raw: unknown): { turns: Turn[]; dropped: number } {
  if (!Array.isArray(raw)) return { turns: [], dropped: 0 };
  const clean = raw.flatMap((t): Turn[] => {
    const role = (t as Turn)?.role;
    const content = (t as Turn)?.content;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string" || !content.trim()) {
      return [];
    }
    // `thinking` is deliberately not carried: it is the model's scratch work,
    // it dwarfs the answer on a reasoning model, and feeding it back invites
    // the model to keep arguing with itself instead of with you.
    return [{ role, content }];
  });

  const kept: Turn[] = [];
  let used = 0;
  for (let i = clean.length - 1; i >= 0; i--) {
    const cost = clean[i].content.length;
    if (used + cost > HISTORY_BUDGET_CHARS) break;
    used += cost;
    kept.unshift(clean[i]);
  }
  return { turns: kept, dropped: clean.length - kept.length };
}

async function handlePost(req: NextRequest) {
  const { message, history, max_tokens } = await req.json();
  const maxTokens = Math.min(
    Math.max(Number.isFinite(max_tokens) ? Number(max_tokens) : DEFAULT_MAX_TOKENS, 1),
    MAX_MAX_TOKENS,
  );
  // Absent history means a one-shot request, which is what this endpoint did
  // unconditionally before — so an older caller keeps its old behaviour.
  const { turns, dropped } = fitHistory(history);

  const start = Date.now();
  // Outside the try so a connection failure can name what it tried to reach.
  let target: CallTarget | null = null;
  try {
    target = await resolveCallTarget("text");
    const res = await fetch(`${target.baseUrl}/v1/chat/completions`, {
      method: "POST",
      // Headers for the service the routing actually resolved to. A local
      // service may sit behind Cloudflare Access; the router does not.
      headers: {
        "Content-Type": "application/json",
        ...(target.serviceId ? getServiceHeaders(target.serviceId) : {}),
      },
      body: JSON.stringify({
        model: target.model,
        // The whole conversation, not just the last line. This sent a single
        // user message regardless of what came before, so the playground had no
        // memory at all: asking "what was mentioned" got "nothing has been
        // mentioned yet" from a model that had just answered two questions.
        messages: [...turns, { role: "user", content: message }],
        // 1024 was far too low for the models actually routed here. gemma4:31b
        // spends ~390 completion tokens answering "say hi in three words", so
        // anything resembling a list — "give me 100 prompts" — ran out of budget
        // mid-sentence and came back visibly chopped, with nothing in the UI
        // saying why. Overridable, because the right ceiling is a property of
        // the question, not of this file.
        max_tokens: maxTokens,
      }),
    });

    const raw = await res.text();
    let data: Record<string, any>;
    try {
      data = JSON.parse(raw);
    } catch {
      const returnedHtml = /^\s*</.test(raw);
      throw new Error(
        returnedHtml
          ? "The model endpoint returned a web page instead of a model response. It may be behind a login page or pointed at the wrong URL."
          : "The model endpoint returned a response Hangar could not read.",
      );
    }
    const latency = Date.now() - start;

    if (!res.ok) {
      return NextResponse.json(
        { error: data },
        { status: res.status, headers: { [TARGET_HEADER]: target.serviceId ?? "ai-router" } },
      );
    }

    const msg = data.choices?.[0]?.message ?? {};
    const { content, thinking } = splitThinking(msg.content ?? "", msg.reasoning_content);

    return NextResponse.json(
      {
        content,
        thinking,
        usage: data.usage,
        latency,
        model: data.model ?? target.alias,
        // Set when the routing could not be honoured and a fallback was used, so
        // the reply is not silently attributed to the model you picked.
        degraded: target.degraded,
        // A reasoning model can spend its whole budget thinking and return an
        // empty answer. Saying so beats rendering a blank bubble — and when it
        // spends the budget mid-ANSWER, saying so beats a reply that just stops.
        truncated: data.choices?.[0]?.finish_reason === "length",
        maxTokens,
        // What the model was actually shown. `dropped` is the interesting half:
        // it is the only signal that the start of a long thread has fallen out of
        // the budget, which otherwise looks like the model forgetting.
        carried: turns.length,
        dropped,
      },
      { headers: { [TARGET_HEADER]: target.serviceId ?? "ai-router" } },
    );
  } catch (err) {
    // "TypeError: fetch failed" on its own is unactionable — it was the entire
    // message the playground showed. Name the model, the address, and the
    // service, so the reply says which thing to start.
    const where = target
      ? ` while calling "${target.alias}" at ${target.baseUrl}${
          target.serviceId ? ` (service: ${target.serviceId})` : ""
        }`
      : " while resolving which model to use";
    return NextResponse.json(
      {
        error: `${String(err)}${where}`,
        serviceId: target?.serviceId,
        alias: target?.alias,
        latency: Date.now() - start,
      },
      {
        status: 502,
        headers: target ? { [TARGET_HEADER]: target.serviceId ?? "ai-router" } : undefined,
      },
    );
  }
}

export const POST = withTraffic(handlePost);
