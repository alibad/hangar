import { NextRequest, NextResponse } from "next/server";
import { sameAudioOrigin } from "@/lib/audio-origin";
import { servicesForCapability, servedModels } from "@/lib/host";
import { isHostedRuntime } from "@/lib/runtime";

export const runtime = "nodejs";
export async function GET(req: NextRequest) {
  if (isHostedRuntime()) return NextResponse.json({ engines: [], voices: [], localRequired: true });
  const services = servicesForCapability("tts"), engines = services.map(s => ({ id: s.id, name: s.name }));
  const service = services.find(s => s.id === req.nextUrl.searchParams.get("engine")) ?? services[0];
  if (!service) return NextResponse.json({ engines, voices: [], error: "No local neural speech engine is configured" });
  try {
    const r = await fetch(`${service.localUrl}/v1/audio/voices`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error("Engine is not ready");
    const data = await r.json(), rows: unknown[] = Array.isArray(data) ? data : data.voices ?? [];
    const voices = rows.flatMap(v => { if (typeof v === "string") return [{ id: v, label: v }]; if (!v || typeof v !== "object") return []; const x = v as Record<string, string>; const id = x.kokoro_id ?? x.id ?? x.name ?? x.voice; return id ? [{ id, label: x.label ?? (x.kokoro_id && x.name ? `${x.kokoro_id} (${x.name})` : id) }] : []; });
    return NextResponse.json({ engines, engine: service.id, voices });
  } catch { return NextResponse.json({ engines, engine: service.id, voices: [], serviceId: service.id, error: `${service.name} is not running. Start it in Services, then refresh voices.` }); }
}
export async function POST(req: NextRequest) {
  if (isHostedRuntime()) return NextResponse.json({ error: "Tank voice generation runs on your local machine" }, { status: 409 });
  const origin = req.headers.get("origin");
  if (!sameAudioOrigin(origin, req.headers.get("host"))) return NextResponse.json({ error: "Use the local workspace" }, { status: 403 });
  try {
    const body = await req.json(), service = servicesForCapability("tts").find(s => s.id === body.engine);
    if (!service || typeof body.input !== "string" || !body.input.trim() || body.input.length > 1000 || typeof body.voice !== "string" || !body.voice || body.voice.length > 100 || !Number.isFinite(body.speed) || body.speed < .7 || body.speed > 1.3) return NextResponse.json({ error: "Choose a local voice, a short line and a speed between 0.7 and 1.3" }, { status: 400 });
    const response = await fetch(`${service.localUrl}/v1/audio/speech`, { method: "POST", headers: { "Content-Type": "application/json", "X-Source": "hangar-audio-lab" }, body: JSON.stringify({ model: servedModels(service, "tts")[0], input: body.input, voice: body.voice, speed: body.speed, response_format: "wav" }), signal: AbortSignal.timeout(120000) });
    if (!response.ok) return NextResponse.json({ error: `${service.name}: ${(await response.text()).slice(0, 300)}`, serviceId: service.id }, { status: 502 });
    return new NextResponse(await response.arrayBuffer(), { headers: { "Content-Type": response.headers.get("content-type") ?? "audio/wav", "X-Audio-Engine": service.name } });
  } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "Local speech failed" }, { status: 502 }); }
}
