"use client";
import { useCallback, useEffect, useRef, useState } from "react";

/** One request at a time, visible-only polling, and cancellation on navigation. */
export function useUsageSnapshot<T>(url: string, interval = 30_000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const loader = useRef<() => void>(() => {});
  useEffect(() => {
    let controller: AbortController | null = null;
    let disposed = false;
    async function load() {
      if (disposed || document.hidden || controller) return;
      const requestController = new AbortController();
      controller = requestController;
      setLoading(true);
      try {
        const response = await fetch(url, {
          signal: requestController.signal,
          cache: "no-store",
        });
        const json = await response.json();
        if (!response.ok || json.error)
          throw new Error(json.error || `HTTP ${response.status}`);
        if (!disposed) {
          setData(json);
          setError(null);
        }
      } catch (e) {
        if (!disposed && !requestController.signal.aborted)
          setError(e instanceof Error ? e.message : String(e));
      } finally {
        controller = null;
        if (!disposed) setLoading(false);
      }
    }
    const onVisible = () => void load();
    loader.current = onVisible;
    void load();
    const timer = setInterval(onVisible, interval);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      disposed = true;
      controller?.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [url, interval]);
  const refresh = useCallback(() => loader.current(), []);
  return { data, error, loading, refresh };
}
