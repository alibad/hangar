import { NextRequest, NextResponse } from "next/server";
import { getServiceHeaders } from "@/lib/services";
import { resolveCallTarget, type CallTarget } from "@/lib/providers";

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
export async function POST(req: NextRequest) {
  const { message } = await req.json();

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
        messages: [{ role: "user", content: message }],
        max_tokens: 1024,
      }),
    });

    const data = await res.json();
    const latency = Date.now() - start;

    if (!res.ok) {
      return NextResponse.json({ error: data }, { status: res.status });
    }

    const msg = data.choices?.[0]?.message ?? {};
    const { content, thinking } = splitThinking(msg.content ?? "", msg.reasoning_content);

    return NextResponse.json({
      content,
      thinking,
      usage: data.usage,
      latency,
      model: data.model ?? target.alias,
      // Set when the routing could not be honoured and a fallback was used, so
      // the reply is not silently attributed to the model you picked.
      degraded: target.degraded,
      // A reasoning model can spend its whole budget thinking and return an
      // empty answer. Saying so beats rendering a blank bubble.
      truncated: data.choices?.[0]?.finish_reason === "length",
    });
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
      { status: 502 }
    );
  }
}
