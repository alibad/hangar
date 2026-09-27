import { NextRequest, NextResponse } from "next/server";
import { chatOnce } from "@/lib/chat-once";

export const dynamic = "force-dynamic";
/** A cold 20 GB local model plus a long vision prompt is minutes, not seconds. */
export const maxDuration = 900;

/**
 * Run ONE model against one prompt, for the Arena.
 *
 * One model per request, deliberately. The obvious design is a single call that
 * fans out server-side and returns when every model is done — and that is what
 * /api/image/compare did before it was abandoned for exactly this reason: the UI
 * can say nothing but "running" until the SLOWEST model lands, which on a cold
 * local 31B is minutes of dead screen. One request per model means each tile
 * reports its own state, results appear as they finish, and one model can be
 * cancelled or fail without taking the others with it. The fan-out lives in the
 * component; see arena-view.tsx.
 *
 * The call itself lives in src/lib/chat-once.ts, shared with the Text Lab.
 * Everything goes through the AI Router rather than straight to the serving
 * port, even for local models. That is what makes the comparison legible
 * afterwards: the router's callback records model alias, latency, token counts
 * and cost into the Requests view, so an Arena run is visible next to every
 * other call on the box instead of being invisible traffic. `X-Source` tags the
 * rows so they can be told apart from ordinary playground use.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const model: unknown = body?.model;
  const prompt: unknown = body?.prompt;
  const image: unknown = body?.image; // data: URL, optional
  // 4096, not 2048: unlike the experiment harness, this path does not disable
  // reasoning, and a thinking model can spend most of a small budget before it
  // begins answering — which surfaces as a mysteriously empty tile.
  const maxTokens = Number(body?.maxTokens) || 4096;

  if (typeof model !== "string" || !model.trim()) {
    return NextResponse.json({ error: "model is required" }, { status: 400 });
  }
  if (typeof prompt !== "string" || !prompt.trim()) {
    return NextResponse.json({ error: "prompt is required" }, { status: 400 });
  }
  if (image !== undefined && (typeof image !== "string" || !image.startsWith("data:image/"))) {
    return NextResponse.json({ error: "image must be a data:image/ URL" }, { status: 400 });
  }

  // The rules (catalogue validation, Ollama lease, thinking split) live in
  // chat-once so the Text Lab cannot drift from them.
  const { status, body: out } = await chatOnce({
    model,
    prompt,
    image: image as string | undefined,
    maxTokens,
    source: "console-arena",
    owner: `arena:${model}`,
    signal: req.signal,
    timeoutMs: maxDuration * 1000,
  });
  return NextResponse.json(out, { status });
}
