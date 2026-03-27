import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const start = Date.now();
  try {
    const body = await req.json();
    const res = await fetch("http://localhost:8002/v1/audio/speech", {
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
    return NextResponse.json(
      { error: `TTS error: ${err}` },
      { status: 500 }
    );
  }
}
