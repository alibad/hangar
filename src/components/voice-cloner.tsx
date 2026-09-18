"use client";

import { useEffect, useRef, useState } from "react";
import { useAudioRecorder } from "@/lib/use-audio-recorder";
import type { VoiceOption } from "@/app/api/tts/voices/route";

/**
 * Teach the routed speech engine a new voice from a reference clip.
 *
 * Lives inside the Text → speech panel rather than in a tab of its own, because
 * a cloned voice is not a separate feature — it is an entry in the voice picker
 * six inches above this. The engine owns the clips (see AI/chatterbox/server.py)
 * and enumerates them through the same GET /api/tts/voices the picker already
 * polls, so enrolling one here makes it selectable there with nothing in the
 * console holding a second copy of the list.
 *
 * Renders as a single explanatory line when the routed engine cannot clone.
 * Kokoro's voices are baked into its weights; there is no clip to give it.
 */

/**
 * What to read into the microphone.
 *
 * Not decoration. A clone is only as good as its reference, and left to
 * improvise most people record four seconds of "testing, testing, is this
 * working" — monotone, too short, and missing half the sounds the model needs
 * to generalise from. This passage is written for coverage rather than meaning:
 * stops and fricatives (p/b/t/d/k/g, f/v/s/z/th/sh/ch), nasals, both liquids, a
 * wide vowel spread, and a question in the middle so the model hears your pitch
 * rise as well as your default register. Roughly 15 seconds at a normal pace.
 */
const SCRIPT =
  "Yesterday the weather changed three times before lunch. " +
  "I walked through the park and watched a few children chase pigeons. " +
  "Would you have guessed it was only March? " +
  "By evening the whole sky had turned a deep shade of orange.";

const FALLBACK_LIMITS = { minSeconds: 3, maxSeconds: 30 };

/**
 * A clip's real length in seconds, decoded rather than read off an <audio>.
 *
 * MediaRecorder's webm carries no duration in its header, so an audio element
 * reports `Infinity` or a nonsense value for it until you seek to the end —
 * which is how a fourteen-second take came out reading "0:01". Decoding is
 * exact, and works the same for an uploaded mp3.
 */
async function clipSeconds(file: File): Promise<number | null> {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    try {
      const buf = await ctx.decodeAudioData(await file.arrayBuffer());
      return buf.duration;
    } finally {
      void ctx.close();
    }
  } catch {
    // Unsupported codec, or no Web Audio. The engine still checks the length —
    // this only costs the caller the hint, not the guard.
    return null;
  }
}

