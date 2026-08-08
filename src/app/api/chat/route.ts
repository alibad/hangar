import { NextRequest, NextResponse } from "next/server";
import { getActiveLlm } from "@/lib/llm";

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

export async function POST(req: NextRequest) {
  const { message } = await req.json();
  const llm = getActiveLlm();

  const start = Date.now();
  try {
    const res = await fetch(`${llm.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: llm.headers,
      body: JSON.stringify({
        model: llm.model,
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
      model: data.model,
      // A reasoning model can spend its whole budget thinking and return an
      // empty answer. Saying so beats rendering a blank bubble.
      truncated: data.choices?.[0]?.finish_reason === "length",
    });
  } catch (err) {
    return NextResponse.json(
      { error: String(err), latency: Date.now() - start },
      { status: 502 }
    );
  }
}
