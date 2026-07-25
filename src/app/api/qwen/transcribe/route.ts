import { NextRequest, NextResponse } from "next/server";
import { getServiceUrl, getServiceHeaders } from "@/lib/services";

// Proxy mic audio to the local Whisper STT service (OpenAI-compatible). Keeps
// transcription fully local/private — audio never leaves the machine. Whisper
// must be running (:8001); if it's down we surface a clear message.
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const base = getServiceUrl("whisper");
    const res = await fetch(`${base}/v1/audio/transcriptions`, {
      method: "POST",
      headers: getServiceHeaders("whisper"),
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return NextResponse.json({ error: `Whisper returned ${res.status}`, detail: detail.slice(0, 300) }, { status: 502 });
    }
    const data = await res.json();
    return NextResponse.json({ text: data.text ?? "" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Whisper unreachable — start it (whisper on :8001) to use voice input.", detail: message },
      { status: 502 },
    );
  }
}