export function VoiceCloner({
  voices,
  canClone,
  alias,
  limits,
  onChanged,
  className = "",
}: {
  voices: VoiceOption[];
  canClone: boolean;
  alias: string;
  limits?: { minSeconds: number; maxSeconds: number };
  /** Re-ask the engine for its voice list — a new clone has to reach the picker. */
  onChanged: () => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [clip, setClip] = useState<File | null>(null);
  const [clipUrl, setClipUrl] = useState<string | null>(null);
  const [clipLength, setClipLength] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const recorder = useAudioRecorder();

  const { minSeconds, maxSeconds } = limits ?? FALLBACK_LIMITS;
  const clones = voices.filter((v) => v.clone);
  const tooShort = clipLength !== null && clipLength < minSeconds;

  // One object URL per clip, revoked when it is replaced. This used to be
  // `src={URL.createObjectURL(clip)}` inline in the JSX, which minted a fresh
  // URL on every render — and the recording timer re-renders ten times a
  // second, so the player was handed a new source each tick and snapped back to
  // 0:00 while leaking a blob URL per frame.
  useEffect(() => {
    if (!clip) {
      setClipUrl(null);
      return;
    }
    const url = URL.createObjectURL(clip);
    setClipUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [clip]);

  useEffect(() => {
    if (!clip) {
      setClipLength(null);
      return;
    }
    let live = true;
    clipSeconds(clip).then((s) => {
      if (live) setClipLength(s);
    });
    return () => {
      live = false;
    };
  }, [clip]);

  function takeClip(file: File) {
    setError(null);
    setClip(file);
  }

  function record() {
    // Drop the previous take FIRST. Leaving it set meant the old clip's player
    // sat under a running timer, offering to save audio you were part-way
    // through replacing.
    setClip(null);
    setError(null);
    recorder.start(takeClip, (message) => setError(message), maxSeconds * 1000);
  }

  function discard() {
    // Cancel is also reachable mid-take. `cancel` rather than `stop`, because
    // stop still delivers the clip a tick later — into a panel that has closed.
    if (recorder.recording) recorder.cancel();
    setClip(null);
    setError(null);
  }

  async function enroll() {
    if (!clip || !name.trim() || busy || tooShort) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("name", name.trim());
      form.append("file", clip);
      const res = await fetch("/api/tts/voices", { method: "POST", body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setName("");
      setClip(null);
      setOpen(false);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setBusy(false);
  }

  async function remove(id: string) {
    setError(null);
    try {
      const res = await fetch(`/api/tts/voices?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (!canClone) {
    return (
      <p className={`text-[11px] text-gray-500 ${className}`}>
        <span className="text-gray-400">{alias}</span> speaks from a fixed set of voices and cannot
        learn a new one. Switch the model above to a cloning engine to record your own.
      </p>
    );
  }

  const elapsed = recorder.ms / 1000;
  // The button doubles as the length coach: under the minimum it is asking for
  // more, in the sweet spot it says so, and past it there is no reason to wait.
  const recordLabel = !recorder.recording
    ? "🎙 Record"
    : elapsed < minSeconds
      ? `⏹ ${elapsed.toFixed(1)}s — keep going`
      : elapsed < 10
        ? `⏹ ${elapsed.toFixed(1)}s — a bit more`
        : `⏹ ${elapsed.toFixed(1)}s — stop when ready`;

  return (
    <div className={`rounded-xl border border-gray-800 bg-gray-900/60 p-3 ${className}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-gray-200">Your voices</p>
          <p className="truncate text-[11px] text-gray-500">
            {clones.length
              ? `${clones.length} cloned voice${clones.length === 1 ? "" : "s"} on this box`
              : `Read a short passage aloud and ${alias} can speak as you`}
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setOpen((v) => !v);
            discard();
          }}
          className="flex-shrink-0 rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-300 transition hover:border-gray-500 hover:text-gray-100"
        >
          {open ? "Cancel" : "Clone a voice"}
        </button>
      </div>

      {clones.length > 0 && (
        <ul className="mt-2 space-y-1">
          {clones.map((v) => (
            <li
              key={v.id}
              className="flex items-center justify-between gap-2 rounded-lg bg-gray-800/60 px-2.5 py-1.5"
            >
              <span className="truncate text-[11px] text-gray-300">
                {v.label ?? v.id}
                {v.seconds ? <span className="text-gray-600"> · {v.seconds}s reference</span> : null}
              </span>
              <button
                type="button"
                onClick={() => remove(v.id)}
                className="flex-shrink-0 text-[11px] text-gray-500 transition hover:text-red-400"
                title={`Delete "${v.id}" and its reference clip`}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}

      {open && (
        <div className="mt-3 space-y-2.5 border-t border-gray-800 pt-3">
          <div className="rounded-lg border border-gray-800 bg-gray-950/60 p-3">
            <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-gray-500">
              Read this aloud
            </p>
            <p className="text-[13px] leading-relaxed text-gray-200">{SCRIPT}</p>
            <p className="mt-2 text-[11px] text-gray-600">
              About 15 seconds. Normal speaking voice in a quiet room — don&apos;t perform it, and
              don&apos;t over-enunciate. The clone copies how you actually sound, including the
              acoustics of the room.
            </p>
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={recorder.recording ? recorder.stop : record}
              className={`flex-shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium tabular-nums transition ${
                recorder.recording
                  ? "bg-red-600 shadow-[0_0_16px_rgba(239,68,68,0.35)] hover:bg-red-500"
                  : "border border-gray-700 text-gray-300 hover:border-gray-500"
              }`}
            >
              {recordLabel}
            </button>
            <button
              type="button"
              disabled={recorder.recording}
              onClick={() => fileInput.current?.click()}
              className="flex-shrink-0 rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-300 transition hover:border-gray-500 disabled:opacity-40"
            >
              Upload
            </button>
            <input
              ref={fileInput}
              type="file"
              accept="audio/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) takeClip(f);
                // Let the same file be chosen twice in a row.
                e.target.value = "";
              }}
            />
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name this voice"
              className="min-w-0 flex-1 rounded-lg border border-gray-700 bg-gray-800 px-2.5 py-1.5 text-xs text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500/50"
            />
          </div>

          {clip && !recorder.recording && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                {/* Hear what is about to be sent. A clip with the mic muted looks
                    identical to a good one until the clone comes back wrong. */}
                {clipUrl && <audio controls src={clipUrl} className="h-8 min-w-0 flex-1" />}
                <button
                  type="button"
                  onClick={discard}
                  className="flex-shrink-0 text-[11px] text-gray-500 transition hover:text-gray-300"
                >
                  Discard
                </button>
                <button
                  type="button"
                  disabled={busy || !name.trim() || tooShort}
                  onClick={enroll}
                  className="flex-shrink-0 rounded-lg bg-purple-600 px-3 py-1.5 text-xs font-medium transition hover:bg-purple-500 disabled:opacity-40"
                >
                  {busy ? "Learning…" : "Save voice"}
                </button>
              </div>
              <p className={`text-[11px] ${tooShort ? "text-amber-400" : "text-gray-600"}`}>
                {clipLength === null
                  ? "Ready to save."
                  : tooShort
                    ? `Only ${clipLength.toFixed(1)}s — ${alias} needs at least ${minSeconds}s. Record again.`
                    : `${clipLength.toFixed(1)}s captured${!name.trim() ? " — name it to save" : ""}.`}
              </p>
            </div>
          )}

          <p className="text-[11px] text-gray-600">
            Clips stay on this box. Generated speech carries an inaudible watermark.
          </p>
        </div>
      )}

      {error && <p className="mt-2 text-[11px] text-red-400">{error}</p>}
    </div>
  );
}
