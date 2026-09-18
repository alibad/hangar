"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Microphone capture, shared by everything on the Speech tab that needs it.
 *
 * Extracted when voice cloning arrived and wanted the same widget as
 * transcription: record, watch a timer count up, get a File back. The recorder
 * used to live inline in page.tsx with `transcribeAudio(...)` wired directly
 * into `onstop`, so a second caller could only have copied it — and a copy of
 * MediaRecorder is a copy of the track-cleanup that stops the browser's
 * recording indicator, which is the part that is easy to get wrong twice.
 *
 * `start` takes the callback rather than the hook taking it at construction, so
 * one panel can record for different destinations without re-arming anything.
 */
export type AudioRecorder = {
  recording: boolean;
  /** Elapsed milliseconds, ticking while `recording`. */
  ms: number;
  start: (onDone: (file: File) => void, onError?: (message: string) => void) => Promise<void>;
  stop: () => void;
};

export function useAudioRecorder(): AudioRecorder {
  const [recording, setRecording] = useState(false);
  const [ms, setMs] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTimer = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  };

  const start = useCallback(
    async (onDone: (file: File) => void, onError?: (message: string) => void) => {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        onError?.(`Mic error: ${err}`);
        return;
      }
      const recorder = new MediaRecorder(stream);
      const chunks: BlobPart[] = [];
      recorder.ondataavailable = (e) => chunks.push(e.data);
      recorder.onstop = () => {
        // Stopping the tracks is what turns off the browser's recording dot.
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: "audio/webm" });
        onDone(new File([blob], "recording.webm", { type: "audio/webm" }));
      };
      recorder.start();
      recorderRef.current = recorder;
      setRecording(true);
      setMs(0);
      timerRef.current = setInterval(() => setMs((v) => v + 100), 100);
    },
    [],
  );

  const stop = useCallback(() => {
    recorderRef.current?.stop();
    clearTimer();
    setRecording(false);
  }, []);

  // Unmounting mid-recording would otherwise leave the mic live and the timer
  // running against a component that no longer exists.
  useEffect(
    () => () => {
      clearTimer();
      const rec = recorderRef.current;
      if (rec && rec.state !== "inactive") rec.stop();
    },
    [],
  );

  return { recording, ms, start, stop };
}
