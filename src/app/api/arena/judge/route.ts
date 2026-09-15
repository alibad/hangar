import { NextRequest, NextResponse } from "next/server";
import { getCatalogue, routerUrl } from "@/lib/providers";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Grade a finished Arena run with a second model.
 *
 * Why this exists beside the deterministic scores: CER, chrF and field accuracy
 * answer "did it match", never "is it good". For summarisation, dialect
 * rewriting and open prose there IS no reference string, and inventing one would
 * just measure agreement with whoever wrote it. A judge model reads the outputs
 * and ranks them, which is the only automated answer available for those tasks.
 *
 * Three deliberate constraints, because an LLM judge is easy to fool:
 *
 *  - **The judge does not know who wrote what.** Outputs are relabelled A, B, C
 *    in presentation order and the mapping is kept server-side. Model names in
 *    the prompt buy a known, large bias toward the famous one.
 *  - **The judge is never one of the contestants.** Self-preference is the
 *    best-documented failure mode of LLM-as-judge; a model asked to rank its own
 *    output against a rival's is not an instrument.
 *  - **The verdict is advisory and labelled as such.** It is one model's opinion,
 *    recorded next to the deterministic numbers, never replacing them.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const judge: unknown = body?.judge;
  const task: unknown = body?.task;
  const entries: unknown = body?.entries;

  if (typeof judge !== "string" || !judge.trim()) {
    return NextResponse.json({ error: "judge model is required" }, { status: 400 });
  }
  if (typeof task !== "string" || !task.trim()) {
    return NextResponse.json({ error: "task is required" }, { status: 400 });
  }
  if (!Array.isArray(entries) || entries.length < 2) {
    return NextResponse.json({ error: "at least two outputs are needed to rank" }, { status: 400 });
  }

  const { routerUp, models } = await getCatalogue();
  if (!routerUp) {
    return NextResponse.json({ error: "AI Router is not running." }, { status: 503 });
  }
  const judgeModel = models.find((m) => m.id === judge);
  if (!judgeModel || judgeModel.mode !== "chat") {
    return NextResponse.json({ error: `"${judge}" is not a chat model in the router.` }, { status: 400 });
  }
  if (judgeModel.status !== "ready") {
    return NextResponse.json({ error: judgeModel.detail ?? `"${judge}" is not ready.` }, { status: 409 });
  }

  const contestants = entries
    .filter((e): e is { model: string; content: string } =>
      typeof e?.model === "string" && typeof e?.content === "string" && e.content.trim().length > 0)
    .slice(0, 8);
  if (contestants.length < 2) {
    return NextResponse.json({ error: "at least two non-empty outputs are needed" }, { status: 400 });
  }
  if (contestants.some((c) => c.model === judge)) {
    return NextResponse.json(
      { error: `"${judge}" produced one of these answers — pick a judge that is not competing.` },
      { status: 400 },
    );
  }

  // Blind labels. The mapping never reaches the judge.
  const labels = contestants.map((_, i) => String.fromCharCode(65 + i));
  const blind = contestants
    .map((c, i) => `### Answer ${labels[i]}\n${c.content.slice(0, 6000)}`)
    .join("\n\n");

  const prompt = [
    "You are grading anonymous answers to one task. You do not know which system produced which answer, and you must not speculate about it.",
    "",
    "## Task the answers were responding to",
    task.slice(0, 4000),
    "",
    "## Answers",
    blind,
    "",
    "## What to do",
    "Rank the answers from best to worst for this specific task. If the task is in Arabic or asks for Arabic, weigh correctness of the Arabic — grammar, orthography, register, and whether it is genuinely Modern Standard Arabic where that was asked for — above fluency in English.",
    "State clearly when two answers are equivalent rather than inventing a difference.",
    "",
    "Reply with ONLY a JSON object of this exact shape, no markdown fence:",
    '{"ranking":["A","B"],"scores":{"A":0-10,"B":0-10},"reasons":{"A":"one sentence","B":"one sentence"},"verdict":"one sentence overall"}',
  ].join("\n");

  const started = Date.now();
  try {
    const res = await fetch(`${routerUrl()}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Source": "console-arena-judge" },
      body: JSON.stringify({
        model: judge,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 1500,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(maxDuration * 1000),
    });
    const text = await res.text();
    const latency = Date.now() - started;
    if (!res.ok) return NextResponse.json({ error: text.slice(0, 600), latency }, { status: res.status });

    const data = JSON.parse(text);
    const reply = data.choices?.[0]?.message?.content ?? "";

    return NextResponse.json({
      judge,
      latency,
      costUsd: data.usage?.response_cost ?? null,
      // The label mapping is returned so the UI can put names back on the
      // ranking. It was withheld from the JUDGE, not from the reader.
      labels: Object.fromEntries(contestants.map((c, i) => [labels[i], c.model])),
      raw: reply,
      note: "Advisory. One model's opinion, graded blind — read it beside the deterministic scores, not instead of them.",
    });
  } catch (err) {
    const message = err instanceof Error && err.name === "TimeoutError"
      ? `Judge timed out after ${maxDuration}s.`
      : String(err);
    return NextResponse.json({ error: message, latency: Date.now() - started }, { status: 502 });
  }
}
