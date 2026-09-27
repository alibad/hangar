import { NextRequest, NextResponse } from "next/server";
import { chatOnce, type ChatOnceOk } from "@/lib/chat-once";
import { getCatalogue } from "@/lib/providers";
import { measureRun, recordLabRun } from "@/lib/lab-runs";

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
 * The call itself lives in src/lib/chat-once.ts, shared with every other text
 * surface. Every run that reaches a model is also measured and kept in the
 * runs record (src/lib/lab-runs.ts) under `lab: "arena"`, so a comparison
 * survives a reload: which models, what they were asked, latency, card-wide
 * peak VRAM for local ones, cost for cloud ones, and a `compareGroup` tying
 * the tiles of one batch together.
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

  const compareGroup = typeof body?.compareGroup === "string" && body.compareGroup ? body.compareGroup : null;
  const hasImage = typeof image === "string";

  // Fetched here rather than inside chatOnce, because whether to sample the
  // card depends on whether the model is local — and handed on, so the router
  // and every local service are only asked once.
  const catalogue = await getCatalogue();
  const local = catalogue.models.find((m) => m.id === model)?.local ?? false;

  // The rules (catalogue validation, Ollama lease, thinking split, refused
  // parameters) live in chat-once so no text surface can drift from them.
  const measured = await measureRun(
    () =>
      chatOnce({
        model,
        prompt,
        image: image as string | undefined,
        maxTokens,
        source: "console-arena",
        owner: `arena:${model}`,
        signal: req.signal,
        timeoutMs: maxDuration * 1000,
        catalogue,
      }),
    { local },
  );
  if (!measured.ok) {
    return NextResponse.json({ error: String(measured.error) }, { status: 502 });
  }
  const { status, body: out } = measured.result;
  const m = measured.measurement;

  // Only a run that reached the model is a run. A refusal before the call — an
  // unknown alias, a stopped service, the router down, or the coordinator
  // saying the card is full — measured nothing about the model, and recording
  // it would fill the history with rows that look like results. A capacity
  // refusal does carry a `latency` (the time spent waiting for the card), which
  // is why it is excluded by name rather than by that field.
  const refused = "resourceBlocked" in out && out.resourceBlocked;
  if (refused || !("latency" in out) || out.latency == null) return NextResponse.json(out, { status });

  const ok = status === 200 ? (out as ChatOnceOk) : null;
  const run = await recordLabRun({
    lab: "arena",
    capability: hasImage ? "vision" : "text",
    model,
    local,
    compareGroup,
    inputSummary: `${hasImage ? "[image] " : ""}${prompt.trim().replace(/\s+/g, " ")}`,
    // What was ASKED, plus anything the model refused, so a row is never read
    // as greedy when it was not.
    params: { temperature: 0, maxTokens, ...(ok?.adjusted.length ? { adjusted: ok.adjusted } : {}) },
    status: ok ? "ok" : "error",
    error: ok ? null : (out as { error: string }).error,
    // The model call's own time, which is what the tile shows; the measured
    // wall-clock also includes the catalogue lookup.
    latencyMs: out.latency,
    peakVramGb: m.peakVramGb,
    baselineVramGb: m.baselineVramGb,
    vramNote: m.vramNote,
    costUsd: ok?.costUsd ?? null,
    outputSummary: ok ? ok.content.trim().replace(/\s+/g, " ") : null,
  });

  return NextResponse.json(
    { ...out, runId: run?.id ?? null, peakVramGb: m.peakVramGb, baselineVramGb: m.baselineVramGb, vramNote: m.vramNote },
    { status },
  );
}
