import { NextRequest, NextResponse } from "next/server";
import { getCatalogue, routerUrl } from "@/lib/providers";
import { withResourceLease, ResourceLeaseError } from "@/lib/resource-manager";
import { isResident, unloadOthers, ollamaModelFromTarget } from "@/lib/ollama";

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

  // Validate against the live catalogue rather than trusting the body. An
  // unknown alias would otherwise reach the router and come back as an opaque
  // 400 in a tile, with nothing saying which of the two is wrong.
  const { routerUp, models } = await getCatalogue();
  if (!routerUp) {
    return NextResponse.json(
      { error: "AI Router is not running. Start it from Services." },
      { status: 503 },
    );
  }
  const entry = models.find((m) => m.id === model);
  if (!entry) {
    return NextResponse.json({ error: `Unknown model "${model}".` }, { status: 400 });
  }
  if (entry.mode !== "chat") {
    return NextResponse.json(
      { error: `"${model}" is an ${entry.mode} model — the Arena runs chat models.` },
      { status: 400 },
    );
  }
  // Refuse rather than silently drop the image: a vision comparison where one
  // tile quietly answered from the prompt alone is worse than an error, because
  // its output looks like a real (and terrible) result.
  if (image && !entry.vision) {
    return NextResponse.json(
      { error: `"${model}" does not accept image input.` },
      { status: 400 },
    );
  }
  if (entry.status !== "ready") {
    return NextResponse.json({ error: entry.detail ?? `"${model}" is not ready.` }, { status: 409 });
  }

  const content = image
    // Image BEFORE text: Gemma 4's model card asks for it explicitly, and no
    // model is harmed by the ordering.
    ? [{ type: "image_url", image_url: { url: image } }, { type: "text", text: prompt }]
    : prompt;

  const started = Date.now();

  /** The actual request. Wrapped by admission below for local models only. */
  const call = async () => {
    const res = await fetch(`${routerUrl()}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Source": "console-arena" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content }],
        max_tokens: maxTokens,
        // Every Arena task is convergent — transcribe, translate, extract,
        // compare. Greedy decoding also makes a re-run reproducible, which is
        // the difference between a comparison and an anecdote.
        temperature: 0,
      }),
      signal: AbortSignal.timeout(maxDuration * 1000),
    });
    return { status: res.status, ok: res.ok, text: await res.text() };
  };

  try {
    /*
     * Admission for local models, and the two things that make it correct for a
     * runtime that keeps its model resident. See src/lib/ollama.ts for the full
     * reasoning; in short:
     *
     *  - If the target is ALREADY loaded, no new VRAM is allocated, so no new
     *    admission is needed. Asking for one denies the call over memory the
     *    model itself is already holding — which broke the Arena's core
     *    workflow, where the second model in a comparison was always refused.
     *  - Otherwise evict whatever else Ollama is holding FIRST. Ollama runs one
     *    model at a time, so the next peak replaces the resident one rather than
     *    stacking on it, but the coordinator can only see that once the card has
     *    actually been freed.
     *
     * Concurrent image work stays protected either way: ComfyUI and Qwen-Image
     * run their own admission check against live free VRAM, so they refuse
     * themselves while a chat model is resident.
     */
    let res: { status: number; ok: boolean; text: string };
    if (!entry.local) {
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
          {
            owner: `arena:${model}`, // identifies the caller, carries no prompt
            lane: "interactive",
            signal: req.signal,
            waitMs: 120_000,
          },
          call,
        );
      }
    }

    const latency = Date.now() - started;
    if (!res.ok) {
      return NextResponse.json({ error: res.text.slice(0, 600), latency }, { status: res.status });
    }

    const data = JSON.parse(res.text);
    const msg = data.choices?.[0]?.message ?? {};
    const { content: answer, thinking } = splitThinking(msg.content ?? "", msg.reasoning_content);

    return NextResponse.json({
      model,
      content: answer,
      thinking,
      latency,
      usage: data.usage ?? null,
      // The router's own cost figure where it has one. Local models have none,
      // and reporting 0 would read as "free to run" rather than "not metered".
      costUsd: data.usage?.response_cost ?? null,
      truncated: data.choices?.[0]?.finish_reason === "length",
    });
  } catch (err) {
    // A refused admission is a capacity answer, not a crash — it carries the
    // coordinator's own explanation of what is holding the card, so the tile can
    // tell the reader what to stop rather than just "failed".
    if (err instanceof ResourceLeaseError) {
      return NextResponse.json(
        { error: err.message, resourceBlocked: true, details: err.details, latency: Date.now() - started },
        { status: err.status || 409 },
      );
    }
    const message = err instanceof Error && err.name === "TimeoutError"
      ? `Timed out after ${maxDuration}s. A cold local model can take minutes to load.`
      : String(err);
    return NextResponse.json({ error: message, latency: Date.now() - started }, { status: 502 });
  }
}

/**
 * Split a reasoning model's thinking from its answer.
 *
 * Same two shapes /api/chat already handles: a separate `reasoning_content`
 * field (what LiteLLM normalises every provider's reasoning to) and inline
 * <think> tags (what local Qwen3 emits). Scoring the thinking as part of the
 * answer would report a near-total error for a model that answered correctly
 * after thinking — a conclusion about the harness, not the model.
 */
function splitThinking(content: string, reasoningField?: string | null) {
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
