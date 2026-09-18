"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Mic, Square, X } from "lucide-react";
import { ServiceControl, serviceName } from "./service-control";
import { useAudioRecorder } from "@/lib/use-audio-recorder";

/**
 * Dictation for any text field in the console.
 *
 * This began as the Image Studio's mic and stayed there for months, which meant
 * the one surface with a long prompt box had voice input and every other one —
 * the chat prompt, the arena prompt, the text you want spoken aloud — did not,
 * despite a local Whisper sitting idle on the same machine. Rather than copy
 * three hundred lines into each, the behaviour lives here once.
 *
 * It is a hook rather than a component because the two pieces it renders belong
 * in different places: the mic is absolutely positioned INSIDE the field's
 * wrapper, and the banner belongs below it in normal flow. Returning nodes lets
 * the caller put each where it goes without this file guessing at anyone's
 * layout:
 *
 *     const voice = useVoiceInput({ onTranscript: (t) => setPrompt(append(t)) });
 *     <div className="relative"><textarea … />{voice.mic}</div>
 *     {voice.banner}
 *
 * Two behaviours are worth keeping when you touch this. The recording is kept
 * after a failure so the retry button can re-send it — being asked to say it all
 * again because a service was not running is the actual insult. And when the
 * failure IS a stopped service, the banner offers Start rather than naming it:
 * that is the rule service-control.tsx already applies everywhere else.
 */

export type VoiceFailure = { message: string; serviceId?: string; model?: string };

/**
 * A failure the user can act on, with the action attached.
 *
 * `serviceId` is the whole point: with it, "start its service" becomes a button
 * on the surface where the problem appeared. Without it — a cloud model, or a
 * denied microphone — there is nothing on this box to start, and the banner is
 * correctly just the sentence.
 */
export function VoiceErrorBanner({
  error,
  onRetry,
  canRetry,
  retrying,
  onDismiss,
  className = "",
}: {
  error: VoiceFailure;
  onRetry: () => void;
  canRetry: boolean;
  retrying: boolean;
  onDismiss: () => void;
  className?: string;
}) {
  const id = error.serviceId;
  const [up, setUp] = useState<boolean | undefined>(undefined);

  const probe = useCallback(async () => {
    if (!id) return false;
    try {
      const rows = await fetch("/api/services", { cache: "no-store" }).then((r) => r.json());
      const row = Array.isArray(rows) ? rows.find((r: { id: string }) => r.id === id) : null;
      const alive = row?.status === "running";
      setUp(alive);
      return alive;
    } catch {
      setUp(false);
      return false;
    }
  }, [id]);

  useEffect(() => {
    if (id) void probe();
  }, [id, probe]);

  return (
    <div
      className={`rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-200 ${className}`}
    >
      <div className="flex items-start gap-2">
        <Mic className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
        <p className="flex-1 leading-relaxed">{error.message}</p>
        <button onClick={onDismiss} aria-label="Dismiss" className="text-amber-300/60 hover:text-amber-100">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {(id || canRetry) && (
        <div className="mt-2 flex flex-wrap items-center gap-2 pl-5.5">
          {id && <ServiceControl id={id} up={up} probe={probe} name={serviceName(id)} />}
          {canRetry && (
            <button
              onClick={onRetry}
              disabled={retrying}
              title="Send the recording you already made — no need to say it again"
              className="rounded-md border border-amber-500/40 px-2 py-1 text-[11px] font-medium text-amber-100 transition hover:border-amber-400 disabled:opacity-50"
            >
              {retrying ? "Transcribing…" : "Retry with that recording"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export type VoiceInput = {
  /** Put this inside a `position: relative` wrapper around the field. */
  mic: ReactNode;
  /** Put this below the field. Renders nothing until something fails. */
  banner: ReactNode;
  recording: boolean;
  transcribing: boolean;
};

export function useVoiceInput({
  onTranscript,
  disabled = false,
  /** Where the mic sits in its wrapper. Override for a single-line input. */
  position = "top-2.5 right-2.5",
  label = "prompt",
}: {
  /** Receives the transcript. The caller decides append vs replace. */
  onTranscript: (text: string) => void;
  disabled?: boolean;
  position?: string;
  /** What this field is, for the button's tooltip and aria-label. */
  label?: string;
}): VoiceInput {
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState<VoiceFailure | null>(null);
  const lastRecording = useRef<File | null>(null);
  const recorder = useAudioRecorder();

  const transcribe = useCallback(
    async (file: File) => {
      lastRecording.current = file;
      setTranscribing(true);
      setError(null);
      try {
        const form = new FormData();
        form.append("file", file);
        // No `model`: /api/stt resolves whatever the stt capability is pointed
        // at. Naming one here pinned voice input to Whisper while the picker
        // said otherwise.
        const res = await fetch("/api/stt", { method: "POST", body: form });
        const data = await res.json().catch(() => ({}));
        const text = (data.text ?? "").trim();
        if (text) {
          onTranscript(text);
          lastRecording.current = null;
        } else {
          setError({
            message: data.error || "No speech detected.",
            serviceId: typeof data.serviceId === "string" ? data.serviceId : undefined,
            model: typeof data.model === "string" ? data.model : undefined,
          });
        }
      } catch {
        setError({ message: "Transcription failed — the console could not reach speech-to-text." });
      }
      setTranscribing(false);
    },
    [onTranscript],
  );

  const start = useCallback(() => {
    setError(null);
    recorder.start(
      (file) => void transcribe(file),
      // No serviceId: nothing on this box can fix a browser permission, so the
      // banner correctly renders the sentence with no inert Start button.
      () =>
        setError({
          message: "Microphone access was denied. Allow it for this site in your browser, then try again.",
        }),
    );
  }, [recorder, transcribe]);

  const retry = useCallback(() => {
    const file = lastRecording.current;
    if (file && !transcribing) void transcribe(file);
  }, [transcribing, transcribe]);

  const mic = (
    <button
      type="button"
      onClick={recorder.recording ? recorder.stop : start}
      disabled={disabled || transcribing}
      title={recorder.recording ? "Stop & transcribe" : `Dictate the ${label} (local speech-to-text)`}
      aria-label={recorder.recording ? "Stop recording and transcribe" : `Dictate ${label} with microphone`}
      className={`absolute ${position} flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs transition ${
        recorder.recording
          ? "animate-pulse bg-red-600 text-white shadow-[0_0_12px_rgba(239,68,68,0.4)]"
          : "bg-gray-700/70 text-gray-300 hover:bg-gray-600"
      } disabled:opacity-50`}
    >
      {transcribing ? (
        <span>transcribing…</span>
      ) : recorder.recording ? (
        <>
          <Square className="h-3.5 w-3.5" />
          <span className="tabular-nums">{(recorder.ms / 1000).toFixed(1)}s</span>
        </>
      ) : (
        <Mic className="h-3.5 w-3.5" />
      )}
    </button>
  );

  const banner = error ? (
    <VoiceErrorBanner
      error={error}
      onRetry={retry}
      canRetry={!!lastRecording.current}
      retrying={transcribing}
      onDismiss={() => setError(null)}
    />
  ) : null;

  return { mic, banner, recording: recorder.recording, transcribing };
}

/**
 * Append a transcript to whatever is already in the field.
 *
 * Dictating twice should add a second sentence, not replace the first, and
 * dictating into a half-typed prompt should finish it.
 */
export function appendTranscript(existing: string, text: string): string {
  const base = existing.trim();
  return base ? `${base} ${text}` : text;
}
