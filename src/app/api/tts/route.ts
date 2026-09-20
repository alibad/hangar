import { NextRequest, NextResponse } from "next/server";
import { getServiceHeaders } from "@/lib/services";
import { resolveCallTarget, type CallTarget } from "@/lib/providers";

// Speak text with whatever model the `tts` capability is pointed at: the local
// Kokoro service directly, or a cloud voice via the AI Router. Which one answered
// comes back in X-TTS-Model, so the Speech tab can name it instead of implying
// "local" unconditionally.
export async function POST(req: NextRequest) {
  const start = Date.now();
  // Outside the try so a refused connection can name the model that was picked.
  let target: CallTarget | null = null;
  try {
    const body = await req.json();
    // Falls back to local Kokoro (served-model-name "kokoro") when the routing
    // can't be resolved — what this route did before it honoured the routing.
    target = await resolveCallTarget("tts");

    const res = await fetch(`${target.baseUrl}/v1/audio/speech`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(target.via === "service" ? getServiceHeaders(target.serviceId!) : {}),
      },
      body: JSON.stringify({ ...body, model: target.model }),
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) {
      return NextResponse.json(
        {
          error: `TTS server returned ${res.status}`,
          model: target.alias,
          detail: (await res.text()).slice(0, 500),
        },
        { status: res.status }
      );
    }

    const audioBuffer = await res.arrayBuffer();
    const latency = Date.now() - start;

    return new NextResponse(audioBuffer, {
      headers: {
        "Content-Type": res.headers.get("content-type") ?? "audio/wav",
        "X-TTS-Latency": String(latency),
        "X-TTS-Model": target.alias,
        "X-TTS-Via": target.via,
        ...(target.degraded ? { "X-TTS-Degraded": target.degraded } : {}),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const cause = err instanceof Error && err.cause ? String(err.cause) : "";
    // The service id rides along so the caller can render a Start button rather
    // than a sentence pointing at a picker it may not be showing.
    const unreachable =
      target &&
      (target.via === "service"
        ? `${target.alias} is unreachable — start its service, or point text-to-speech at another model.`
        : `The AI Router is unreachable, so ${target.alias} can't be called.`);
    return NextResponse.json(
      { error: unreachable ?? `TTS error: ${message}`, detail: unreachable ? message : undefined, model: target?.alias, serviceId: target?.serviceId, cause },
      { status: 502 }
    );
  }
}
