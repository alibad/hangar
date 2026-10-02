"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import LabShell from "./lab-shell";
import Dialog, { buttonStyles } from "@/components/dialog";
import type { LabComponentProps } from "@/lib/labs";
import type { LabRunResult } from "@/lib/lab-types";
import type { MusicTrack } from "@/lib/music-store";
import type { MusicLabOutput } from "@/app/api/labs/music/run/route";

/**
 * The Music Lab: a prompt, optional lyrics, a length and a seed in; a song out,
 * kept in a gallery. Everything else — model row, Start/Stop, latency and VRAM,
 * the runs record, the experiment doc — is the shell's.
 *
 * What the engine can do is asked of it (/api/music/engine), not declared here:
 * the task list changes with the DiT that is loaded (stems exist only on the
 * base model), and the Lab says so and offers the swap rather than showing a
 * button that would fail.
 */

type Task = { id: string; label: string; needs_source?: boolean };
type Engine = {
  up: boolean;
  error?: string;
  status?: {
    ready: boolean;
    phase: string;
    error: string | null;
    dit: string | null;
    lm: string;
    lm_backend: string;
    busy: boolean;
    load_seconds: number | null;
    vram?: { allocated_gb: number; reserved_gb: number; card_used_gb: number; card_total_gb: number };
  };
  capabilities?: {
    dit: string | null;
    tasks: Task[];
    base_only_tasks: Task[];
    dits_available: string[];
    duration: { min: number; max: number };
    languages: string[];
    tracks: string[];
    formats: string[];
  };
};

type Source = { kind: "upload"; file: File } | { kind: "track"; track: MusicTrack };

const FALLBACK_TASKS: Task[] = [{ id: "text2music", label: "Text → music" }];
const PHASE_LABEL: Record<string, string> = {
  starting: "starting",
  "loading-dit": "loading the diffusion model",
  "loading-lm": "loading the planner LM",
  error: "failed to load",
};
const EXAMPLES = [
  { caption: "warm lo-fi hip hop, dusty drums, mellow Rhodes piano, vinyl crackle, 80 bpm, relaxed", instrumental: true },
  { caption: "cinematic travel montage, soaring strings, taiko drums, uplifting, builds to a big finish", instrumental: true },
  { caption: "upbeat indie pop, bright electric guitar, handclaps, female vocal, summer road trip", instrumental: false },
];

const inputCls =
  "rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-xs text-gray-200 outline-none placeholder:text-gray-600 focus:border-gray-500";

