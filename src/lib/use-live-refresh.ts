"use client";

import { useEffect, useRef } from "react";

type Options = {
  intervalMs: number | null;
  runOnMount?: boolean;
};

/**
 * One visibility-aware, non-overlapping refresh loop for console surfaces.
 *
 * setInterval allowed slow requests to overlap and every surface implemented
 * its own lifecycle rules. This scheduler pauses in background tabs, waits for
 * the previous refresh to finish, and refreshes immediately when the console
 * becomes visible again.
 */
export function useLiveRefresh(
  refresh: () => void | Promise<unknown>,
  { intervalMs, runOnMount = true }: Options,
) {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    let running = false;

    const schedule = () => {
      if (cancelled || intervalMs == null || document.hidden) return;
      timer = window.setTimeout(run, intervalMs);
    };

    const run = async () => {
      if (cancelled || running || document.hidden) return;
      running = true;
      try {
        await refreshRef.current();
      } finally {
        running = false;
        schedule();
      }
    };

    const handleVisibility = () => {
      if (timer) window.clearTimeout(timer);
      timer = null;
      if (!document.hidden) void run();
    };

    document.addEventListener("visibilitychange", handleVisibility);
    if (runOnMount) void run();
    else schedule();

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [intervalMs, runOnMount]);
}
