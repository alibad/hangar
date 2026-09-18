import { NextResponse } from "next/server";
import { getServiceHeaders } from "@/lib/services";
import { resolveCallTarget, getCatalogue } from "@/lib/providers";

/**
 * Which voices the CURRENTLY ROUTED text-to-speech model can actually use.
 *
 * The Speech tab offered six hardcoded names — alloy, echo, fable, onyx, nova,
 * shimmer. That happened to be right for local Kokoro, whose wrapper maps those
 * six onto real Kokoro ids, and wrong for everything else: the same six were
 * offered when routing pointed at a Gemini TTS model that has never heard of
 * them, and they hid the other ~40 voices Kokoro accepts by its own id.
 *
 * So ask, rather than declare. A local service is asked directly and its answer
 * wins, because it is the only source that cannot drift from what the running
 * process will accept. Cloud engines go through the router, which proxies speech
 * but has no endpoint to enumerate voices, so those fall back to `voices` in
 * config/model-meta.json — and to nothing at all when that is absent, which the
 * UI turns into a free-text box rather than a list of guesses.
 */

export type VoiceOption = {
  /** Sent as `voice` in the speech request. */
  id: string;
  /** What to show, when the id alone is not the clearest label. */
  label?: string;
};

type VoicesResponse = {
  alias: string;
  /** Where the list came from — "none" means the caller should free-type. */
  source: "service" | "declared" | "none";
  local: boolean;
  voices: VoiceOption[];
  /** Why the list is empty, when it is. */
  detail?: string;
  /**
   * Set when the routing could not be honoured, e.g. the router is down and a
   * cloud alias fell back to the local service. Without it this endpoint reports
   * the alias you ASKED for beside the voices of the engine that will actually
   * answer — Kokoro's six against a Gemini alias — with nothing saying why.
   */
  degraded?: string;
};

/**
 * Speech servers disagree about the shape of this payload, and all three shapes
 * below are in the wild. Kokoro's wrapper returns the first.
 *
 *   { voices: [{ name: "alloy", kokoro_id: "af_heart" }] }
 *   { voices: ["af_heart", "am_adam"] }
 *   ["af_heart", "am_adam"]
 */
function normalise(payload: unknown): VoiceOption[] {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { voices?: unknown })?.voices)
      ? (payload as { voices: unknown[] }).voices
      : [];

  const out: VoiceOption[] = [];
  for (const entry of list) {
    if (typeof entry === "string") {
      if (entry.trim()) out.push({ id: entry.trim() });
      continue;
    }
    if (entry && typeof entry === "object") {
      const e = entry as Record<string, unknown>;
      const id = [e.id, e.name, e.voice, e.voice_id].find(
        (v): v is string => typeof v === "string" && !!v.trim(),
      );
      if (!id) continue;
      // Keep the engine's own id visible when the friendly name is an alias for
      // it — "alloy (af_heart)" is the only way to tell which voice you get.
      const underlying = [e.kokoro_id, e.model_id, e.underlying].find(
        (v): v is string => typeof v === "string" && !!v.trim() && v !== id,
      );
      out.push({ id: id.trim(), label: underlying ? `${id.trim()} (${underlying})` : undefined });
    }
  }
  // Same voice can arrive twice when a server lists aliases beside real ids.
  const seen = new Set<string>();
  return out.filter((v) => (seen.has(v.id) ? false : (seen.add(v.id), true)));
}

export async function GET() {
  let alias = "";
  try {
    const target = await resolveCallTarget("tts");
    alias = target.alias;

    if (target.via === "service") {
      try {
        const res = await fetch(`${target.baseUrl}/v1/audio/voices`, {
          headers: target.serviceId ? getServiceHeaders(target.serviceId) : {},
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          const voices = normalise(await res.json());
          if (voices.length) {
            return NextResponse.json<VoicesResponse>({
              alias,
              source: "service",
              local: true,
              voices,
              degraded: target.degraded,
            });
          }
        }
      } catch {
        /* Service down or has no such endpoint — fall through to the declaration. */
      }
    }

    // Declared fallback, read through the same catalogue everything else uses.
    const { models } = await getCatalogue();
    const declared = models.find((m) => m.id === alias)?.voices ?? [];
    if (declared.length) {
      return NextResponse.json<VoicesResponse>({
        alias,
        source: "declared",
        local: target.local,
        voices: declared.map((id) => ({ id })),
        degraded: target.degraded,
      });
    }

    return NextResponse.json<VoicesResponse>({
      alias,
      source: "none",
      local: target.local,
      voices: [],
      degraded: target.degraded,
      // Name the thing that ACTUALLY answered, not the alias that was asked for.
      // On a degraded fallback those differ, and using the alias produced
      // "gemini-2.5-flash-preview-tts did not answer ... Start it", which is
      // advice you cannot act on — the service to start is the local one.
      detail: target.local
        ? `${target.degraded ? (target.serviceId ?? alias) : alias} did not answer /v1/audio/voices. Start it, or type a voice name.`
        : `No voice list is known for ${alias}. Add "voices" to config/model-meta.json, or type one.`,
    });
  } catch (err) {
    return NextResponse.json<VoicesResponse>(
      { alias, source: "none", local: false, voices: [], detail: String(err) },
      { status: 200 },
    );
  }
}
