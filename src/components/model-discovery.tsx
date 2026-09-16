"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

const JSON_HEADERS = { "Content-Type": "application/json" };

type Fit = {
  verdict: string;
  headline?: string;
  vramNeededGb?: number;
  diskNeededGb?: number;
};

type Candidate = {
  id: string;
  name: string;
  kind: "local" | "cloud";
  capability: string;
  why: string;
  checkpoint?: string;
  target?: string;
  params?: string;
  license?: string;
  docs?: string;
  released?: string;
  fit?: Fit;
  alreadyWired?: string;
};

type Download = { repo: string; status?: string; percent?: number };

type ScoutPayload = {
  candidates?: Candidate[];
  installed?: { repo: string; bytes?: number }[];
  downloads?: Download[];
};

/**
 * "What else could serve this capability?" — answered from the model scout.
 *
 * The scout has been computing this all along: four audio candidates, each with
 * a sourced memory requirement, a licence, and a one-line comparative argument
 * for why it is on the list. `/api/scout` ships them to the browser on every
 * poll and NOTHING rendered them, so the console knew that Qwen3-ASR is the
 * drop-in replacement for local-whisper and that kokoro "is 82M and sounds like
 * it" while showing the reader a dead end. This is that data, put where the
 * question is actually asked.
 *
 * Collapsed by default: it is a "what are my options" surface, not something to
 * push past every time you want to transcribe a file.
 */
export default function ModelDiscovery({
  capability,
  label,
  className = "",
}: {
  capability: string;
  /** Capability name as the surrounding page says it, e.g. "speech → text". */
  label: string;
  className?: string;
}) {
  const [data, setData] = useState<ScoutPayload | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * Which rationales are expanded. The scout writes a full comparative
   * paragraph per candidate — genuinely the most useful thing here, and six
   * lines apiece, which turns a "what are my options" glance into a wall. Two
   * lines is enough to tell them apart; the rest is one click away.
   */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const load = useCallback(async () => {
    try {
      setData(await fetch("/api/scout", { cache: "no-store" }).then((r) => r.json()));
    } catch {
      /* transient — the poll retries */
    }
  }, []);

  useEffect(() => {
    load();
    // Only poll while open, and only fast enough to move a download bar. This
    // endpoint builds the whole machine report; polling it from a collapsed
    // panel on every speech tab would be pure waste.
    if (!open) return;
    const iv = setInterval(load, 5000);
    return () => clearInterval(iv);
  }, [load, open]);

  const installed = useMemo(
    () => new Set((data?.installed ?? []).map((i) => i.repo)),
    [data],
  );
  const downloads = useMemo(
    () => new Map((data?.downloads ?? []).map((d) => [d.repo, d])),
    [data],
  );
  const mine = useMemo(
    () => (data?.candidates ?? []).filter((c) => c.capability === capability),
    [data, capability],
  );

  const download = async (repo: string) => {
    setBusy(repo);
    setError(null);
    try {
      const r = await fetch("/api/scout", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ action: "download", repo }),
      });
      const j = await r.json();
      if (!r.ok) setError(j.error ?? "Could not start the download");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
      load();
    }
  };

  if (!mine.length) return null;

  return (
    <div className={`rounded-xl border border-gray-800 bg-gray-900 ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
          Other {label} models
        </span>
        <span className="rounded-full border border-gray-700 px-1.5 py-px text-[10px] text-gray-400">
          {mine.length}
        </span>
        <span className="ml-auto text-[11px] text-gray-500">{open ? "Hide" : "Show"}</span>
      </button>

      {open && (
        <div className="border-t border-gray-800 px-3 py-2.5">
          {error && <p className="mb-2 text-xs text-red-400">{error}</p>}
          <ul className="space-y-2">
            {mine.map((c) => {
              const repo = c.checkpoint;
              const have = repo ? installed.has(repo) : false;
              const dl = repo ? downloads.get(repo) : undefined;
              const running = dl?.status === "running";
              const fits = c.fit?.verdict === "fits";
              return (
                <li key={c.id} className="rounded-lg border border-gray-800 px-2.5 py-2">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className="text-xs font-medium text-gray-100">{c.name}</span>
                    {c.params && <span className="text-[10px] text-gray-500">{c.params}</span>}
                    {c.license && (
                      <span className="rounded border border-gray-700 px-1 py-px text-[10px] text-gray-400">
                        {c.license}
                      </span>
                    )}
                    {/* The scout's own verdict against THIS machine, with what is
                        loaded right now — not a generic spec sheet. */}
                    {c.fit?.headline && (
                      <span
                        className={`text-[10px] ${fits ? "text-emerald-400" : "text-amber-400"}`}
                        title={c.fit.headline}
                      >
                        {fits ? "fits" : c.fit.verdict}
                        {typeof c.fit.vramNeededGb === "number"
                          ? ` · ${c.fit.vramNeededGb} GB VRAM`
                          : ""}
                        {typeof c.fit.diskNeededGb === "number"
                          ? ` · ${c.fit.diskNeededGb} GB disk`
                          : ""}
                      </span>
                    )}
                    <span className="ml-auto flex items-center gap-1.5">
                      {c.docs && (
                        <a
                          href={c.docs}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[10px] text-gray-500 underline underline-offset-2 hover:text-gray-300"
                        >
                          docs
                        </a>
                      )}
                      {have ? (
                        <span className="text-[10px] text-emerald-400">downloaded</span>
                      ) : running ? (
                        <span className="text-[10px] text-gray-400 tabular-nums">
                          {Math.round(dl?.percent ?? 0)}%
                        </span>
                      ) : repo ? (
                        <button
                          type="button"
                          disabled={busy === repo}
                          onClick={() => download(repo)}
                          className="rounded-md border border-gray-700 px-2 py-0.5 text-[10px] font-medium text-gray-300 transition-colors hover:border-gray-500 hover:text-gray-100 disabled:opacity-40"
                        >
                          {busy === repo ? "…" : "Download"}
                        </button>
                      ) : null}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => toggle(c.id)}
                    className="mt-1 block w-full text-left"
                    aria-expanded={expanded.has(c.id)}
                  >
                    <span
                      className={`block text-[11px] leading-snug text-gray-500 ${
                        expanded.has(c.id) ? "" : "line-clamp-2"
                      }`}
                    >
                      {c.why}
                    </span>
                    <span className="mt-0.5 inline-block text-[10px] text-gray-600 hover:text-gray-400">
                      {expanded.has(c.id) ? "Less" : "Why this one"}
                    </span>
                  </button>
                  {have && !c.alreadyWired && (
                    // Downloaded is not the same as usable: the weights are on
                    // disk but no alias points at them yet.
                    <p className="mt-1 text-[10px] text-amber-400">
                      On disk, but not wired into the router yet — add it in Models.
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
