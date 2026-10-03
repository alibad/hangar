"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Dialog from "@/components/dialog";
import type { LabComponentProps } from "@/lib/labs";
import type { Bakeoff, ForgeItem, ForgeRuntime, ForgeSettings } from "@/lib/forge/forge";
import type { Story } from "@/lib/forge/story";
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
  stories?: Story[];
  bakeoffs?: Bakeoff[];
};

const MONTAGE = "http://localhost:8017";
const KIND: Record<string, string> = { parable: "A parable", fable: "A fable", myth: "A myth, retold", folktale: "A folktale", thought: "A thought experiment", original: "An original story" };
const FORMAT: Record<string, string> = {
  tale: "Tale",
  monologue: "Monologue",
  letter: "Letter",
  verse: "Poem",
  dialogue: "Conversation",
  silent: "Silent film",
  documentary: "Documentary",
  thought: "Thought experiment",
  micro: "Very short",
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

  const { settings, runtime, window: win, services, stories = [], bakeoffs = [] } = state;
  // A story's shots are shown with their story, a bake-off's with its bake-off, not one by one.
  const items = state.items.filter((i) => !i.story && !i.variant);
  const review = items.filter((i) => i.status === "review");
  const tonight = items.filter((i) => i.status === "brief" || i.status === "still" || i.status === "rendering");
  // Clips live in the gallery; history is what made nothing (skipped, failed).
  const history = items.filter((i) => !["review", "brief", "still", "rendering"].includes(i.status) && !i.video?.output);

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
            ? `The render window is open — it closes in ${inWords(win.minutesLeft ?? 0)}${settings.extraWindowUntil && Date.parse(settings.extraWindowUntil) > Date.now() ? " (a one-off extra window)" : ""}.${settings.mode === "stories" ? " Writing story films and rendering their shots until then." : settings.unlimited ? ` Making clips in batches of ${settings.batchSize} until then, or until nothing fresh is left.` : ""}`
            : `Tonight's render window: ${settings.window.start}–${settings.window.end} (opens ${hhmm(win.nextStart)}). vllm-small pauses for it and starts again after.`}
          {runtime.lastListenAt && ` Last listened ${when(runtime.lastListenAt)}${runtime.lastListenOutcome ? ` — ${runtime.lastListenOutcome}` : ""}.`}
        </p>
        <div className="mt-3 flex flex-wrap gap-2 text-xs">
          <span className="rounded-full bg-gray-800/70 p-0.5">
            {(["trending", "stories"] as const).map((m) => (
              <button
                key={m}
                onClick={() => act(`mode-${m}`, { action: "settings", patch: { mode: m } })}
                disabled={!!busy}
                className={`rounded-full px-2 py-0.5 ${(settings.mode ?? "trending") === m ? "bg-orange-600 text-white" : "text-gray-300 hover:text-white"}`}
                title={m === "stories" ? "Short narrated films: a large local model writes a story as a shot list" : "Clips about what people search for today"}
              >
                {m === "stories" ? "Making story films" : "Making trending clips"}
              </button>
            ))}
          </span>
          <Chip ok={services.smallModel} label="Brief writer (vllm-small)" />
          <Chip ok={services.search} label="Web search (SearXNG)" okText="up" badText="down — using Wikipedia search" />
          {runtime.pausedVllmSmall && <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-amber-300">vllm-small paused by the forge</span>}
          {runtime.waitingFor && <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-amber-300">GPU held by another session</span>}
        </div>
        {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
      </section>

      {/* ── story films ── */}
      {stories.length > 0 && <Stories stories={stories} items={state.items} onRequeue={(id) => act(`requeue-${id}`, { action: "requeue", id })} busy={!!busy} />}

      {/* ── stack bake-offs ── */}
      {bakeoffs.length > 0 && <Bakeoffs bakeoffs={bakeoffs} items={state.items} />}

      {/* ── the gallery ── */}
      <Gallery
        items={items}
        waiting={review.length}
        busy={!!busy}
        onVerdict={(id, verdict, reason) => act(`review-${id}`, { action: "review", id, verdict, reason })}
      />

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
            <b className="text-gray-100">Listen</b> — Google Trends (rotating {settings.geos.length} countries), three days of Wikipedia most-read and the Hacker News front page. All free, no keys.
            Topics about death, violence, disasters, crime, politics or sex are removed in code before the model sees the list, as are topics made in the last three weeks.
            {settings.weatherFallback && " When every list is used up, it listens to the weather right now in photogenic cities instead."}
          </p>
          <p>
            <b className="text-gray-100">Research</b> — vllm-small (Qwen2.5-7B, already running for quote-forge) asks of each topic whether it is a person or risky news and how well it can be shown <i>without people</i>,
            then uses web search (a self-hosted SearXNG) and page reading to learn why the best one matters today, and writes the brief. Briefs with people, writing or brand names are sent back.
            {settings.shotsPerTopic >= 2 && " Each topic gets two shots: the scene, then a close-up of one detail."}
          </p>
          <p>
            <b className="text-gray-100">Make</b> — in the render window ({settings.window.start}–{settings.window.end} nightly{settings.extraWindowUntil && Date.parse(settings.extraWindowUntil) > Date.now() ? `, and today until ${hhmm(settings.extraWindowUntil)}` : ""}):
            it takes the shared GPU claim, pauses vllm-small, and for each brief makes the first frame with {settings.stillModel}
            {settings.stillCheck && ", shows it to a local vision model (Qwen3-VL 8B) and draws again if it shows people, writing or a logo"}, then animates it with {settings.videoModel} ({settings.seconds} s,{" "}
            {settings.tier === "low" ? "832×480" : "1280×704"}) through the Video Lab&apos;s queue.
            {settings.unlimited ? ` It works in batches of ${settings.batchSize}, starting vllm-small again between batches, until the window closes.` : " When the list is done, vllm-small is started again."}
          </p>
          <p>
            <b className="text-gray-100">Then</b> — Montage (http://localhost:8017) checks every clip again, keeps the best, and cuts them into one-minute reels with captions and music.
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

/**
 * Every story the forge has written, as a poster: a mosaic of its first frames
 * (the newest clip plays on hover), its format, title, progress and stack.
 * Opening one shows the screenplay shot by shot, as it is made. The finished
 * film is cut in Montage.
 */
function Stories({ stories, items, onRequeue, busy }: { stories: Story[]; items: ForgeItem[]; onRequeue: (id: string) => void; busy: boolean }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const open = stories.find((s) => s.id === openId) ?? null;
  return (
    <section>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium text-gray-200">
          Story films <span className="text-gray-500">({stories.length})</span>
        </h2>
        <a href={MONTAGE} target="_blank" rel="noreferrer" className="text-xs text-orange-300 hover:underline">
          Watch the finished films in Montage ↗
        </a>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {stories.map((st) => (
          <StoryPoster key={st.id} st={st} shots={items.filter((i) => i.story?.id === st.id)} onOpen={() => setOpenId(st.id)} />
        ))}
      </div>
      <Dialog open={!!open} onClose={() => setOpenId(null)} title={open?.title ?? ""} subtitle={open?.logline} size="xl">
        {open && <StoryDetail st={open} items={items} onRequeue={onRequeue} busy={busy} />}
      </Dialog>
    </section>
  );
}

function StoryPoster({ st, shots, onOpen }: { st: Story; shots: ForgeItem[]; onOpen: () => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  const byIdx = (i: number) => shots.find((x) => x.story!.index === i);
  const done = shots.filter((i) => i.video?.output && (i.status === "review" || i.status === "approved")).length;
  const failed = shots.filter((i) => i.status === "failed").length;
  const making = shots.some((i) => ["still", "rendering"].includes(i.status));
  // Four frames from across the film, and the clip of the middle one for hover.
  const picks = [0, 0.33, 0.66, 1].map((p) => Math.round(p * (st.shots.length - 1)));
  const frames = picks.map((i) => byIdx(i)?.still?.file ?? null);
  const hoverClip = shots.filter((i) => i.video?.output).sort((a, b) => a.story!.index - b.story!.index)[Math.floor(done / 2)]?.video?.output;
  const label = `${st.format ? `${FORMAT[st.format] ?? st.format} · ` : ""}${KIND[st.kind] ?? st.kind}`;
  const pct = Math.round((done / st.shots.length) * 100);
  return (
    <button
      type="button"
      onClick={onOpen}
      onMouseEnter={() => void ref.current?.play().catch(() => undefined)}
      onMouseLeave={() => ref.current?.pause()}
      className="group relative overflow-hidden rounded-2xl border border-gray-800 bg-black text-left transition hover:-translate-y-0.5 hover:border-gray-600 hover:shadow-[0_24px_50px_-24px_rgba(0,0,0,0.7)]"
    >
      <div className="relative aspect-[4/3]">
        <div className="absolute inset-0 grid grid-cols-2 grid-rows-2 gap-px bg-black">
          {frames.map((fr, i) =>
            fr ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={i} src={fileUrl(fr)} alt="" className="h-full w-full object-cover transition duration-700 group-hover:scale-105" loading="lazy" />
            ) : (
              <div key={i} className="h-full w-full bg-gradient-to-br from-gray-800 to-gray-950" />
            ),
          )}
        </div>
        {hoverClip && <video ref={ref} src={fileUrl(hoverClip)} muted loop playsInline preload="none" className="absolute inset-0 h-full w-full object-cover opacity-0 transition duration-500 group-hover:opacity-100" />}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black via-black/40 to-black/10" />
        <div className="absolute left-3 right-3 top-3 flex items-start justify-between gap-2">
          <span className="rounded-full bg-black/55 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.18em] text-orange-200 backdrop-blur">{label}</span>
          <span
            className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-medium backdrop-blur ${
              done === st.shots.length ? "bg-emerald-500/30 text-emerald-100" : making ? "bg-orange-500/30 text-orange-100" : "bg-black/55 text-white/70"
            }`}
          >
            {done === st.shots.length ? "All shots made" : making ? `Making · ${done}/${st.shots.length}` : `${done}/${st.shots.length}${failed ? ` · ${failed} failed` : ""}`}
          </span>
        </div>
        <div className="absolute inset-x-4 bottom-3">
          <p className="font-serif text-2xl leading-tight text-white [text-shadow:0_2px_10px_rgba(0,0,0,0.7)]">{st.title}</p>
          <p className="mt-1 line-clamp-2 text-xs italic leading-snug text-white/75">{st.logline}</p>
          <div className="mt-2.5 flex gap-0.5" aria-label={`${pct}% of shots made`}>
            {st.shots.map((_, idx) => {
              const it = byIdx(idx);
              const c = !it ? "bg-white/15" : it.video?.output ? "bg-orange-400" : it.status === "failed" ? "bg-red-500/80" : it.status === "rendering" || it.status === "still" ? "animate-pulse bg-orange-200/80" : "bg-white/20";
              return <span key={idx} className={`h-1 flex-1 rounded-full ${c}`} />;
            })}
          </div>
        </div>
      </div>
      {st.stack ? (
        <div className="flex flex-wrap gap-1 border-t border-gray-800 bg-gray-950 px-3 py-2 text-[10.5px] text-gray-400">
          <span className="rounded-full bg-gray-800/80 px-2 py-0.5">🎞 {st.stack.video.label}</span>
          <span className="rounded-full bg-gray-800/80 px-2 py-0.5">🎙 {st.stack.voices ? [...new Set(Object.values(st.stack.voices).map((v) => v.label))].join(" + ") : "title cards"}</span>
          <span className="rounded-full bg-gray-800/80 px-2 py-0.5">♪ {st.stack.score.label}</span>
          {st.stack.finish.key !== "lanczos" && <span className="rounded-full bg-gray-800/80 px-2 py-0.5">✦ {st.stack.finish.label}</span>}
        </div>
      ) : (
        <div className="border-t border-gray-800 bg-gray-950 px-3 py-2 text-[10.5px] text-gray-500">{when(st.createdAt)} · Wan 2.2 5B · Chatterbox</div>
      )}
    </button>
  );
}

/** One story's screenplay, shot by shot, as it is made. */
function StoryDetail({ st, items, onRequeue, busy }: { st: Story; items: ForgeItem[]; onRequeue: (id: string) => void; busy: boolean }) {
  const shots = items.filter((i) => i.story?.id === st.id).sort((a, b) => a.story!.index - b.story!.index);
  const failed = shots.filter((i) => i.status === "failed").length;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 text-sm sm:grid-cols-[2fr_3fr]">
        <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-3">
          <p className="text-[10px] uppercase tracking-[0.2em] text-orange-300">The lesson</p>
          <p className="mt-1 font-serif text-lg leading-snug text-gray-100">{st.lesson}</p>
        </div>
        <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-3 text-xs text-gray-400">
          <p>
            {st.format ? `${FORMAT[st.format] ?? st.format} · ` : ""}
            {KIND[st.kind] ?? st.kind} · written by {st.model} in {Math.round(st.latencyMs / 1000)} s from “{st.seed}” · {when(st.createdAt)}
          </p>
          <p className="mt-1">Look: {st.look}</p>
          <p className="mt-1">Score brief: {st.stack?.score.style ?? st.score}</p>
          {st.stack && (
            <p className="mt-1">
              Stack: {st.stack.video.label}
              {st.stack.voices ? ` · ${Object.entries(st.stack.voices).map(([who, v]) => `${who}: ${v.label}`).join(", ")}` : " · title cards"} · {st.stack.score.label} · {st.stack.finish.label}
            </p>
          )}
          {st.stack?.fallback && <p className="mt-1 text-amber-300/80">{st.stack.fallback}</p>}
        </div>
      </div>
      {st.characters.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {st.characters.map((c) => (
            <span key={c.name} className="max-w-full rounded-xl border border-gray-800 bg-gray-900/40 px-3 py-1.5 text-xs" title={c.look}>
              <span className="text-gray-100">{c.name}</span> <span className="text-gray-500">— {c.look}</span>
            </span>
          ))}
        </div>
      )}
      {st.notes.some((n) => n.startsWith("Continuity")) && <p className="text-xs text-gray-500">{st.notes.filter((n) => n.startsWith("Continuity")).join(" ")}</p>}
      {failed > 0 && (
        <button onClick={() => onRequeue(st.id)} disabled={busy} className="rounded-md border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:bg-gray-800 disabled:opacity-40">
          Make the {failed} failed shot{failed > 1 ? "s" : ""} again
        </button>
      )}
      <ol className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {st.shots.map((shot, idx) => {
          const it = shots.find((x) => x.story!.index === idx);
          return (
            <li key={idx} className="text-xs">
              <div className="relative aspect-video overflow-hidden rounded-lg bg-black">
                {it?.video?.output ? (
                  <video src={fileUrl(it.video.output)} poster={it.still ? fileUrl(it.still.file) : undefined} muted loop playsInline preload="none" className="h-full w-full object-cover" onMouseEnter={(e) => void e.currentTarget.play().catch(() => undefined)} onMouseLeave={(e) => e.currentTarget.pause()} />
                ) : it?.still ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={fileUrl(it.still.file)} alt="" className="h-full w-full object-cover opacity-70" />
                ) : null}
                <span className="absolute left-1.5 top-1 text-[11px] font-medium text-white [text-shadow:0_1px_3px_black]">{idx + 1}</span>
                {it && (
                  <span className="absolute bottom-1 right-1.5 text-[10px] text-white/80 [text-shadow:0_1px_3px_black]">
                    <StatusWord status={it.status} />
                  </span>
                )}
              </div>
              <p className="mt-1 italic text-gray-200">
                {shot.speaker && shot.speaker !== "Narrator" && <span className="not-italic text-gray-500">{shot.speaker}: </span>}
                {shot.narration}
              </p>
              {shot.cast && shot.cast.length > 0 && <p className="text-[10px] text-gray-600">In frame: {shot.cast.join(", ")}</p>}
              <details className="mt-0.5 text-gray-500">
                <summary className="cursor-pointer hover:text-gray-300">Prompts{it?.check ? ` · beauty ${it.check.beauty}/5` : ""}</summary>
                <p className="mt-1">Picture: {it?.stillPrompt ?? shot.picture}</p>
                <p className="mt-1">Motion: {shot.motion}</p>
                {it?.video?.latencyMs ? (
                  <p className="mt-1">
                    Clip: {it.video.model} in {Math.round(it.video.latencyMs / 1000)} s
                  </p>
                ) : null}
                {it?.error && <p className="mt-1 text-red-300">{it.error}</p>}
              </details>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * Bake-offs: one finished screenplay re-animated from the same first frames
 * by other video models — the numbers per model, and every clip. The films
 * are cut and compared side by side in Montage.
 */
function Bakeoffs({ bakeoffs, items }: { bakeoffs: Bakeoff[]; items: ForgeItem[] }) {
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  return (
    <section>
      <h2 className="mb-2 text-sm font-medium text-gray-200">
        Stack bake-offs <span className="text-gray-500">— the same screenplay and first frames, other video models; films compared in </span>
        <a href={MONTAGE} target="_blank" rel="noreferrer" className="text-orange-300 hover:underline">
          Montage ↗
        </a>
      </h2>
      {bakeoffs.map((b) => {
        const base = items.filter((i) => i.story?.id === b.storyId && i.video?.output).sort((x, y) => x.story!.index - y.story!.index);
        const rows = [
          { key: "base", label: "Wan 2.2 5B (the film)", model: base[0]?.video?.model ?? "wan2.2-ti2v-5b", shots: base },
          ...b.variants.map((v) => ({ key: v.key, label: v.label, model: v.videoModel, shots: items.filter((i) => i.variant?.bakeoffId === b.id && i.variant.key === v.key).sort((x, y) => x.variant!.index - y.variant!.index) })),
        ];
        return (
          <div key={b.id} className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
            <p className="text-gray-100">
              <span className="font-medium">{b.title}</span> <span className="text-xs text-gray-500">· {when(b.createdAt)} · {b.variants.length} stacks against the film</span>
            </p>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-xs">
                <thead className="text-gray-500">
                  <tr>
                    <th className="py-1 pr-3 font-normal">Stack</th>
                    <th className="py-1 pr-3 font-normal">Clips</th>
                    <th className="py-1 pr-3 font-normal">Avg clip time</th>
                    <th className="py-1 pr-3 font-normal">Peak VRAM</th>
                    <th className="py-1 pr-3 font-normal">Beauty (vision)</th>
                    <th className="py-1 pr-3 font-normal">Distortion</th>
                    <th className="py-1 font-normal">Writing / logos</th>
                  </tr>
                </thead>
                <tbody className="text-gray-300">
                  {rows.map((r) => {
                    const done = r.shots.filter((i) => i.video?.output);
                    const failed = r.shots.filter((i) => i.status === "failed");
                    const t = avg(done.map((i) => i.video?.latencyMs ?? 0).filter(Boolean));
                    const v = done.map((i) => i.video?.peakVramGb ?? 0).filter(Boolean);
                    const beauty = avg(done.map((i) => i.check?.beauty ?? 0).filter(Boolean));
                    const art = avg(done.filter((i) => i.check).map((i) => i.check!.artifacts));
                    const flags = done.filter((i) => i.check?.text || i.check?.logo).length;
                    return (
                      <tr key={r.key} className="border-t border-gray-800/70 align-top">
                        <td className="py-1.5 pr-3">
                          <span className="text-gray-100">{r.label}</span>
                          <span className="block text-[10px] text-gray-500">{r.model}</span>
                          {failed[0]?.error && <span className="block max-w-xs text-[10px] text-red-300">{failed[0].error.slice(0, 160)}</span>}
                        </td>
                        <td className="py-1.5 pr-3">
                          {done.length}/{r.key === "base" ? r.shots.length : r.shots.length}
                          {failed.length ? <span className="text-red-300"> · {failed.length} failed</span> : null}
                        </td>
                        <td className="py-1.5 pr-3">{t ? `${Math.round(t / 1000)} s` : "—"}</td>
                        <td className="py-1.5 pr-3">{v.length ? `${Math.max(...v).toFixed(1)} GB` : "—"}</td>
                        <td className="py-1.5 pr-3">{beauty ? beauty.toFixed(1) : "—"}</td>
                        <td className="py-1.5 pr-3">{art != null ? art.toFixed(2) : "—"}</td>
                        <td className="py-1.5">{done.length ? flags : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="mt-3 space-y-2">
              {rows.map((r) => (
                <div key={r.key} className="flex items-center gap-1 overflow-x-auto">
                  <span className="w-24 shrink-0 truncate text-[10px] text-gray-500">{r.label}</span>
                  {r.shots.map((i) => (
                    <div key={i.id} className="relative aspect-video w-24 shrink-0 overflow-hidden rounded bg-black" title={`${i.topic} · ${i.status}${i.check ? ` · beauty ${i.check.beauty}, distortion ${i.check.artifacts}` : ""}`}>
                      {i.video?.output ? (
                        <video src={fileUrl(i.video.output)} poster={i.still ? fileUrl(i.still.file) : undefined} muted loop playsInline preload="none" className="h-full w-full object-cover" onMouseEnter={(e) => void e.currentTarget.play().catch(() => undefined)} onMouseLeave={(e) => e.currentTarget.pause()} />
                      ) : i.still ? (
                        <img src={fileUrl(i.still.file)} alt="" className="h-full w-full object-cover opacity-30" />
                      ) : null}
                      {i.status === "rendering" && <span className="absolute inset-x-0 bottom-0 h-0.5 animate-pulse bg-orange-400" />}
                      {i.status === "failed" && <span className="absolute inset-0 grid place-items-center bg-black/60 text-[9px] text-red-300">failed</span>}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </section>
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

type GalleryFilter = "review" | "approved" | "rejected" | "all";

/**
 * Every finished clip as a grid: hover plays it, click opens it large with
 * Approve / Reject, and a verdict moves straight on to the next clip — so
 * thirty clips are a few minutes' review, not a long scroll of cards.
 */
function Gallery({
  items,
  waiting,
  busy,
  onVerdict,
}: {
  items: ForgeItem[];
  waiting: number;
  busy: boolean;
  onVerdict: (id: string, v: "approved" | "rejected", reason: string) => Promise<void>;
}) {
  const clips = items.filter((i) => i.video?.output);
  const [filter, setFilter] = useState<GalleryFilter>(waiting > 0 ? "review" : "all");
  const [openId, setOpenId] = useState<string | null>(null);
  const shown = clips.filter((i) => filter === "all" || i.status === filter);
  const count = (f: GalleryFilter) => (f === "all" ? clips.length : clips.filter((i) => i.status === f).length);
  const idx = openId ? shown.findIndex((i) => i.id === openId) : -1;
  const open = idx >= 0 ? shown[idx] : openId ? clips.find((i) => i.id === openId) ?? null : null;

  const step = useCallback(
    (d: number) => {
      if (!shown.length) return;
      const from = idx >= 0 ? idx : 0;
      setOpenId(shown[(from + d + shown.length) % shown.length].id);
    },
    [idx, shown],
  );

  useEffect(() => {
    if (!openId) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.key === "Escape") setOpenId(null);
      if (e.key === "ArrowRight") step(1);
      if (e.key === "ArrowLeft") step(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openId, step]);

  const tabs: [GalleryFilter, string][] = [
    ["review", "Waiting for review"],
    ["approved", "Approved"],
    ["rejected", "Rejected"],
    ["all", "All"],
  ];

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-gray-200">
          Gallery <span className="text-gray-500">({clips.length} clips)</span>
        </h2>
        <div className="flex flex-wrap gap-1.5">
          {tabs.map(([f, label]) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded-full px-2.5 py-1 text-xs ${filter === f ? "bg-orange-600 text-white" : "bg-gray-800/70 text-gray-300 hover:bg-gray-800"}`}
            >
              {label} ({count(f)})
            </button>
          ))}
        </div>
      </div>
      {shown.length === 0 ? (
        <p className="rounded-xl border border-gray-800 bg-gray-900/40 px-4 py-3 text-sm text-gray-500">
          {filter === "review" ? "Nothing waiting for review. Clips are made during the window and appear here." : "No clips here yet."}
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {shown.map((i) => (
            <button key={i.id} onClick={() => setOpenId(i.id)} className="group overflow-hidden rounded-lg border border-gray-800 bg-gray-900/60 text-left hover:border-orange-500/50">
              <div className="relative aspect-video bg-black">
                <video
                  src={fileUrl(i.video!.output!)}
                  poster={i.still ? fileUrl(i.still.file) : undefined}
                  muted
                  loop
                  playsInline
                  preload="none"
                  className="h-full w-full object-cover"
                  onMouseEnter={(e) => void e.currentTarget.play().catch(() => undefined)}
                  onMouseLeave={(e) => e.currentTarget.pause()}
                />
                {i.status !== "review" && (
                  <span className={`absolute right-1.5 top-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${i.status === "approved" ? "bg-emerald-600/90 text-white" : "bg-red-600/90 text-white"}`}>
                    {i.status === "approved" ? "✓" : "✕"}
                  </span>
                )}
              </div>
              <p className="truncate px-2 py-1.5 text-xs text-gray-300 group-hover:text-gray-100">{i.topic}</p>
            </button>
          ))}
        </div>
      )}

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={() => setOpenId(null)}>
          <div className="relative w-full max-w-3xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 flex items-center justify-between text-xs text-gray-400">
              <span>
                {idx >= 0 ? `${idx + 1} of ${shown.length}` : ""} · ← → to move, Esc to close
              </span>
              <div className="flex gap-2">
                <button onClick={() => step(-1)} className="rounded-md border border-gray-700 px-2 py-0.5 hover:bg-gray-800">
                  ←
                </button>
                <button onClick={() => step(1)} className="rounded-md border border-gray-700 px-2 py-0.5 hover:bg-gray-800">
                  →
                </button>
                <button onClick={() => setOpenId(null)} className="rounded-md border border-gray-700 px-2 py-0.5 hover:bg-gray-800">
                  Close
                </button>
              </div>
            </div>
            <ReviewCard
              key={open.id}
              item={open}
              busy={busy}
              autoPlay
              onVerdict={async (v, reason) => {
                const next = shown.length > 1 ? shown[(Math.max(idx, 0) + 1) % shown.length].id : null;
                await onVerdict(open.id, v, reason);
                // In the "waiting" view the reviewed clip leaves the list; either way, move on.
                setOpenId(next && next !== open.id ? next : null);
              }}
            />
          </div>
        </div>
      )}
    </section>
  );
}

function ReviewCard({
  item,
  busy,
  onVerdict,
  autoPlay = false,
}: {
  item: ForgeItem;
  busy: boolean;
  onVerdict: (v: "approved" | "rejected", reason: string) => void | Promise<void>;
  autoPlay?: boolean;
}) {
  const [reason, setReason] = useState("");
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-orange-500/30 bg-gray-900/60 p-3">
      {item.video?.output && <video src={fileUrl(item.video.output)} poster={item.still ? fileUrl(item.still.file) : undefined} controls loop playsInline autoPlay={autoPlay} muted={autoPlay} className="w-full rounded-lg bg-black" />}
      <p className="font-medium text-gray-100">{item.topic}{item.review && <span className={`ml-2 text-xs ${item.review.verdict === "approved" ? "text-emerald-300" : "text-red-300"}`}>{item.review.verdict}{item.review.reason ? ` — “${item.review.reason}”` : ""}</span>}</p>
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
