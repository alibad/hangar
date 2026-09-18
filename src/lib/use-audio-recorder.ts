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
  start: (
    onDone: (file: File) => void,
    onError?: (message: string) => void,
    /** Stop on its own after this long. Past the engine's cap the extra audio is
     *  discarded anyway, so let go of the button rather than silently truncate. */
    maxMs?: number,
  ) => Promise<void>;
  /** Finish the take and hand the file to `onDone`. */
  stop: () => void;
  /**
   * Stop WITHOUT delivering. `stop()` still fires `onstop` asynchronously, so a
   * caller that stopped and then cleared its own state got the clip handed back
   * a tick later and undid the clear.
   */
  cancel: () => void;
};

export function useAudioRecorder(): AudioRecorder {
  const [recording, setRecording] = useState(false);
  const [ms, setMs] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** Read by `onstop`, which fires a tick after whichever of stop/cancel ran. */
  const abandonedRef = useRef(false);

  const clearTimer = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  };

  const start = useCallback(
    async (onDone: (file: File) => void, onError?: (message: string) => void, maxMs?: number) => {
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
        if (abandonedRef.current) return;
        const blob = new Blob(chunks, { type: "audio/webm" });
        onDone(new File([blob], "recording.webm", { type: "audio/webm" }));
      };
      recorder.start();
      recorderRef.current = recorder;
      abandonedRef.current = false;
      setRecording(true);
      setMs(0);
      timerRef.current = setInterval(() => {
        setMs((v) => {
          const next = v + 100;
          if (maxMs && next >= maxMs) {
            clearTimer();
            setRecording(false);
            if (recorder.state !== "inactive") recorder.stop();
          }
          return next;
        });
      }, 100);
    },
    [],
  );

  const stop = useCallback(() => {
    recorderRef.current?.stop();
    clearTimer();
    setRecording(false);
  }, []);

  const cancel = useCallback(() => {
    abandonedRef.current = true;
    recorderRef.current?.stop();
    clearTimer();
    setRecording(false);
    setMs(0);
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

  return { recording, ms, start, stop, cancel };
}
