import { NextRequest, NextResponse } from "next/server";
import { getServiceUrl, getServiceHeaders } from "@/lib/services";
import { varyPrompts } from "@/lib/prompt-variations";

// Where the prompt-variation LLM lives. Defaults to the registered vLLM, but
// any OpenAI-compatible /v1/chat/completions endpoint works — point these at a
// thin local model (e.g. a 1-3B instruct) if you'd rather not run the 32B.
const LLM_MODEL = process.env.QWEN_LLM_MODEL || "Qwen/Qwen2.5-Coder-32B-Instruct-AWQ";

function llmBase(): string {
  return process.env.QWEN_LLM_URL || getServiceUrl("vllm");
}

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

async function aiPrompts(idea: string, count: number, style?: string): Promise<string[] | null> {
  const sys =
    "You are a creative prompt engineer for a text-to-image model. Given a base idea, " +
    "produce diverse, vivid prompts that each vary the style, lighting, composition, and mood " +
    "while keeping the core subject. Return ONLY a JSON array of strings, no commentary.";
  const user = `Base idea: ${idea}\n${style ? `Style hint: ${style}\n` : ""}Produce exactly ${count} distinct prompts as a JSON array.`;
  try {
    const res = await fetch(`${llmBase()}/v1/chat/completions`, {
      method: "POST",
      headers: getServiceHeaders("vllm", { "Content-Type": "application/json" }),
      body: JSON.stringify({
        model: LLM_MODEL,
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
    return prompts.length > 0 ? prompts : null;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const idea = String(body.idea ?? "").trim();
  const count = Math.max(1, Math.min(200, Math.floor(body.count ?? 10)));
  const style = body.style ? String(body.style) : undefined;
  const mode = body.mode === "ai" ? "ai" : "template";

  if (!idea) return NextResponse.json({ error: "idea is required" }, { status: 400 });

  if (mode === "ai") {
    const ai = await aiPrompts(idea, count, style);
    if (ai && ai.length) {
      // top up if the model returned fewer than asked
      const prompts = ai.length >= count ? ai.slice(0, count) : [...ai, ...varyPrompts(idea, count, style)].slice(0, count);
      return NextResponse.json({ prompts, mode: "ai", model: LLM_MODEL });
    }
    // LLM down / unparseable → transparent fallback
    return NextResponse.json({ prompts: varyPrompts(idea, count, style), mode: "template", fellBack: true });
  }

  return NextResponse.json({ prompts: varyPrompts(idea, count, style), mode: "template" });
}
