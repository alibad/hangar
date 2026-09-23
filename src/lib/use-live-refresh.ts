"use client";

import { useEffect, useRef } from "react";

type Options = {
  intervalMs: number | null;
  runOnMount?: boolean;
};

/**
 * How much to slow down — not stop — in a background tab.
 *
 * This loop used to halt outright while `document.hidden`, which is right about
 * cost and wrong about everything else. A console left open on a second monitor
 * or behind an editor showed whatever was true when you last looked at it, with
 * nothing saying the numbers were stale, and a headless browser driving the app
 * fetched nothing at all — two separate rounds of "the data is not loading"
 * turned out to be this.
 *
 * Six times the interval is cheap enough to ignore (a 5s surface becomes 30s)
 * and current enough that switching back shows something recent while the
 * immediate on-visible refresh lands.
 */
const HIDDEN_SLOWDOWN = 6;

/**
 * One visibility-aware, non-overlapping refresh loop for console surfaces.
 *
 * setInterval allowed slow requests to overlap and every surface implemented
 * its own lifecycle rules. This scheduler slows down in background tabs, waits
 * for the previous refresh to finish, and refreshes immediately when the
 * console becomes visible again.
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
      if (cancelled || intervalMs == null) return;
      timer = window.setTimeout(run, document.hidden ? intervalMs * HIDDEN_SLOWDOWN : intervalMs);
    };

    const run = async () => {
      if (cancelled || running) return;
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
