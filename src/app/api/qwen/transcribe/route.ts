import { NextRequest, NextResponse } from "next/server";
import { getServiceHeaders } from "@/lib/services";
import { resolveCallTarget } from "@/lib/providers";

/**
 * Mic audio from the Studio's voice input, transcribed by whatever the `stt`
 * capability is pointed at.
 *
 * This used to call the whisper service directly, by id, on :8001 — which is
 * the same mistake the Speech tab had before /api/stt existed: the console's
 * own speech-model picker could not affect a transcription the console itself
 * was making. Two paths into one capability, one of them ignoring the routing,
 * is how you end up comparing two models and unknowingly measuring one.
 *
 * Whatever the routing resolves to is used, local or cloud. Audio staying on
 * the box is therefore now a consequence of the ROUTE rather than of this file,
 * which is the honest place for that decision to live — but it does mean
 * pointing stt at a cloud model sends microphone audio off-box, so the response
 * names the model that handled it.
 */
export async function POST(req: NextRequest) {
  let alias: string | undefined;
  try {
    const form = await req.formData();
    const target = await resolveCallTarget("stt", "whisper", "whisper-1");
    alias = target.alias;

    // The local server only knows its own served-model-name; the router wants
    // the alias. resolveCallTarget already worked out which is which.
    form.set("model", target.model);

    const res = await fetch(`${target.baseUrl}/v1/audio/transcriptions`, {
      method: "POST",
      headers: target.via === "service" ? getServiceHeaders(target.serviceId ?? "whisper") : {},
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return NextResponse.json(
        { error: `${target.alias} returned ${res.status}`, detail: detail.slice(0, 300), model: target.alias },
        { status: 502 },
      );
    }
    const data = await res.json();
    return NextResponse.json({
      text: data.text ?? "",
      model: target.alias,
      via: target.via,
      degraded: target.degraded,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      {
        error: alias
          ? `${alias} is unreachable — start its service, or point speech-to-text at another model.`
          : "Speech-to-text is unreachable — start the service to use voice input.",
        detail: message,
        model: alias,
      },
      { status: 502 },
    );
  }
}
