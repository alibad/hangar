import { NextRequest, NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { getServiceHeaders, getServiceUrl } from "@/lib/services";
import { ResourceLeaseError, withResourceLease } from "@/lib/resource-manager";
import { measureRun, recordLabRun } from "@/lib/lab-runs";
import { AUDIO_TYPES, readTrack, saveTrack, trackAudioPath, updateTrack, type MusicMeta, type MusicTrack } from "@/lib/music-store";
import type { LabRunResult } from "@/lib/lab-types";

export const dynamic = "force-dynamic";
/** A 10-minute song with the LM planner is minutes of work; a cold start adds more. */
export const maxDuration = 900;

export type MusicLabOutput = { track: MusicTrack; url: string };

/** Form fields passed through to the service unchanged, when present. */
const PASS = [
  "task", "caption", "lyrics", "instrumental", "duration", "seed", "bpm", "keyscale", "timesignature",
  "vocal_language", "steps", "guidance", "thinking", "repaint_start", "repaint_end", "extend_seconds",
  "cover_strength", "track", "tracks", "format", "rewrite_caption", "fade_in", "fade_out",
] as const;

class ServiceError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

/**
 * Run the music model once, measured and recorded — the Music Lab's run route.
 *
 * Multipart, because the audio-in tasks (extend, repaint, remix, stems) carry a
 * clip: either an upload (`src_audio`) or a gallery track (`src_track`), which
 * is read from disk here so a round trip through the browser is not needed to
 * extend the thing you just made.
 *
 * The model is a host service rather than a router alias, so there is no cloud
 * column: nothing in the router makes music.
 */
export async function POST(req: NextRequest) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart form data." }, { status: 400 });
  }
  const model = String(form.get("model") ?? "ace-step-1.5");
  const task = String(form.get("task") ?? "text2music");
  const caption = String(form.get("caption") ?? "").trim();
  const lyrics = String(form.get("lyrics") ?? "");
  const instrumental = String(form.get("instrumental") ?? "") === "true";
  const format = String(form.get("format") ?? "flac");
  const compareGroup = (form.get("compareGroup") as string | null) || null;
  if (!AUDIO_TYPES[format]) return NextResponse.json({ error: `format must be one of ${Object.keys(AUDIO_TYPES).join(", ")}` }, { status: 400 });
  if (task === "text2music" && !caption && !lyrics.trim()) {
    return NextResponse.json({ error: "Describe the music, or give it lyrics." }, { status: 400 });
  }

  const out = new FormData();
  for (const k of PASS) {
    const v = form.get(k);
    if (v != null && v !== "") out.append(k, String(v));
  }
  out.set("format", format);

  // The clip an audio-in task works on.
  let source: MusicTrack | null = null;
  let sourceName: string | null = null;
  const upload = form.get("src_audio");
  const srcTrack = String(form.get("src_track") ?? "");
  if (upload instanceof Blob && upload.size > 0) {
    sourceName = (upload as File).name || "upload";
    out.append("src_audio", upload, sourceName);
  } else if (srcTrack) {
    source = await readTrack(srcTrack);
    const p = await trackAudioPath(srcTrack);
    if (!source || !p) return NextResponse.json({ error: `No track "${srcTrack}" in the gallery.` }, { status: 404 });
    sourceName = source.caption || source.id;
    out.append("src_audio", new Blob([new Uint8Array(await readFile(p.path))], { type: AUDIO_TYPES[p.format] }), `${source.id}.${p.format}`);
  }

  // Optional timbre/style reference — a clip whose sound the output should borrow.
  const reference = form.get("reference_audio");
  const referenceName = reference instanceof Blob && reference.size > 0 ? (reference as File).name || "reference" : null;
  if (referenceName) out.append("reference_audio", reference as Blob, referenceName);

  const seedIn = Number(form.get("seed"));
  const measured = await measureRun(
    async () => {
      const res = await withResourceLease(
        "music-generate",
        { owner: `lab:music:${task}`, lane: "interactive", ttlMs: maxDuration * 1000, signal: req.signal },
        () =>
          fetch(`${getServiceUrl("music")}/v1/music/generate`, {
            method: "POST",
            headers: getServiceHeaders("music"),
            body: out,
            signal: req.signal,
          }),
      );
      if (!res.ok) {
        const text = await res.text();
        let detail = text.slice(0, 400);
        try {
          detail = JSON.parse(text).detail ?? detail;
        } catch {
          /* not JSON */
        }
        throw new ServiceError(String(detail) || `Music service returned ${res.status}`, res.status);
      }
      const metaHeader = res.headers.get("x-music-meta");
      const meta = metaHeader ? (JSON.parse(Buffer.from(metaHeader, "base64").toString("utf8")) as MusicMeta) : null;
      if (!meta) throw new ServiceError("The music service answered without its metadata header.", 502);
      return { audio: Buffer.from(await res.arrayBuffer()), meta };
    },
    { local: true },
  );

  const m = measured.measurement;
  const err = measured.ok ? null : measured.error;
  const blocked = err instanceof ResourceLeaseError;
  const errorText = !err
    ? null
    : err instanceof ServiceError || blocked
      ? err.message
      : err instanceof Error && /fetch failed|ECONNREFUSED/i.test(err.message)
        ? "The music service isn't reachable. Start it above."
        : err instanceof Error
          ? err.message
          : String(err);

  let track: MusicTrack | null = null;
  if (measured.ok) {
    track = await saveTrack(measured.result.audio, format, {
      caption,
      lyrics: instrumental ? "" : lyrics,
      instrumental,
      vocalLanguage: instrumental ? null : String(form.get("vocal_language") ?? "") || null,
      requestedDuration: Number(form.get("duration")) || null,
      sourceId: source?.id ?? null,
      sourceName,
      track: (form.get("track") as string | null) || null,
      meta: measured.result.meta,
    });
  }

  const summary =
    task === "text2music"
      ? `${caption || "(no caption)"}${instrumental || !lyrics.trim() ? " · instrumental" : " · with lyrics"}`
      : `${task} of ${sourceName ?? "?"}${caption ? ` → ${caption}` : ""}`;
  const run = await recordLabRun({
    lab: "music",
    capability: "music",
    model,
    local: true,
    compareGroup,
    inputSummary: summary,
    params: {
      task,
      reference: referenceName,
      duration: Number(form.get("duration")) || null,
      audioSeconds: track?.meta.audio_seconds ?? null,
      dit: track?.meta.dit ?? null,
      rewriteCaption: String(form.get("rewrite_caption") ?? "") === "true",
      fadeOut: Number(form.get("fade_out")) || null,
      steps: track?.meta.steps ?? null,
      torchPeakAllocatedGb: track?.meta.peak_allocated_gb ?? null,
      timeCosts: track?.meta.time_costs ?? null,
      format,
    },
    seed: track?.meta.seed ?? (Number.isInteger(seedIn) && seedIn >= 0 ? seedIn : null),
    status: track ? "ok" : "error",
    error: errorText,
    latencyMs: m.latencyMs,
    peakVramGb: m.peakVramGb,
    baselineVramGb: m.baselineVramGb,
    vramNote: m.vramNote,
    costUsd: null,
    outputPath: track ? track.file : null,
    outputSummary: track
      ? `${track.meta.audio_seconds ?? "?"} s${track.meta.resolved?.bpm ? ` · ${track.meta.resolved.bpm} bpm` : ""}${track.meta.resolved?.keyscale ? ` · ${track.meta.resolved.keyscale}` : ""}`
      : null,
  });
  if (track && run?.id) {
    // Link the gallery entry back to its row in the runs record.
    track.runId = run.id;
    await updateTrack(track).catch(() => {});
  }

  const result: LabRunResult<MusicLabOutput> = {
    ok: !!track,
    model,
    local: true,
    error: errorText ?? undefined,
    resourceBlocked: blocked || undefined,
    output: track ? { track, url: `/api/music/tracks/file?id=${encodeURIComponent(track.id)}` } : undefined,
    runId: run?.id ?? null,
    latencyMs: m.latencyMs,
    peakVramGb: m.peakVramGb,
    baselineVramGb: m.baselineVramGb,
    vramNote: m.vramNote,
    costUsd: null,
  };
  return NextResponse.json(result);
}