export default function MusicLab({ lab }: LabComponentProps) {
  const [engine, setEngine] = useState<Engine | null>(null);
  const [task, setTask] = useState("text2music");
  const [caption, setCaption] = useState("");
  const [lyrics, setLyrics] = useState("");
  const [instrumental, setInstrumental] = useState(true);
  const [duration, setDuration] = useState(30);
  const [seed, setSeed] = useState("");
  const [bpm, setBpm] = useState("");
  const [keyscale, setKeyscale] = useState("");
  const [language, setLanguage] = useState("en");
  const [thinking, setThinking] = useState(true);
  const [rewrite, setRewrite] = useState(false);
  const [fadeOut, setFadeOut] = useState("");
  const [source, setSource] = useState<Source | null>(null);
  const [reference, setReference] = useState<File | null>(null);
  const [repaintStart, setRepaintStart] = useState("0");
  const [repaintEnd, setRepaintEnd] = useState("10");
  const [extendSeconds, setExtendSeconds] = useState(30);
  const [coverStrength, setCoverStrength] = useState(0.5);
  const [stem, setStem] = useState("vocals");
  const [swapTo, setSwapTo] = useState("");
  const [swapping, setSwapping] = useState(false);
  const [swapError, setSwapError] = useState<string | null>(null);
  const [galleryKey, setGalleryKey] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const refRef = useRef<HTMLInputElement>(null);

  const loadEngine = useCallback(async () => {
    try {
      const j = (await fetch("/api/music/engine", { cache: "no-store" }).then((r) => r.json())) as Engine;
      setEngine(j);
      return j;
    } catch (e) {
      setEngine({ up: false, error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  }, []);

  // Poll quickly while the model is loading, slowly once it is settled.
  const settled = !engine?.up || engine.status?.ready || engine.status?.phase === "error";
  useEffect(() => {
    void loadEngine();
    const iv = setInterval(() => {
      if (!document.hidden) void loadEngine();
    }, settled ? 15_000 : 3_000);
    return () => clearInterval(iv);
  }, [loadEngine, settled]);

  const caps = engine?.capabilities;
  const tasks = caps?.tasks?.length ? caps.tasks : FALLBACK_TASKS;
  const current = tasks.find((t) => t.id === task) ?? tasks[0];
  const needsSource = !!current.needs_source;
  const baseDit = caps?.dits_available.find((d) => d.includes("base"));

  // A swap that removed the selected task (base -> turbo) falls back to text.
  useEffect(() => {
    if (caps && !caps.tasks.some((t) => t.id === task)) setTask("text2music");
  }, [caps, task]);

  const useAsSource = (track: MusicTrack) => {
    setSource({ kind: "track", track });
    if (task === "text2music") setTask("extend");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const swap = async (dit: string) => {
    setSwapping(true);
    setSwapError(null);
    try {
      const r = await fetch("/api/music/engine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dit }),
      });
      const j = await r.json();
      if (!r.ok) setSwapError(j.error ?? `HTTP ${r.status}`);
    } catch (e) {
      setSwapError(e instanceof Error ? e.message : String(e));
    } finally {
      setSwapping(false);
      void loadEngine();
    }
  };

  const seedNum = seed.trim() === "" ? null : Number(seed);
  const seedValid = seedNum === null || (Number.isInteger(seedNum) && seedNum >= 0);
  const canRun =
    seedValid &&
    (needsSource ? !!source : !!caption.trim() || (!instrumental && !!lyrics.trim())) &&
    !!engine?.status?.ready &&
    !swapping;

  const run = async (model: { id: string; local: boolean }, { compareGroup, signal }: { compareGroup: string; signal: AbortSignal }) => {
    const f = new FormData();
    f.set("model", model.id);
    f.set("task", current.id);
    f.set("caption", caption);
    f.set("lyrics", instrumental ? "" : lyrics);
    f.set("instrumental", String(instrumental));
    f.set("vocal_language", language);
    f.set("thinking", String(thinking));
    f.set("rewrite_caption", String(thinking && rewrite));
    if (Number(fadeOut) > 0) f.set("fade_out", fadeOut);
    f.set("format", "flac");
    if (compareGroup) f.set("compareGroup", compareGroup);
    if (seedNum !== null) f.set("seed", String(seedNum));
    if (current.id === "text2music") {
      f.set("duration", String(duration));
      if (bpm.trim()) f.set("bpm", bpm.trim());
      if (keyscale.trim()) f.set("keyscale", keyscale.trim());
    }
    if (current.id === "repaint") {
      f.set("repaint_start", repaintStart);
      f.set("repaint_end", repaintEnd);
    }
    if (current.id === "extend") f.set("extend_seconds", String(extendSeconds));
    if (current.id === "cover") f.set("cover_strength", String(coverStrength));
    if (current.id === "extract" || current.id === "lego") f.set("track", stem);
    if (reference) f.set("reference_audio", reference, reference.name);
    if (needsSource && source) {
      if (source.kind === "upload") f.set("src_audio", source.file, source.file.name);
      else f.set("src_track", source.track.id);
    }
    const r = await fetch("/api/labs/music/run", { method: "POST", body: f, signal });
    const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    setGalleryKey((k) => k + 1);
    if (!r.ok) return { ok: false, model: model.id, local: model.local, error: j.error ?? `HTTP ${r.status}` } as LabRunResult<MusicLabOutput>;
    return j as LabRunResult<MusicLabOutput>;
  };

  const st = engine?.status;
  const input = (
    <div className="space-y-3">
      {/* engine strip: what is loaded, and the swap stems need */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-gray-800 bg-gray-950/60 px-3 py-2 text-[11px] text-gray-400">
        <span
          className={`size-2 rounded-full ${!engine?.up ? "bg-gray-600" : st?.ready ? (st.busy ? "bg-amber-400 animate-pulse" : "bg-emerald-400") : st?.phase === "error" ? "bg-red-500" : "bg-amber-400 animate-pulse"}`}
          aria-hidden="true"
        />
        {!engine ? (
          <span>Asking the engine…</span>
        ) : !engine.up ? (
          <span>{engine.error && /else is answering/.test(engine.error) ? engine.error : "Engine not running — start ace-step-1.5 above."}</span>
        ) : (
          <>
            <span className="text-gray-300">
              {st?.ready ? (st.busy ? "generating" : "ready") : PHASE_LABEL[st?.phase ?? ""] ?? st?.phase}
              {st?.ready && st.load_seconds != null && <span className="text-gray-500"> · loaded in {st.load_seconds}s</span>}
            </span>
            <span>
              DiT <code className="text-gray-300">{st?.dit ?? "—"}</code>
            </span>
            <span>
              LM <code className="text-gray-300">{st?.lm}</code> ({st?.lm_backend})
            </span>
            {st?.vram && (
              // Only what this process holds. CUDA's own free/used figure is
              // wrong here: it cannot see memory held inside the WSL VM
              // (vllm-small), so the header's nvidia-smi reading is the card.
              <span className="tabular-nums" title="What the music engine itself holds on the GPU (torch reserved)">
                holds {st.vram.reserved_gb.toFixed(1)} GB
              </span>
            )}
            {caps && caps.dits_available.length > 1 && (
              <span className="ml-auto flex items-center gap-1.5">
                <select
                  value={swapTo || caps.dit || st?.dit || ""}
                  onChange={(e) => setSwapTo(e.target.value)}
                  className={inputCls}
                  aria-label="Diffusion model"
                  disabled={swapping || !st?.ready}
                >
                  {caps.dits_available.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={swapping || !st?.ready || !swapTo || swapTo === caps.dit}
                  onClick={() => swap(swapTo)}
                  className="rounded-md border border-gray-700 px-2 py-1 text-gray-300 hover:border-gray-500 disabled:opacity-40"
                >
                  {swapping ? "Swapping…" : "Swap"}
                </button>
              </span>
            )}
          </>
        )}
        {st?.phase === "error" && st.error && <span className="w-full text-red-300">{st.error}</span>}
        {swapError && <span className="w-full text-red-300">{swapError}</span>}
      </div>

      {/* task */}
      <div className="flex flex-wrap items-center gap-1.5">
        {tasks.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTask(t.id)}
            className={`rounded-full border px-2.5 py-1 text-xs transition ${t.id === current.id ? "border-orange-500 bg-orange-500/10 text-orange-200" : "border-gray-700 text-gray-400 hover:border-gray-500"}`}
          >
            {t.label}
          </button>
        ))}
        {caps && caps.base_only_tasks.some((t) => !caps.tasks.some((x) => x.id === t.id)) && (
          <span className="text-[11px] text-gray-500">
            {caps.base_only_tasks.map((t) => t.label.toLowerCase()).join(", ")}: need the base DiT
            {baseDit ? (
              <button
                type="button"
                disabled={swapping || !st?.ready}
                onClick={() => swap(baseDit)}
                className="ml-1.5 text-orange-300 underline-offset-2 hover:underline disabled:opacity-40"
              >
                load {baseDit}
              </button>
            ) : (
              " (not downloaded)"
            )}
          </span>
        )}
      </div>

      {/* source clip, for audio-in tasks */}
      {needsSource && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-gray-700 px-3 py-2 text-xs text-gray-400">
          <span>Source clip:</span>
          {source ? (
            <span className="text-gray-200">
              {source.kind === "upload" ? source.file.name : source.track.caption || source.track.id}
              {source.kind === "track" && source.track.meta.audio_seconds != null && (
                <span className="text-gray-500"> · {source.track.meta.audio_seconds}s from the gallery</span>
              )}
            </span>
          ) : (
            <span className="text-gray-500">none — upload one, or pick “Use as source” on a track below</span>
          )}
          <button type="button" onClick={() => fileRef.current?.click()} className="rounded-md border border-gray-700 px-2 py-0.5 text-gray-300 hover:border-gray-500">
            Upload…
          </button>
          {source && (
            <button type="button" onClick={() => setSource(null)} className="text-gray-500 hover:text-gray-300">
              clear
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="audio/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) setSource({ kind: "upload", file });
              e.target.value = "";
            }}
          />
        </div>
      )}

      <textarea
        value={caption}
        onChange={(e) => setCaption(e.target.value)}
        rows={2}
        placeholder={
          needsSource
            ? current.id === "extract"
              ? "Optional — describe the source to help separation"
              : "Describe what the new material should sound like (genre, instruments, mood)"
            : "Describe the music: genre, instruments, mood, tempo. e.g. warm lo-fi hip hop, dusty drums, Rhodes piano"
        }
        aria-label="Music description"
        className="w-full resize-y rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-100 outline-none placeholder:text-gray-600 focus:border-gray-500"
      />
      {!needsSource && !caption && (
        <div className="flex flex-wrap gap-1.5 text-[11px]">
          {EXAMPLES.map((ex) => (
            <button
              key={ex.caption}
              type="button"
              onClick={() => {
                setCaption(ex.caption);
                setInstrumental(ex.instrumental);
              }}
              className="max-w-[20rem] truncate rounded-full border border-gray-800 px-2 py-0.5 text-gray-500 hover:border-gray-600 hover:text-gray-300"
            >
              {ex.caption}
            </button>
          ))}
        </div>
      )}

      {(current.id === "text2music" || current.id === "repaint" || current.id === "extend" || current.id === "cover") && (
        <div className="space-y-1.5">
          <label className="flex items-center gap-2 text-xs text-gray-400">
            <input type="checkbox" checked={instrumental} onChange={(e) => setInstrumental(e.target.checked)} className="accent-orange-500" />
            Instrumental
          </label>
          {!instrumental && (
            <textarea
              value={lyrics}
              onChange={(e) => setLyrics(e.target.value)}
              rows={6}
              placeholder={"[verse]\nFirst line of the song\nSecond line\n\n[chorus]\nThe hook goes here"}
              aria-label="Lyrics"
              className="w-full resize-y rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 font-mono text-xs text-gray-100 outline-none placeholder:text-gray-600 focus:border-gray-500"
            />
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-gray-400">
        {current.id === "text2music" && (
          <>
            <label className="flex items-center gap-2">
              Length
              <input
                type="range"
                min={caps?.duration.min ?? 10}
                max={Math.min(caps?.duration.max ?? 600, 300)}
                step={5}
                value={duration}
                onChange={(e) => setDuration(Number(e.target.value))}
                className="accent-orange-500"
              />
              <span className="w-12 tabular-nums text-gray-300">{fmtSeconds(duration)}</span>
            </label>
            <label className="flex items-center gap-1.5">
              BPM
              <input value={bpm} onChange={(e) => setBpm(e.target.value)} inputMode="numeric" placeholder="auto" className={`w-14 ${inputCls}`} />
            </label>
            <label className="flex items-center gap-1.5">
              Key
              <input value={keyscale} onChange={(e) => setKeyscale(e.target.value)} placeholder="auto" className={`w-20 ${inputCls}`} />
            </label>
            <label className="flex items-center gap-1.5" title="The 4B LM plans tempo, key, structure and audio codes before the diffusion model renders them. Off = the DiT works from the caption alone: faster, looser.">
              <input type="checkbox" checked={thinking} onChange={(e) => setThinking(e.target.checked)} className="accent-orange-500" />
              LM planner
            </label>
            {thinking && (
              <label
                className="flex items-center gap-1.5"
                title="Let the planner rewrite your description before the diffusion model sees it. Off by default: in the experiment it made no measurable difference to adherence and added ~3.5 s."
              >
                <input type="checkbox" checked={rewrite} onChange={(e) => setRewrite(e.target.checked)} className="accent-orange-500" />
                rewrite caption
              </label>
            )}
            <label className="flex items-center gap-1.5" title="Fade the last seconds to silence — what a video bed usually needs">
              Fade out
              <input value={fadeOut} onChange={(e) => setFadeOut(e.target.value)} inputMode="decimal" placeholder="0" className={`w-12 ${inputCls}`} />s
            </label>
          </>
        )}
        {current.id === "repaint" && (
          <label className="flex items-center gap-1.5">
            Repaint from
            <input value={repaintStart} onChange={(e) => setRepaintStart(e.target.value)} className={`w-14 ${inputCls}`} />
            to
            <input value={repaintEnd} onChange={(e) => setRepaintEnd(e.target.value)} className={`w-14 ${inputCls}`} />
            s
          </label>
        )}
        {current.id === "extend" && (
          <label className="flex items-center gap-2">
            Add
            <input type="range" min={10} max={120} step={5} value={extendSeconds} onChange={(e) => setExtendSeconds(Number(e.target.value))} className="accent-orange-500" />
            <span className="w-10 tabular-nums text-gray-300">{extendSeconds}s</span>
          </label>
        )}
        {current.id === "cover" && (
          <label className="flex items-center gap-2" title="How much of the source's structure to keep. Low = a looser restyle.">
            Keep source
            <input type="range" min={0} max={1} step={0.05} value={coverStrength} onChange={(e) => setCoverStrength(Number(e.target.value))} className="accent-orange-500" />
            <span className="w-8 tabular-nums text-gray-300">{coverStrength.toFixed(2)}</span>
          </label>
        )}
        {(current.id === "extract" || current.id === "lego") && (
          <label className="flex items-center gap-1.5">
            {current.id === "extract" ? "Stem" : "Instrument"}
            <select value={stem} onChange={(e) => setStem(e.target.value)} className={inputCls}>
              {(caps?.tracks ?? ["vocals"]).map((t) => (
                <option key={t} value={t}>
                  {t.replace("_", " ")}
                </option>
              ))}
            </select>
          </label>
        )}
        <span
          className="flex items-center gap-1.5"
          title="A clip whose sound the output should borrow — timbre and production, not melody. ACE-Step encodes it as a separate reference latent."
        >
          Reference
          <button type="button" onClick={() => refRef.current?.click()} className="max-w-[12rem] truncate rounded-md border border-gray-700 px-2 py-0.5 text-gray-300 hover:border-gray-500">
            {reference ? reference.name : "none — add…"}
          </button>
          {reference && (
            <button type="button" onClick={() => setReference(null)} className="text-gray-500 hover:text-gray-300">
              clear
            </button>
          )}
          <input
            ref={refRef}
            type="file"
            accept="audio/*"
            className="hidden"
            onChange={(e) => {
              setReference(e.target.files?.[0] ?? null);
              e.target.value = "";
            }}
          />
        </span>
        {!instrumental && (
          <label className="flex items-center gap-1.5">
            Vocal language
            <select value={language} onChange={(e) => setLanguage(e.target.value)} className={inputCls}>
              {(caps?.languages ?? ["en"]).map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex items-center gap-1.5">
          Seed
          <input
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
            inputMode="numeric"
            placeholder="random"
            className={`w-24 ${inputCls} ${seedValid ? "" : "border-red-500"}`}
          />
        </label>
      </div>
    </div>
  );

  return (
    <div className="space-y-5">
      <LabShell<MusicLabOutput>
        lab={lab}
        canRun={canRun}
        input={input}
        run={run}
        renderOutput={(r) => (r.output ? <TrackCard track={r.output.track} onUseAsSource={useAsSource} expanded /> : null)}
      />
      <Gallery refreshKey={galleryKey} onUseAsSource={useAsSource} />
    </div>
  );
}

// ── gallery ───────────────────────────────────────────────────────────────────

/** How many tracks the page itself shows; the rest open in a dialog, so the page stays short. */
const GALLERY_ON_PAGE = 6;

function Gallery({ refreshKey, onUseAsSource }: { refreshKey: number; onUseAsSource: (t: MusicTrack) => void }) {
  const [tracks, setTracks] = useState<MusicTrack[] | null>(null);
  const [all, setAll] = useState(false);
  const load = useCallback(() => {
    fetch("/api/music/tracks?limit=60", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => setTracks(Array.isArray(j.tracks) ? j.tracks : []))
      .catch(() => setTracks([]));
  }, []);
  useEffect(load, [load, refreshKey]);

  const remove = async (id: string) => {
    if (!window.confirm("Delete this track from the gallery? The run stays in the runs record.")) return;
    await fetch(`/api/music/tracks?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    load();
  };

  return (
    <section className="rounded-xl border border-gray-800 bg-gray-900/40">
      <h2 className="flex items-baseline gap-2 border-b border-gray-800 px-4 py-2.5 text-sm font-medium text-gray-200">
        Gallery
        <span className="text-[11px] font-normal text-gray-500">every track is kept, with the seed and settings that made it</span>
      </h2>
      {!tracks ? (
        <p className="px-4 py-4 text-xs text-gray-500">Loading…</p>
      ) : tracks.length === 0 ? (
        <p className="px-4 py-4 text-xs text-gray-500">Nothing yet. Generated tracks land here.</p>
      ) : (
        <>
          <ul className="divide-y divide-gray-800/70">
            {tracks.slice(0, GALLERY_ON_PAGE).map((t) => (
              <li key={t.id} className="px-4 py-3">
                <TrackCard track={t} onUseAsSource={onUseAsSource} onDelete={() => remove(t.id)} />
              </li>
            ))}
          </ul>
          {tracks.length > GALLERY_ON_PAGE && (
            <div className="border-t border-gray-800 px-4 py-3">
              <button type="button" onClick={() => setAll(true)} className={buttonStyles.secondarySm}>
                Show all {tracks.length} tracks
              </button>
            </div>
          )}
          <Dialog open={all} onClose={() => setAll(false)} title="Gallery" subtitle={`All ${tracks.length} tracks, newest first — each with the seed and settings that made it.`} size="xl">
            <ul className="divide-y divide-gray-800/70">
              {tracks.map((t) => (
                <li key={t.id} className="py-3">
                  <TrackCard
                    track={t}
                    onUseAsSource={(x) => {
                      setAll(false);
                      onUseAsSource(x);
                    }}
                    onDelete={() => remove(t.id)}
                  />
                </li>
              ))}
            </ul>
          </Dialog>
        </>
      )}
    </section>
  );
}

// ── one track: player, waveform, what made it ────────────────────────────────

const TASK_VERB: Record<string, string> = {
  text2music: "",
  repaint: "repaint of",
  extend: "extension of",
  cover: "remix of",
  extract: "stem from",
  lego: "added part on",
  complete: "completion of",
};

function TrackCard({
  track: t,
  onUseAsSource,
  onDelete,
  expanded,
}: {
  track: MusicTrack;
  onUseAsSource: (t: MusicTrack) => void;
  onDelete?: () => void;
  expanded?: boolean;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [pos, setPos] = useState(0);
  const url = `/api/music/tracks/file?id=${encodeURIComponent(t.id)}`;
  const m = t.meta;
  const r = m.resolved ?? {};
  const facts = [
    m.audio_seconds != null ? fmtSeconds(m.audio_seconds) : null,
    r.bpm ? `${r.bpm} bpm` : null,
    r.keyscale || null,
    r.timesignature ? `${r.timesignature}/4` : null,
    // Only a generated song is "instrumental" or sung; a stem or an edit is
    // whatever its source was.
    m.task === "text2music" ? (t.instrumental ? "instrumental" : `vocals${t.vocalLanguage ?? r.vocal_language ? ` (${t.vocalLanguage ?? r.vocal_language})` : ""}`) : null,
    `seed ${m.seed}`,
  ].filter(Boolean);
  const rtf = m.audio_seconds && m.latency_ms ? m.audio_seconds / (m.latency_ms / 1000) : null;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        {m.task !== "text2music" && (
          <span className="rounded bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-300">
            {TASK_VERB[m.task] ?? m.task} {t.track ? `${t.track} · ` : ""}
            {t.sourceName ?? "a clip"}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-sm text-gray-100" title={t.caption}>
          {t.caption || r.caption || (t.track ? `${t.track.replace("_", " ")} stem` : t.sourceName ?? "(no description)")}
        </span>
        <span className="text-[11px] text-gray-500">{new Date(t.savedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
      </div>
      <Waveform
        peaks={m.peaks ?? []}
        progress={m.audio_seconds ? pos / m.audio_seconds : 0}
        onSeek={(f) => {
          const a = audioRef.current;
          if (a && m.audio_seconds) {
            a.currentTime = f * m.audio_seconds;
            void a.play();
          }
        }}
      />
      <audio ref={audioRef} controls preload="none" src={url} onTimeUpdate={(e) => setPos(e.currentTarget.currentTime)} className="h-8 w-full" />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-500">
        <span className="text-gray-400">{facts.join(" · ")}</span>
        <span className="tabular-nums" title="Generation time, and how many seconds of audio per second of compute">
          {(m.latency_ms / 1000).toFixed(1)} s{rtf ? ` · ${rtf.toFixed(1)}× realtime` : ""}
        </span>
        {m.peak_reserved_gb != null && (
          <span className="tabular-nums" title="This process's own torch peak (reserved) — per-process, unlike the card-wide figure above">
            torch peak {m.peak_reserved_gb.toFixed(1)} GB
          </span>
        )}
        <span className="ml-auto flex items-center gap-3">
          <button type="button" onClick={() => onUseAsSource(t)} className="text-orange-300 hover:underline">
            Use as source
          </button>
          <a href={`${url}&download=1`} className="text-gray-400 hover:text-gray-200">
            Download
          </a>
          {onDelete && (
            <button type="button" onClick={onDelete} className="text-gray-500 hover:text-red-300">
              Delete
            </button>
          )}
        </span>
      </div>
      {expanded && (r.caption || t.lyrics || m.time_costs) && (
        <details className="text-[11px] text-gray-500">
          <summary className="cursor-pointer text-gray-400">What the planner decided</summary>
          <div className="mt-1.5 space-y-1.5">
            {r.caption && r.caption !== t.caption && (
              <p>
                <span className="text-gray-400">Rewritten caption:</span> {r.caption}
              </p>
            )}
            {t.lyrics && <pre className="whitespace-pre-wrap font-mono text-gray-400">{t.lyrics}</pre>}
            {m.time_costs && Object.keys(m.time_costs).length > 0 && (
              <p className="tabular-nums">
                {Object.entries(m.time_costs)
                  .filter(([k]) => /total|phase/.test(k))
                  .map(([k, v]) => `${k.replace(/_/g, " ")} ${v}s`)
                  .join(" · ")}
              </p>
            )}
          </div>
        </details>
      )}
    </div>
  );
}

function Waveform({ peaks, progress, onSeek }: { peaks: number[]; progress: number; onSeek: (fraction: number) => void }) {
  if (!peaks.length) return null;
  const n = peaks.length;
  const played = Math.floor(progress * n);
  return (
    <svg
      viewBox={`0 0 ${n} 40`}
      preserveAspectRatio="none"
      className="h-10 w-full cursor-pointer"
      role="slider"
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(progress * 100)}
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        onSeek(Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)));
      }}
    >
      {peaks.map((p, i) => {
        const h = Math.max(1, p * 38);
        return <rect key={i} x={i + 0.15} y={20 - h / 2} width={0.7} height={h} className={i < played ? "fill-orange-400" : "fill-gray-600"} />;
      })}
    </svg>
  );
}

function fmtSeconds(s: number): string {
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return m ? `${m}:${String(r).padStart(2, "0")}` : `${r}s`;
}
