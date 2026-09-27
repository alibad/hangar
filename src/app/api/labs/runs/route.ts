import { NextRequest, NextResponse } from "next/server";
import { listLabRuns, recordLabRun } from "@/lib/lab-runs";
import { isCapabilityId } from "@/lib/capabilities";

export const dynamic = "force-dynamic";

/** GET ?lab=<id>&limit=<n> — recent runs, newest first. */
export async function GET(req: NextRequest) {
  const lab = req.nextUrl.searchParams.get("lab") || undefined;
  const limit = Number(req.nextUrl.searchParams.get("limit")) || 30;
  try {
    return NextResponse.json({ runs: await listLabRuns({ lab, limit }) });
  } catch (err) {
    return NextResponse.json({ error: String(err), runs: [] }, { status: 500 });
  }
}

/**
 * POST — record a run the server did not wrap itself (e.g. one driven from the
 * browser against a service directly). VRAM fields are ignored: only the server
 * can sample the card while the work happens, so a client-sent number would be
 * a guess recorded as a measurement.
 */
export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  if (typeof b?.lab !== "string" || !b.lab) return NextResponse.json({ error: "lab is required" }, { status: 400 });
  if (!isCapabilityId(b?.capability)) return NextResponse.json({ error: "capability is invalid" }, { status: 400 });
  if (typeof b?.model !== "string" || !b.model) return NextResponse.json({ error: "model is required" }, { status: 400 });
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const str = (v: unknown) => (typeof v === "string" ? v : null);

  const run = await recordLabRun({
    lab: b.lab,
    capability: b.capability,
    model: b.model,
    local: b.local === true,
    compareGroup: str(b.compareGroup),
    inputSummary: str(b.inputSummary) ?? "",
    params: b.params && typeof b.params === "object" ? b.params : {},
    seed: num(b.seed),
    status: b.status === "error" ? "error" : "ok",
    error: str(b.error),
    latencyMs: num(b.latencyMs),
    vramNote: "Recorded by the client — not measured.",
    costUsd: num(b.costUsd),
    outputPath: str(b.outputPath),
    outputSummary: str(b.outputSummary),
  });
  if (!run) return NextResponse.json({ error: "Could not record the run." }, { status: 500 });
  return NextResponse.json({ run });
}
