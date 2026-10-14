import { NextRequest, NextResponse } from "next/server";
import { sameAudioOrigin } from "@/lib/audio-origin";
import { audioLibrary, saveAudioImport, saveAudioRevision, reviewAudioRevision } from "@/lib/audio-store";
import { isHostedRuntime } from "@/lib/runtime";

export const runtime = "nodejs";
export async function GET() {
  if (isHostedRuntime()) return NextResponse.json({ revisions: [], assets: [], localRequired: true });
  try { return NextResponse.json(await audioLibrary(), { headers: { "Cache-Control": "no-store" } }); } catch { return NextResponse.json({ error: "Audio library could not be read. Existing files have been preserved." }, { status: 500 }); }
}
export async function POST(req: NextRequest) {
  if (isHostedRuntime()) return NextResponse.json({ error: "Open Hangar on your local machine to save or import audio." }, { status: 409 });
  const origin = req.headers.get("origin");
  if (!sameAudioOrigin(origin, req.headers.get("host"))) return NextResponse.json({ error: "Use the local Hangar workspace to change audio." }, { status: 403 });
  if (Number(req.headers.get("content-length") ?? 0) > 21000000) return NextResponse.json({ error: "Audio request exceeds 20 MB" }, { status: 413 });
  try {
    const form = await req.formData(), action = form.get("action");
    if (action === "review") { await reviewAudioRevision(String(form.get("id")), String(form.get("status")) as "draft", String(form.get("notes") ?? "")); return NextResponse.json({ ok: true }); }
    const file = form.get("audio");
    if (!(file instanceof File) || file.size > 20000000) return NextResponse.json({ error: "Choose an audio file under 20 MB" }, { status: 400 });
    const bytes = Buffer.from(await file.arrayBuffer());
    if (action === "import") return NextResponse.json(await saveAudioImport(bytes, file.name.slice(0, 160), file.name.split(".").pop()?.toLowerCase() ?? "", String(form.get("license") ?? "")));
    if (action !== "render") return NextResponse.json({ error: "Unknown audio action" }, { status: 400 });
    return NextResponse.json(await saveAudioRevision(bytes, JSON.parse(String(form.get("metadata")))));
  } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "Audio operation failed" }, { status: 400 }); }
}
