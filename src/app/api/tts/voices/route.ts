import { NextRequest, NextResponse } from "next/server";
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
  /** Learned from a reference clip on this box, and so removable. */
  clone?: boolean;
  /** Length of that reference clip, when the engine reports it. */
  seconds?: number;
};

type VoicesResponse = {
  alias: string;
  /** Where the list came from — "none" means the caller should free-type. */
  source: "service" | "declared" | "none";
  local: boolean;
  voices: VoiceOption[];
  /**
   * Whether the routed engine can learn a NEW voice from a reference clip.
   * Asked of the engine, not inferred from its name: Kokoro's voicepacks are
   * baked into the weights and Chatterbox synthesises from a clip, and no
   * amount of reading the alias tells you which you are holding.
   */
  canClone?: boolean;
  /** How long a reference clip the engine will accept, when it says. */
  limits?: { minSeconds: number; maxSeconds: number };
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
      // An explicit label beats one assembled here. A cloned voice wants to read
      // "Ali — your clone", which no amount of id-plus-underlying produces.
      const label = typeof e.label === "string" && e.label.trim() ? e.label.trim() : undefined;
      out.push({
        id: id.trim(),
        label: label ?? (underlying ? `${id.trim()} (${underlying})` : undefined),
        clone: e.clone === true || undefined,
        seconds: typeof e.seconds === "number" ? e.seconds : undefined,
      });
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
          const payload = await res.json();
          const voices = normalise(payload);
          if (voices.length) {
            const lim = (payload as { limits?: { min_seconds?: unknown; max_seconds?: unknown } })
              ?.limits;
            return NextResponse.json<VoicesResponse>({
              alias,
              source: "service",
              local: true,
              voices,
              canClone: (payload as { can_clone?: unknown })?.can_clone === true,
              limits:
                typeof lim?.min_seconds === "number" && typeof lim?.max_seconds === "number"
                  ? { minSeconds: lim.min_seconds, maxSeconds: lim.max_seconds }
                  : undefined,
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

/**
 * The engine that enrollment has to talk to, or a reason it cannot happen.
 *
 * Enrollment is the one speech operation that is NOT proxied through the AI
 * Router: LiteLLM models a request to speak, not a request to remember a
 * speaker, so there is no route to forward. That makes "is the routed engine a
 * local service" a hard precondition rather than a preference, and the caller
 * needs to be told which of the two possible reasons stopped it.
 */
async function enrollmentTarget(): Promise<
  | { ok: true; alias: string; baseUrl: string; serviceId?: string }
  | { ok: false; status: number; error: string }
> {
  const target = await resolveCallTarget("tts");
  if (target.via !== "service") {
    return {
      ok: false,
      status: 400,
      error: `"${target.alias}" is a cloud voice, so it cannot learn a new one. Point the TTS capability at a local cloning engine first.`,
    };
  }
  return { ok: true, alias: target.alias, baseUrl: target.baseUrl, serviceId: target.serviceId };
}

/** Teach the routed engine a voice from a reference clip. */
export async function POST(req: NextRequest) {
  try {
    const target = await enrollmentTarget();
    if (!target.ok) return NextResponse.json({ error: target.error }, { status: target.status });

    // Streamed straight through rather than buffered and rebuilt: the body is
    // already multipart in exactly the shape the service wants, and re-encoding
    // it here would only add a place for the boundary to get lost.
    const res = await fetch(`${target.baseUrl}/v1/audio/voices`, {
      method: "POST",
      headers: target.serviceId ? getServiceHeaders(target.serviceId) : {},
      body: await req.formData(),
      signal: AbortSignal.timeout(60000),
    });

    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      // 405 is checked BEFORE `detail`, not after. A speech server with no
      // enrollment route still answers with FastAPI's own {"detail":"Method Not
      // Allowed"}, and preferring `detail` made that the message the user saw —
      // technically true, and no help at all.
      if (res.status === 405 || res.status === 404) {
        return NextResponse.json(
          {
            error: `"${target.alias}" has fixed voices and cannot learn a new one. Switch the model above to a cloning engine.`,
          },
          { status: 400 },
        );
      }
      // Otherwise the engine's own message is the useful one — it is what
      // explains a clip being too short, or a name already taken.
      const detail = (payload as { detail?: unknown })?.detail;
      return NextResponse.json(
        { error: typeof detail === "string" ? detail : `Enrollment failed (${res.status}).` },
        { status: res.status },
      );
    }
    return NextResponse.json(payload);
  } catch (err) {
    return NextResponse.json({ error: `Could not reach the voice engine: ${String(err)}` }, { status: 502 });
  }
}

/** Forget a cloned voice, and its stored reference clip with it. */
export async function DELETE(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Which voice? Pass ?id=" }, { status: 400 });
  try {
    const target = await enrollmentTarget();
    if (!target.ok) return NextResponse.json({ error: target.error }, { status: target.status });

    const res = await fetch(`${target.baseUrl}/v1/audio/voices/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: target.serviceId ? getServiceHeaders(target.serviceId) : {},
      signal: AbortSignal.timeout(15000),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = (payload as { detail?: unknown })?.detail;
      return NextResponse.json(
        { error: typeof detail === "string" ? detail : `Could not delete "${id}" (${res.status}).` },
        { status: res.status },
      );
    }
    return NextResponse.json(payload);
  } catch (err) {
    return NextResponse.json({ error: `Could not reach the voice engine: ${String(err)}` }, { status: 502 });
  }
}
