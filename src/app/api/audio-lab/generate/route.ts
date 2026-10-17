import { NextRequest, NextResponse } from "next/server";
import { isHostedRuntime } from "@/lib/runtime";
import { sameAudioOrigin } from "@/lib/audio-origin";
import { validEffectRequest } from "@/lib/audio-generation";
import { effectGeneratorStatus, generateEffect } from "@/lib/audio-generator-server";

export const runtime = "nodejs";
export const maxDuration = 300;
export async function GET() {
  if (isHostedRuntime()) return NextResponse.json({ available: false, reason: "Open Hangar locally to generate sound effects." });
  return NextResponse.json(await effectGeneratorStatus(), { headers: { "Cache-Control": "no-store" } });
}
export async function POST(req: NextRequest) {
  if (isHostedRuntime()) return NextResponse.json({ error: "Open Hangar locally to generate sound effects." }, { status: 409 });
  if (!sameAudioOrigin(req.headers.get("origin"), req.headers.get("host"))) return NextResponse.json({ error: "Use the local Hangar workspace to generate audio." }, { status: 403 });
  if (Number(req.headers.get("content-length") ?? 0) > 12000) return NextResponse.json({ error: "Description is too long." }, { status: 413 });
  try {
    const request = await req.json();
    if (!validEffectRequest(request)) return NextResponse.json({ error: "Add a description, a duration from 0.1–30 seconds and a whole-number seed from 0–2147483647." }, { status: 400 });
    return NextResponse.json(await generateEffect(request));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Local generation failed." }, { status: 400 });
  }
}
