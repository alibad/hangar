"use client";

import { useRef, useState } from "react";
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
export function VoiceCloner({
  voices,
  canClone,
  alias,
  onChanged,
  className = "",
}: {
  voices: VoiceOption[];
  canClone: boolean;
  alias: string;
  /** Re-ask the engine for its voice list — a new clone has to reach the picker. */
  onChanged: () => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [clip, setClip] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const recorder = useAudioRecorder();

  const clones = voices.filter((v) => v.clone);

  async function enroll() {
    if (!clip || !name.trim() || busy) return;
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

  return (
    <div className={`rounded-xl border border-gray-800 bg-gray-900/60 p-3 ${className}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-gray-200">Your voices</p>
          <p className="truncate text-[11px] text-gray-500">
            {clones.length
              ? `${clones.length} cloned voice${clones.length === 1 ? "" : "s"} on this box`
              : "Record 10–20 seconds and this engine can speak as you"}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
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
        <div className="mt-3 space-y-2 border-t border-gray-800 pt-3">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() =>
                recorder.recording
                  ? recorder.stop()
                  : recorder.start(
                      (file) => setClip(file),
                      (message) => setError(message),
                    )
              }
              className={`flex-shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                recorder.recording
                  ? "bg-red-600 shadow-[0_0_16px_rgba(239,68,68,0.35)] hover:bg-red-500"
                  : "border border-gray-700 text-gray-300 hover:border-gray-500"
              }`}
            >
              {recorder.recording ? `⏹ ${(recorder.ms / 1000).toFixed(1)}s — stop` : "🎙 Record"}
            </button>
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              className="flex-shrink-0 rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-300 transition hover:border-gray-500"
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
                if (f) setClip(f);
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

          {clip && (
            <div className="flex items-center gap-2">
              {/* Hear what is about to be sent. A clip with the mic muted looks
                  identical to a good one until the clone comes back wrong. */}
              <audio controls src={URL.createObjectURL(clip)} className="h-8 flex-1" />
              <button
                type="button"
                disabled={busy || !name.trim()}
                onClick={enroll}
                className="flex-shrink-0 rounded-lg bg-purple-600 px-3 py-1.5 text-xs font-medium transition hover:bg-purple-500 disabled:opacity-40"
              >
                {busy ? "Learning…" : "Save voice"}
              </button>
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
