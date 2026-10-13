import { NextRequest, NextResponse } from "next/server";
import { normalizeDecideRequest, type DecideResult } from "@/lib/decide";
import { decide, decideSummary, decisionServiceFor, serviceDevice } from "@/lib/decide-server";
import { getCatalogue } from "@/lib/providers";
import { measureRun, recordLabRun } from "@/lib/lab-runs";
import type { LabRunResult } from "@/lib/lab-types";

export const dynamic = "force-dynamic";
export const maxDuration = 900;

export type DecisionLabOutput = DecideResult;

/**
 * The Decision Lab's run route: one decision by one model, measured and
 * recorded. The model is either a decision model this host serves (Laya) or,
 * from the comparison column, a router chat alias — /api/decide's own path in
 * both cases, so the Lab shows exactly what a caller of the API would get.
 */
export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  const n = normalizeDecideRequest(b);
  if (!n.ok) return NextResponse.json({ error: n.error }, { status: 400 });
  const r = n.req;
  const compareGroup = typeof b?.compareGroup === "string" && b.compareGroup ? b.compareGroup : null;

  const local = decisionServiceFor(r.model)
    ? true
    : ((await getCatalogue()).models.find((m) => m.id === r.model)?.local ?? false);

  const measured = await measureRun(
    async () => {
      const out = await decide(r, { source: "console-lab-decide", owner: `lab:decide:${r.model}`, signal: req.signal });
      if (out.status !== 200) throw Object.assign(new Error((out.body as { error: string }).error), { outcome: out });
      return out.body as DecideResult;
    },
    { local },
  );

  // A decision model on CPU holds no GPU context: the card-wide reading taken
  // during its run is other sessions' work, so it is not reported as this run's.
  // Asked of the service up front rather than read off the result, so a FAILED
  // CPU run is not recorded with the card's VRAM either (the walkthrough of
  // 2026-09-28 caught an aborted run filed at "22.2 GB").
  const svc = decisionServiceFor(r.model);
  const device = svc ? await serviceDevice(svc) : null;
  const m =
    device === "cpu" || (measured.ok && measured.result.device === "cpu")
      ? { ...measured.measurement, peakVramGb: null, baselineVramGb: null, vramNote: "Ran on CPU — no VRAM used." }
      : measured.measurement;
  const failed = !measured.ok
    ? (measured.error as Error & { outcome?: { body: { resourceBlocked?: boolean } } })
    : null;
  const ok = measured.ok ? measured.result : null;

  const run = await recordLabRun({
    lab: "decide",
    capability: "decision",
    model: r.model,
    local,
    compareGroup,
    inputSummary: decideSummary(r),
    params: { type: r.type, choices: Object.keys(r.choices), checkpoint: ok?.checkpoint ?? null },
    status: ok ? "ok" : "error",
    error: failed ? failed.message : null,
    latencyMs: m.latencyMs,
    peakVramGb: m.peakVramGb,
    baselineVramGb: m.baselineVramGb,
    vramNote: m.vramNote,
    costUsd: ok?.costUsd ?? null,
    outputSummary: ok ? `${ok.choice} (${(ok.confidence * 100).toFixed(0)}%)` : null,
  });

  const result: LabRunResult<DecisionLabOutput> = {
    ok: !!ok,
    model: r.model,
    local,
    error: failed?.message,
    resourceBlocked: failed?.outcome?.body.resourceBlocked,
    output: ok ?? undefined,
    runId: run?.id ?? null,
    latencyMs: m.latencyMs,
    peakVramGb: m.peakVramGb,
    baselineVramGb: m.baselineVramGb,
    vramNote: m.vramNote,
    costUsd: ok?.costUsd ?? null,
  };
  return NextResponse.json(result);
}
