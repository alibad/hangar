import { NextRequest, NextResponse } from "next/server";
import { chatOnce, type ChatOnceOk } from "@/lib/chat-once";
import { getCatalogue } from "@/lib/providers";
import { measureRun, recordLabRun } from "@/lib/lab-runs";
import type { LabRunResult } from "@/lib/lab-types";

export const dynamic = "force-dynamic";
/** A cold local model can take minutes to load. */
export const maxDuration = 900;

export type TextLabOutput = Pick<ChatOnceOk, "content" | "thinking" | "usage" | "truncated" | "adjusted">;

/**
 * Run one text model once, measured and recorded — the Text Lab's run route
 * and the reference for every other Lab's: validate, measureRun(), recordLabRun(),
 * answer with a LabRunResult.
 *
 * The call is chatOnce(), the Arena's own path, so the two surfaces cannot
 * disagree about how a model is called.
 */
export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  const model = typeof b?.model === "string" ? b.model.trim() : "";
  const prompt = typeof b?.prompt === "string" ? b.prompt : "";
  if (!model) return NextResponse.json({ error: "model is required" }, { status: 400 });
  if (!prompt.trim()) return NextResponse.json({ error: "prompt is required" }, { status: 400 });
  const seed = Number.isInteger(b?.seed) ? (b.seed as number) : null;
  const temperature = typeof b?.temperature === "number" ? Math.max(0, Math.min(2, b.temperature)) : 0;
  const maxTokens = Number(b?.maxTokens) || 4096;
  const compareGroup = typeof b?.compareGroup === "string" ? b.compareGroup : null;

  // Whether to sample the card depends on where the model runs; ask the
  // catalogue once up front rather than trusting the client.
  const { models } = await getCatalogue();
  const local = models.find((m) => m.id === model)?.local ?? false;

  const measured = await measureRun(
    async () => {
      const r = await chatOnce({
        model,
        prompt,
        maxTokens,
        temperature,
        seed,
        source: "console-lab-text",
        owner: `lab:text:${model}`,
        signal: req.signal,
        timeoutMs: maxDuration * 1000,
      });
      if (r.status !== 200) throw Object.assign(new Error((r.body as { error: string }).error), { chat: r });
      return r.body as ChatOnceOk;
    },
    { local },
  );

  const m = measured.measurement;
  const failed = !measured.ok ? (measured.error as Error & { chat?: { status: number; body: { resourceBlocked?: boolean } } }) : null;
  const ok = measured.ok ? measured.result : null;

  const run = await recordLabRun({
    lab: "text",
    capability: "text",
    model,
    local,
    compareGroup,
    inputSummary: prompt.trim().replace(/\s+/g, " "),
    // What was ASKED, plus what the model refused — so a row is never read as
    // greedy when it was not.
    params: { temperature, maxTokens, ...(ok?.adjusted.length ? { adjusted: ok.adjusted } : {}) },
    seed,
    status: ok ? "ok" : "error",
    error: failed ? failed.message : null,
    latencyMs: m.latencyMs,
    peakVramGb: m.peakVramGb,
    baselineVramGb: m.baselineVramGb,
    vramNote: m.vramNote,
    costUsd: ok?.costUsd ?? null,
    outputSummary: ok ? ok.content.trim().replace(/\s+/g, " ") : null,
  });

  const result: LabRunResult<TextLabOutput> = {
    ok: !!ok,
    model,
    local,
    error: failed?.message,
    resourceBlocked: failed?.chat?.body.resourceBlocked,
    output: ok ? { content: ok.content, thinking: ok.thinking, usage: ok.usage, truncated: ok.truncated, adjusted: ok.adjusted } : undefined,
    runId: run?.id ?? null,
    latencyMs: m.latencyMs,
    peakVramGb: m.peakVramGb,
    baselineVramGb: m.baselineVramGb,
    vramNote: m.vramNote,
    costUsd: ok?.costUsd ?? null,
  };
  // Always 200 with ok:false on a model failure: the run happened and was
  // recorded; the Lab renders the error in that model's column.
  return NextResponse.json(result);
}
