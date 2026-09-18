"use client";

import { useCallback, useEffect, useState } from "react";
import { releaseRequest, type GpuHolder } from "@/lib/gpu-holders";

const JSON_HEADERS = { "Content-Type": "application/json" };

/**
 * The remedy for a capacity denial, shown where the denial is.
 *
 * A blocked run used to end at a sentence: "VRAM needs 11.94 GB more … but only
 * 1.88 GB is currently free", plus a pointer to a dialog that could not act on
 * it. Everything you needed to press was on another page, and the usual culprit
 * — a text model on Ollama — was not an image model at all, so no amount of
 * looking around the Image Studio would have found it.
 *
 * So this lists what is measurably holding the box right now and frees it in
 * place. It is deliberately a LIST rather than a single "make room" button:
 * which one to give up is a judgement about what you are still using, and the
 * costs differ by an order of magnitude.
 */
export default function CapacityBlocker({
  message,
  onReleased,
  className = "",
}: {
  /** The denial text from the resource coordinator, shown verbatim. */
  message: string;
  /** Called after something is freed, so the caller can re-check and retry. */
  onReleased?: () => void;
  className?: string;
}) {
  const [holders, setHolders] = useState<GpuHolder[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/gpu/holders", { cache: "no-store" });
      const j = (await r.json()) as { holders?: GpuHolder[] };
      setHolders(j.holders ?? []);
    } catch {
      setHolders([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const release = async (h: GpuHolder) => {
    const req = releaseRequest(h);
    setBusy(h.id);
    setNote(null);
    try {
      const r = await fetch(req.url, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(req.body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setNote(j.error ?? `Could not free ${h.label}.`);
      } else {
        // Ollama can report a release the card has not made yet, and a stopped
        // service takes a moment to actually exit. Re-reading beats asserting.
        setNote(`Freed ${h.label}.`);
        onReleased?.();
      }
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      void load();
    }
  };

  const freeable = (holders ?? []).filter((h) => h.vramGb + h.ramGb > 0);

  return (
    <div
      className={`rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2.5 text-xs ${className}`}
      role="status"
    >
      <p className="text-amber-200 leading-snug">{message}</p>

      {holders === null ? (
        <p className="mt-2 text-[11px] text-gray-500">Checking what is holding the box…</p>
      ) : freeable.length === 0 ? (
        <p className="mt-2 text-[11px] text-gray-500">
          Nothing on this box is holding a releasable amount — the memory is in use elsewhere on the
          machine, so closing other applications is what will help.
        </p>
      ) : (
        <>
          <p className="mt-2 mb-1.5 text-[10px] uppercase tracking-wide text-gray-500">Holding it now</p>
          <ul className="space-y-1">
            {freeable.map((h) => {
              const req = releaseRequest(h);
              const cost = [
                h.vramGb ? `${h.vramGb} GB VRAM` : null,
                h.ramGb ? `${h.ramGb} GB RAM` : null,
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <li
                  key={`${h.kind}:${h.id}`}
                  className="flex items-center gap-2 rounded-md border border-gray-800 bg-gray-900/60 px-2.5 py-1.5"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] text-gray-200">{h.label}</span>
                    <span className="block truncate text-[10px] text-gray-500">
                      {cost}
                      {cost && h.detail ? " · " : ""}
                      {h.detail}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => void release(h)}
                    disabled={busy !== null}
                    title={req.title}
                    className="flex-shrink-0 rounded-md border border-amber-700/40 px-2 py-1 text-[11px] text-amber-300 transition hover:border-amber-600 hover:text-amber-200 disabled:opacity-40"
                  >
                    {busy === h.id ? "Freeing…" : req.verb}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {note && <p className="mt-2 text-[11px] text-gray-400">{note}</p>}
    </div>
  );
}
