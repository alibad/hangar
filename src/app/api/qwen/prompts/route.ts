import { NextRequest, NextResponse } from "next/server";
import { varyPrompts, type DimConfig } from "@/lib/prompt-variations";
import { getServiceHeaders } from "@/lib/services";
import { resolveCallTarget } from "@/lib/providers";

// The prompt-variation LLM is whichever one is currently selected in the console
// (see /api/llm + the LLM picker). Env (QWEN_LLM_URL/QWEN_LLM_MODEL) still overrides.

// Pull a JSON string array out of the model's reply, tolerating code fences or
// a plain newline list.
function parsePrompts(text: string, count: number): string[] {
  let out: string[] = [];
  const match = text.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      const arr = JSON.parse(match[0]);
      if (Array.isArray(arr)) out = arr.map((s) => String(s).trim()).filter(Boolean);
    } catch {
      /* fall through */
    }
  }
  if (out.length === 0) {
    out = text
      .split("\n")
      .map((l) => l.replace(/^\s*(?:[-*\d.)]+\s*)/, "").trim())
      .filter((l) => l.length > 3);
  }
  return out.slice(0, count);
}

async function aiPrompts(
  idea: string,
  count: number,
  suffix?: string,
  dims?: DimConfig,
): Promise<{ prompts: string[]; model: string } | null> {
  // The `text` capability, same as the playground — not `active-llm.json`.
  // Reading that second record here had the same effect it had in /api/chat:
  // prompt generation called whichever service that file last named, ignoring
  // the model the console's picker is pointed at, and failed outright when that
  // service was not running.
  const llm = await resolveCallTarget("text");
  const activeDims = Object.entries(dims ?? {})
    .filter(([, v]) => v?.on)
    .map(([k, v]) => v?.locked ? `${k}="${v.locked}" (fixed)` : k)
    .join(", ");
  const sys =
    "You are a creative prompt engineer for a text-to-image model. Given a base idea, " +
    "produce diverse, vivid prompts that vary along the requested dimensions while keeping " +
    "the core subject. Return ONLY a JSON array of strings, no commentary.";
  const user = [
    `Base idea: ${idea}`,
    activeDims ? `Vary these dimensions: ${activeDims}` : "",
    suffix ? `Append to every prompt: ${suffix}` : "",
    `Produce exactly ${count} distinct prompts as a JSON array.`,
  ].filter(Boolean).join("\n");
  try {
    const res = await fetch(`${llm.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(llm.serviceId ? getServiceHeaders(llm.serviceId) : {}),
      },
      body: JSON.stringify({
        model: llm.model,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user },
        ],
        temperature: 1.0,
        max_tokens: Math.min(4096, 60 * count + 200),
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text: string = data?.choices?.[0]?.message?.content ?? "";
    const prompts = parsePrompts(text, count);
    return prompts.length > 0 ? { prompts, model: llm.model } : null;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const idea = String(body.idea ?? "").trim();
  const count = Math.max(1, Math.min(200, Math.floor(body.count ?? 10)));
  const suffix = body.suffix ? String(body.suffix) : undefined;
  const dims: DimConfig = body.dims ?? {};
  const mode = body.mode === "ai" ? "ai" : "template";

  if (!idea) return NextResponse.json({ error: "idea is required" }, { status: 400 });

  if (mode === "ai") {
    const ai = await aiPrompts(idea, count, suffix, dims);
    if (ai && ai.prompts.length) {
      const prompts =
        ai.prompts.length >= count
          ? ai.prompts.slice(0, count)
          : [...ai.prompts, ...varyPrompts(idea, count, dims, suffix)].slice(0, count);
      return NextResponse.json({ prompts, mode: "ai", model: ai.model });
    }
    return NextResponse.json({ prompts: varyPrompts(idea, count, dims, suffix), mode: "template", fellBack: true });
  }

  return NextResponse.json({ prompts: varyPrompts(idea, count, dims, suffix), mode: "template" });
}
