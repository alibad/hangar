"use client";

import { useCallback, useEffect, useState } from "react";
import type { LabComponentProps } from "@/lib/labs";
import type { ForgeItem, ForgeRuntime, ForgeSettings } from "@/lib/forge/forge";
import { ExperimentDoc } from "./lab-shell";

/**
 * The Video Forge page. Plain language first: what it is doing right now, what
 * is waiting for you, what it will make tonight. How each brief was made — what
 * it heard, what was filtered, every tool call — is behind a fold.
 */

type ForgeState = {
  settings: ForgeSettings;
  runtime: ForgeRuntime;
  window: { open: boolean; minutesLeft: number | null; nextStart: string };
  services: { search: boolean; smallModel: boolean };
  items: ForgeItem[];
};

const fileUrl = (rel: string) => `/api/video/file?path=${encodeURIComponent(rel)}`;
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const when = (iso: string) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

function inWords(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

async function post(body: Record<string, unknown>) {
  const res = await fetch("/api/forge", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

export default function VideoForge({ lab }: LabComponentProps) {
  const [state, setState] = useState<ForgeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/forge", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setState(await res.json());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const act = async (label: string, body: Record<string, unknown>) => {
    setBusy(label);
    try {
      await post(body);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  if (!state) return <div className="p-6 text-sm text-gray-400">{error ? `Could not load the forge: ${error}` : "Loading the forge…"}</div>;

  const { settings, runtime, window: win, services, items } = state;
  const review = items.filter((i) => i.status === "review");
  const tonight = items.filter((i) => i.status === "brief" || i.status === "still" || i.status === "rendering");
  const history = items.filter((i) => !["review", "brief", "still", "rendering"].includes(i.status));

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5 p-4 sm:p-6">
      {/* ── right now ── */}
      <section className="rounded-xl border border-orange-500/30 bg-gradient-to-br from-orange-500/10 to-transparent p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold text-gray-100">{lab.label}</h1>
            <p className="mt-1 text-sm text-gray-400">
              Listens to what is trending, has a local model research one topic and write a brief, and turns it into a short clip overnight. Nothing is published — every clip waits for you.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => act("listen", { action: "listen" })}
              disabled={!!busy || !!runtime.listening || !services.smallModel || !settings.enabled}
              className="rounded-lg bg-orange-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-orange-500 disabled:opacity-40"
              title={services.smallModel ? "Hear the trends now and write one brief (~15 s)" : "vllm-small, the model that writes briefs, is not running"}
            >
              {busy === "listen" || runtime.listening ? "Listening…" : "Listen now"}
            </button>
            <button
              onClick={() => act("toggle", { action: "settings", patch: { enabled: !settings.enabled } })}
              disabled={!!busy}
              className="rounded-lg border border-gray-700 px-3 py-1.5 text-sm text-gray-200 hover:bg-gray-800 disabled:opacity-40"
            >
              {settings.enabled ? "Pause forge" : "Resume forge"}
            </button>
          </div>
        </div>
        <p className="mt-4 text-base text-gray-100">
          <span className="mr-2 text-xs font-semibold uppercase tracking-wide text-orange-300">Right now</span>
          {runtime.now ?? "Starting…"}
        </p>
        <p className="mt-2 text-sm text-gray-400">
          {win.open
            ? `The render window is open — it closes in ${inWords(win.minutesLeft ?? 0)}.`
            : `Tonight's render window: ${settings.window.start}–${settings.window.end} (opens ${hhmm(win.nextStart)}). vllm-small pauses for it and starts again after.`}
          {runtime.lastListenAt && ` Last listened ${when(runtime.lastListenAt)}${runtime.lastListenOutcome ? ` — ${runtime.lastListenOutcome}` : ""}.`}
        </p>
        <div className="mt-3 flex flex-wrap gap-2 text-xs">
          <Chip ok={services.smallModel} label="Brief writer (vllm-small)" />
          <Chip ok={services.search} label="Web search (SearXNG)" okText="up" badText="down — using Wikipedia search" />
          {runtime.pausedVllmSmall && <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-amber-300">vllm-small paused by the forge</span>}
          {runtime.waitingFor && <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-amber-300">GPU held by another session</span>}
        </div>
        {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
      </section>

      {/* ── waiting for you ── */}
      <section>
        <h2 className="mb-2 text-sm font-medium text-gray-200">Waiting for your review {review.length > 0 && <span className="text-orange-300">({review.length})</span>}</h2>
        {review.length === 0 ? (
          <p className="rounded-xl border border-gray-800 bg-gray-900/40 px-4 py-3 text-sm text-gray-500">No finished clips waiting. Clips are made during the window and appear here.</p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {review.map((i) => (
              <ReviewCard key={i.id} item={i} busy={!!busy} onVerdict={(verdict, reason) => act(`review-${i.id}`, { action: "review", id: i.id, verdict, reason })} />
            ))}
          </div>
        )}
      </section>

      {/* ── tonight ── */}
      <section>
        <h2 className="mb-2 text-sm font-medium text-gray-200">
          {win.open ? "Being made now" : "To make tonight"} <span className="text-gray-500">({tonight.length} of up to {settings.maxWaiting})</span>
        </h2>
        {tonight.length === 0 ? (
          <p className="rounded-xl border border-gray-800 bg-gray-900/40 px-4 py-3 text-sm text-gray-500">Nothing yet — the forge listens every {inWords(settings.listenEveryMin)}, or press Listen now.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {tonight.map((i) => (
              <li key={i.id} className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-gray-100">{i.topic}</p>
                    <p className="mt-1 text-sm text-gray-300">{i.whyNow}</p>
                    <p className="mt-1 text-xs text-gray-500">
                      Heard: {i.heard} · {when(i.createdAt)} · <StatusWord status={i.status} />
                    </p>
                  </div>
                  <div className="flex items-start gap-3">
                    {i.still && <img src={fileUrl(i.still.file)} alt="" className="h-16 w-28 rounded-md object-cover" />}
                    <button
                      onClick={() => act(`discard-${i.id}`, { action: "discard", id: i.id })}
                      disabled={!!busy}
                      className="rounded-md border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:bg-gray-800 disabled:opacity-40"
                      title="Remove it from tonight's list"
                    >
                      Remove
                    </button>
                  </div>
                </div>
                <HowMade item={i} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── history ── */}
      <details className="rounded-xl border border-gray-800 bg-gray-900/40">
        <summary className="cursor-pointer px-4 py-2.5 text-sm font-medium text-gray-200">History ({history.length})</summary>
        <ul className="divide-y divide-gray-800/60">
          {history.map((i) => (
            <li key={i.id} className="flex flex-wrap items-start gap-3 px-4 py-2.5 text-sm">
              {i.video?.output ? (
                <video src={fileUrl(i.video.output)} className="h-14 w-24 rounded object-cover" muted loop playsInline onMouseEnter={(e) => e.currentTarget.play()} onMouseLeave={(e) => e.currentTarget.pause()} />
              ) : null}
              <div className="min-w-0 flex-1">
                <p className="text-gray-200">
                  <StatusWord status={i.status} /> · {i.topic}
                </p>
                <p className="text-xs text-gray-500">
                  {when(i.createdAt)}
                  {i.review?.reason && ` · “${i.review.reason}”`}
                  {i.error && ` · ${i.error}`}
                </p>
                <HowMade item={i} />
              </div>
            </li>
          ))}
        </ul>
      </details>

      <details className="rounded-xl border border-gray-800 bg-gray-900/40 text-sm text-gray-300">
        <summary className="cursor-pointer px-4 py-2.5 font-medium text-gray-200">How it works</summary>
        <div className="space-y-2 px-4 pb-4">
          <p>
            <b className="text-gray-100">Listen</b> — every {inWords(settings.listenEveryMin)}: Google Trends ({settings.channel.geo}), Wikipedia most-read and the Hacker News front page. All free, no keys.
            Topics about death, violence, disasters, crime, politics or sex are removed in code before the model sees the list, as are topics made in the last three weeks.
          </p>
          <p>
            <b className="text-gray-100">Research</b> — vllm-small (Qwen2.5-7B, already running for quote-forge, so it costs no extra memory) scores the list for how well each can be shown <i>without people</i>, then
            uses two tools — web search through a self-hosted SearXNG, and reading a page — to learn why the best one matters today, and writes the brief. A brief that puts people in frame is sent back to be rewritten.
          </p>
          <p>
            <b className="text-gray-100">Make</b> — {settings.window.start}–{settings.window.end}: the forge takes the shared GPU claim, pauses vllm-small, makes the first frame with {settings.stillModel} and animates it with{" "}
            {settings.videoModel} ({settings.seconds} s, {settings.tier === "low" ? "480p" : "720p"}) through the Video Lab&apos;s queue. When the list is done — or there is no time left for another clip — vllm-small is started again.
          </p>
          <p>
            <b className="text-gray-100">You</b> — approve or reject each clip, with a reason if you like. The last reviews go into every new brief: more of what you approved, less of what you rejected.
          </p>
        </div>
      </details>

      <ExperimentDoc path={lab.doc} />
    </div>
  );
}

function Chip({ ok, label, okText = "running", badText = "stopped" }: { ok: boolean; label: string; okText?: string; badText?: string }) {
  return (
    <span className={`rounded-full px-2 py-0.5 ${ok ? "bg-emerald-500/15 text-emerald-300" : "bg-red-500/15 text-red-300"}`}>
      {label}: {ok ? okText : badText}
    </span>
  );
}

function StatusWord({ status }: { status: ForgeItem["status"] }) {
  const words: Record<ForgeItem["status"], [string, string]> = {
    brief: ["waiting for tonight", "text-gray-400"],
    still: ["making the first frame", "text-amber-300"],
    rendering: ["rendering", "text-amber-300"],
    review: ["waiting for review", "text-orange-300"],
    approved: ["approved", "text-emerald-300"],
    rejected: ["rejected", "text-red-300"],
    skipped: ["nothing made", "text-gray-500"],
    failed: ["failed", "text-red-300"],
  };
  const [w, c] = words[status];
  return <span className={c}>{w}</span>;
}

function ReviewCard({ item, busy, onVerdict }: { item: ForgeItem; busy: boolean; onVerdict: (v: "approved" | "rejected", reason: string) => void }) {
  const [reason, setReason] = useState("");
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-orange-500/30 bg-gray-900/60 p-3">
      {item.video?.output && <video src={fileUrl(item.video.output)} controls loop playsInline className="w-full rounded-lg bg-black" />}
      <p className="font-medium text-gray-100">{item.topic}</p>
      <p className="text-sm text-gray-300">{item.whyNow}</p>
      <p className="text-xs text-gray-500">
        {item.video?.model} · {item.video?.seconds} s{item.video?.latencyMs ? ` · made in ${inWords(item.video.latencyMs / 60000)}` : ""}
        {item.sources.length > 0 && " · "}
        {item.sources.slice(0, 3).map((s, n) => (
          <a key={s.url} href={s.url} target="_blank" rel="noreferrer" className="mr-1 text-orange-300/80 hover:underline">
            source {n + 1}
          </a>
        ))}
      </p>
      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Why? (optional — the next briefs learn from it)"
        className="rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-sm text-gray-200 placeholder:text-gray-600"
      />
      <div className="flex gap-2">
        <button onClick={() => onVerdict("approved", reason)} disabled={busy} className="flex-1 rounded-md bg-emerald-600/80 px-2 py-1 text-sm text-white hover:bg-emerald-600 disabled:opacity-40">
          Approve
        </button>
        <button onClick={() => onVerdict("rejected", reason)} disabled={busy} className="flex-1 rounded-md bg-red-600/70 px-2 py-1 text-sm text-white hover:bg-red-600 disabled:opacity-40">
          Reject
        </button>
      </div>
      <HowMade item={item} />
    </div>
  );
}

function HowMade({ item }: { item: ForgeItem }) {
  const a = item.agent;
  return (
    <details className="mt-1 text-xs text-gray-400">
      <summary className="cursor-pointer text-gray-500 hover:text-gray-300">How it was made</summary>
      <div className="mt-2 space-y-2 rounded-lg bg-gray-950/60 p-3">
        <p>
          Heard {item.listen.heardCount} trending topics; {item.listen.dropped.length} removed before the model saw them
          {item.listen.dropped.length > 0 && ` (e.g. ${item.listen.dropped.slice(0, 3).map((d) => `${d.title} — ${d.why}`).join("; ")})`}; {item.listen.shortlisted} shortlisted.
          {item.listen.problems.length > 0 && ` Problems: ${item.listen.problems.join("; ")}.`}
        </p>
        <p>
          {a.model}: {a.turns} turn{a.turns === 1 ? "" : "s"}, {(a.latencyMs / 1000).toFixed(1)} s, {a.promptTokens.toLocaleString()} + {a.completionTokens.toLocaleString()} tokens, $0 (local).
        </p>
        <ol className="list-decimal space-y-0.5 pl-5">
          {a.calls.map((c, n) => (
            <li key={n} className={c.ok ? "" : "text-amber-300/80"}>
              <span className="text-gray-300">{c.name}</span>
              {c.name === "search" && ` “${String(c.args.query ?? "")}”`}
              {c.name === "read" && ` ${String(c.args.url ?? "")}`} — {c.summary}
            </li>
          ))}
        </ol>
        {item.stillPrompt && (
          <p>
            <span className="text-gray-300">First frame:</span> {item.stillPrompt}
          </p>
        )}
        {item.motionPrompt && (
          <p>
            <span className="text-gray-300">Motion:</span> {item.motionPrompt}
          </p>
        )}
        <ul className="space-y-0.5">
          {item.timeline.map((t, n) => (
            <li key={n}>
              {when(t.at)} — {t.what}
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}
