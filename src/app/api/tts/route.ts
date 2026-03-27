import { NextRequest, NextResponse } from "next/server";
import { getServiceUrl } from "@/lib/services";

export async function POST(req: NextRequest) {
  const start = Date.now();
  try {
    const body = await req.json();
    const baseUrl = getServiceUrl("tts");
    const res = await fetch(`${baseUrl}/v1/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: `TTS server returned ${res.status}` },
        { status: res.status }
      );
    }

    const audioBuffer = await res.arrayBuffer();
    const latency = Date.now() - start;

    return new NextResponse(audioBuffer, {
      headers: {
        "Content-Type": "audio/wav",
        "X-TTS-Latency": String(latency),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const cause = err instanceof Error && err.cause ? String(err.cause) : "";
    return NextResponse.json(
      { error: `TTS error: ${message}`, cause },
      { status: 500 }
    );
  }
}
