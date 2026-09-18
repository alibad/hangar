import { NextRequest, NextResponse } from "next/server";
import { getServiceHeaders } from "@/lib/services";
import { resolveCallTarget, type CallTarget } from "@/lib/providers";

export const maxDuration = 300;

/**
 * Transcribe audio with whatever model the `stt` capability is pointed at.
 *
 * The Speech tab used to POST straight from the browser to Whisper's public URL,
 * which meant the console's own speech-model picker could not affect the thing it
 * was picking for. Going through here makes the choice real: local Whisper stays a
 * direct call, a cloud model goes via the AI Router.
 */
export async function POST(req: NextRequest) {
  const start = Date.now();
  // Kept outside the try so a connection failure can name the model that was
  // unreachable — "fetch failed" alone doesn't tell you to go start Whisper.
  let target: CallTarget | null = null;
  try {
    const inbound = await req.formData();
    const file = inbound.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "An audio file is required" }, { status: 400 });
    }

    // No service named here: when the router can't resolve the routing, the
    // fallback is whichever service the host profile says serves `stt`.
    target = await resolveCallTarget("stt");

    const form = new FormData();
    form.append("file", file, file.name || "audio.webm");
    form.append("model", target.model);

    const res = await fetch(`${target.baseUrl}/v1/audio/transcriptions`, {
      method: "POST",
      // The service the routing actually resolved to, not the one this file
      // happens to be named after. Hardcoding "whisper" here meant pointing the
      // stt capability at any other local ASR service sent that service
      // whisper's credentials, which is a 502 whose cause is invisible.
      headers: target.via === "service" ? getServiceHeaders(target.serviceId!) : {},
      body: form,
      signal: AbortSignal.timeout(180_000),
    });

    const latency = Date.now() - start;
    const text = await res.text();
    if (!res.ok) {
      return NextResponse.json(
        { error: `Transcription failed (${res.status})`, detail: text.slice(0, 500), model: target.alias, latency },
        { status: res.status },
      );
    }

    let parsed: { text?: string } = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { text }; // some servers answer text/plain for response_format=text
    }

    return NextResponse.json({
      text: parsed.text ?? "",
      latency,
      model: target.alias,
      via: target.via,
      degraded: target.degraded,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // No "from the picker above" — this route answers the Speech tab AND the
    // image studio's mic, and only one of them has a picker above anything.
    // The service id rides along instead, so each caller can offer Start where
    // it actually shows the failure.
    const unreachable =
      target &&
      (target.via === "service"
        ? `${target.alias} is unreachable — start its service, or point speech-to-text at another model.`
        : `The AI Router is unreachable, so ${target.alias} can't be called.`);
    return NextResponse.json(
      {
        error: unreachable ?? `Transcription error: ${reason}`,
        detail: unreachable ? reason : undefined,
        model: target?.alias,
        serviceId: target?.serviceId,
        latency: Date.now() - start,
      },
      { status: 502 },
    );
  }
}
