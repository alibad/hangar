"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import LabShell from "./lab-shell";
import Dialog, { buttonStyles } from "@/components/dialog";
import { ServiceControl } from "@/components/service-control";
import { releaseRequest, type GpuHolder } from "@/lib/gpu-holders";
import { VIDEO_MODELS, clampSeconds, getVideoModel, videoSecondsPerMinute, type VideoMode, type VideoTier } from "@/lib/video-models";
import type { LabComponentProps } from "@/lib/labs";
import type { LabRunResult } from "@/lib/lab-types";
import type { VideoJob } from "@/lib/video-jobs";
import type { VideoModelStatus } from "@/app/api/video/models/route";

/**
 * The Video Lab.
 *
 * A clip takes minutes, so nothing here holds a request open: Run enqueues a
 * job (src/lib/video-jobs.ts) and the Lab follows it — stage, steps, an ETA that
 * says what it is based on, and, while it waits for memory, the coordinator's
 * reason with the buttons that fix it. Everything the shell already does
 * (models on this host with Start/Stop, the runs record, the doc) stays the
 * shell's.
 */

type Fit = {
  host: { id: string; name: string };
  comfyUp: boolean;
  free: { vramGb: number | null; ramGb: number };
  holders: GpuHolder[];
  models: VideoModelStatus[];
};

const LENGTHS = [3, 5, 8, 10, 15];
const ACTIVE = new Set(["queued", "waiting", "running"]);
const CLOUD = VIDEO_MODELS.filter((m) => !m.local);

const fileUrl = (rel: string) => `/api/video/file?path=${encodeURIComponent(rel)}`;

export default function VideoLab({ lab }: LabComponentProps) {
  const [mode, setMode] = useState<VideoMode>("i2v");
  const [prompt, setPrompt] = useState("");
  const [seconds, setSeconds] = useState(5);
  const [tier, setTier] = useState<VideoTier>("low");
  const [seed, setSeed] = useState("");
  const [source, setSource] = useState<string | null>(null);
  const [cloud, setCloud] = useState("");
  const [jobs, setJobs] = useState<VideoJob[]>([]);
  const [fit, setFit] = useState<Fit | null>(null);

  const loadJobs = useCallback(async () => {
    try {
      const j = await fetch("/api/video/jobs?limit=30", { cache: "no-store" }).then((r) => r.json());
      setJobs(j.jobs ?? []);
    } catch {
      /* next poll */
    }
  }, []);
  const loadFit = useCallback(async () => {
    try {
      setFit(await fetch("/api/video/models", { cache: "no-store" }).then((r) => r.json()));
    } catch {
      /* next poll */
    }
  }, []);

  const anyActive = jobs.some((j) => ACTIVE.has(j.status));
  useEffect(() => {
    void loadJobs();
    void loadFit();
  }, [loadJobs, loadFit]);
  useEffect(() => {
    const iv = setInterval(() => {
      if (document.hidden) return;
      void loadJobs();
    }, anyActive ? 2000 : 15_000);
    const iv2 = setInterval(() => !document.hidden && void loadFit(), 12_000);
    return () => {
      clearInterval(iv);
      clearInterval(iv2);
    };
  }, [anyActive, loadJobs, loadFit]);

  const seedNum = seed.trim() === "" ? undefined : Number(seed);
  const seedValid = seedNum === undefined || Number.isInteger(seedNum);
  const cloudSpec = cloud ? getVideoModel(cloud) : undefined;
  const cloudSeconds = cloudSpec ? clampSeconds(cloudSpec, seconds) : 0;
  const canRun = !!prompt.trim() && seedValid && (mode === "t2v" || !!source);

  const enqueue = async (model: string, compareGroup?: string) => {
    const r = await fetch("/api/video/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, mode, prompt, seconds, tier, seed: seedNum, sourceImage: mode === "i2v" ? source : undefined, compareGroup }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
    return j.job as VideoJob;
  };

  return (
    <LabShell<VideoJob>
      lab={lab}
      canRun={canRun}
      input={
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {(["i2v", "t2v"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`rounded-md border px-2.5 py-1 ${mode === m ? "border-orange-500/60 bg-orange-500/10 text-orange-200" : "border-gray-700 text-gray-400 hover:text-gray-200"}`}
              >
                {m === "i2v" ? "Image → video" : "Text → video"}
              </button>
            ))}
            <span className="text-[11px] text-gray-500">
              {mode === "i2v" ? "Animate a still — one you upload, one from the gallery, or one a local model makes now." : "The prompt alone."}
            </span>
          </div>

          {mode === "i2v" && <SourcePicker value={source} onChange={setSource} />}

          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
            placeholder={
              mode === "i2v"
                ? "What happens in the shot: camera move, motion, light. e.g. Slow aerial push-in over the old town at golden hour, pigeons lifting off the square."
                : "Describe the shot: subject, setting, camera move, light, mood."
            }
            aria-label="Prompt"
            className="w-full resize-y rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-100 outline-none placeholder:text-gray-600 focus:border-gray-500"
          />

          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-gray-400">
            <label className="flex items-center gap-2">
              Length
              <select value={seconds} onChange={(e) => setSeconds(Number(e.target.value))} className="rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-gray-200">
                {LENGTHS.map((s) => (
                  <option key={s} value={s}>
                    {s} s
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2">
              Resolution
              <select value={tier} onChange={(e) => setTier(e.target.value as VideoTier)} className="rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-gray-200">
                <option value="low">Low (~480p)</option>
                <option value="high">High (~720p)</option>
              </select>
            </label>
            <label className="flex items-center gap-2">
              Seed
              <input
                value={seed}
                onChange={(e) => setSeed(e.target.value)}
                inputMode="numeric"
                placeholder="random"
                className={`w-28 rounded-md border bg-gray-950 px-2 py-1 text-gray-200 ${seedValid ? "border-gray-700" : "border-red-500"}`}
              />
            </label>
            <label className="flex items-center gap-2">
              Also on cloud
              <select value={cloud} onChange={(e) => setCloud(e.target.value)} className="rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-gray-200">
                <option value="">no</option>
                {CLOUD.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} · ${m.usdPerSecond?.toFixed(2)}/s
                  </option>
                ))}
              </select>
              {cloudSpec && (
                <span className="text-[11px] text-sky-300">
                  {cloudSeconds} s ≈ ${(cloudSeconds * (cloudSpec.usdPerSecond ?? 0)).toFixed(2)}
                  {cloudSeconds !== seconds ? ` (it only does ${cloudSpec.allowedSeconds?.join("/")} s)` : ""}
                </span>
              )}
            </label>
          </div>
          <p className="text-[11px] text-gray-600">
            Lengths and sizes snap to what each model accepts. The first run of a model loads 20–45 GB of weights; later runs in a row are faster
            only if nothing else took the memory in between.
          </p>
        </div>
      }
      run={async (model, { compareGroup, signal }) => {
        const group = cloud ? compareGroup || crypto.randomUUID() : compareGroup || undefined;
        let job: VideoJob;
        try {
          job = await enqueue(model.id, group);
          if (cloud) void enqueue(cloud, group).catch(() => undefined);
        } catch (e) {
          return { ok: false, model: model.id, local: model.local, error: e instanceof Error ? e.message : String(e) };
        }
        void loadJobs();
        // Follow the job. The queue owns it, so leaving the page does not lose it.
        const cancel = () => void fetch(`/api/video/jobs/${job.id}`, { method: "DELETE" });
        signal.addEventListener("abort", cancel, { once: true });
        while (ACTIVE.has(job.status)) {
          await new Promise((r) => setTimeout(r, 2500));
          if (signal.aborted) break;
          try {
            job = (await fetch(`/api/video/jobs/${job.id}`, { cache: "no-store" }).then((r) => r.json())).job ?? job;
          } catch {
            /* keep following */
          }
        }
        signal.removeEventListener("abort", cancel);
        void loadJobs();
        return toResult(job);
      }}
      renderOutput={(r) => (r.output ? <VideoResult job={r.output} /> : null)}
      below={<QueueAndFit jobs={jobs} fit={fit} reload={() => void Promise.all([loadJobs(), loadFit()])} />}
    />
  );
}

function toResult(job: VideoJob): LabRunResult<VideoJob> {
  return {
    ok: job.status === "done",
    model: job.model,
    local: job.local,
    error: job.status === "done" ? undefined : job.error ?? job.status,
    output: job,
    runId: job.runId ?? null,
    latencyMs: job.latencyMs ?? null,
    peakVramGb: job.peakVramGb ?? null,
    baselineVramGb: job.baselineVramGb ?? null,
    vramNote: job.local ? "Card-wide peak from nvidia-smi while the job held the GPU; not per-process." : null,
    costUsd: job.costUsd ?? null,
  };
}

// ── source still ──────────────────────────────────────────────────────────────

type GalleryImage = { rel: string; url: string; prompt: string; model: string; width?: number; height?: number };

function SourcePicker({ value, onChange }: { value: string | null; onChange: (p: string | null) => void }) {
  const [tab, setTab] = useState<"gallery" | "make" | "upload">("make");
  const [gallery, setGallery] = useState<GalleryImage[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [still, setStill] = useState("");
  const [stillModel, setStillModel] = useState("z-image-turbo");

  useEffect(() => {
    if (tab !== "gallery" || gallery) return;
    fetch("/api/qwen/images", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => setGallery((j.images ?? []).slice(0, 36)))
      .catch(() => setGallery([]));
  }, [tab, gallery]);

  const register = async (body: Record<string, string>) => {
    const r = await fetch("/api/video/source", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
    onChange(j.path);
  };

  const make = async () => {
    setBusy(true);
    setNote("Generating a 1280×720 still locally…");
    try {
      const r = await fetch("/api/image/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Source": "video-lab" },
        body: JSON.stringify({ prompt: still, model: stillModel, width: 1280, height: 720 }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.saved) throw new Error(j.error ?? `HTTP ${r.status}`);
      await register({ galleryRel: j.saved });
      setNote(`Made with ${stillModel} in ${((j.latency ?? 0) / 1000 || 0).toFixed(1)} s and saved to the gallery.`);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const upload = async (file: File) => {
    setBusy(true);
    setNote(null);
    try {
      const dataUrl = await new Promise<string>((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result));
        fr.onerror = () => rej(fr.error);
        fr.readAsDataURL(file);
      });
      await register({ dataUrl });
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap gap-3 rounded-lg border border-gray-800 bg-gray-950/50 p-3">
      <div className="flex h-[90px] w-[160px] shrink-0 items-center justify-center overflow-hidden rounded-md border border-gray-800 bg-gray-900">
        {value ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={fileUrl(value)} alt="Source still" className="h-full w-full object-cover" />
        ) : (
          <span className="px-2 text-center text-[11px] text-gray-600">No source still yet</span>
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex gap-1 text-[11px]">
          {(
            [
              ["make", "Make one locally"],
              ["gallery", "From the gallery"],
              ["upload", "Upload"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`rounded px-2 py-0.5 ${tab === id ? "bg-gray-800 text-gray-100" : "text-gray-500 hover:text-gray-300"}`}
            >
              {label}
            </button>
          ))}
          {value && (
            <button type="button" onClick={() => onChange(null)} className="ml-auto text-gray-500 hover:text-gray-300">
              clear
            </button>
          )}
        </div>
        {tab === "make" && (
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={still}
              onChange={(e) => setStill(e.target.value)}
              placeholder="The still: e.g. Aerial view of Lisbon's Alfama rooftops at golden hour, photorealistic"
              className="min-w-[16rem] flex-1 rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-xs text-gray-200"
            />
            <select value={stillModel} onChange={(e) => setStillModel(e.target.value)} className="rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-xs text-gray-200" aria-label="Image model for the still">
              <option value="z-image-turbo">Z-Image Turbo (ComfyUI)</option>
              <option value="flux2-klein-4b">FLUX.2 Klein 4B (ComfyUI)</option>
              <option value="qwen-image">Qwen-Image</option>
            </select>
            <button
              type="button"
              disabled={busy || !still.trim()}
              onClick={() => void make()}
              className="rounded-md border border-orange-600/50 px-2.5 py-1 text-xs text-orange-200 hover:border-orange-500 disabled:opacity-40"
            >
              {busy ? "Making…" : "Make still"}
            </button>
          </div>
        )}
        {tab === "gallery" && (
          <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
            {gallery === null ? (
              <span className="text-[11px] text-gray-500">Loading…</span>
            ) : gallery.length === 0 ? (
              <span className="text-[11px] text-gray-500">The gallery is empty.</span>
            ) : (
              gallery.map((g) => (
                <button
                  key={g.rel}
                  type="button"
                  title={`${g.model} · ${g.prompt.slice(0, 120)}`}
                  onClick={() => void register({ galleryRel: g.rel }).catch((e) => setNote(String(e)))}
                  className="h-14 w-24 overflow-hidden rounded border border-gray-800 hover:border-orange-500/60"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={g.url} alt="" loading="lazy" className="h-full w-full object-cover" />
                </button>
              ))
            )}
          </div>
        )}
        {tab === "upload" && (
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            disabled={busy}
            onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])}
            className="text-xs text-gray-400 file:mr-2 file:rounded file:border-0 file:bg-gray-800 file:px-2 file:py-1 file:text-gray-200"
          />
        )}
        {note && <p className="text-[11px] text-gray-400">{note}</p>}
        <p className="text-[10px] text-gray-600">The still is scaled and centre-cropped to the clip&apos;s 16:9 frame, the same way for every model.</p>
      </div>
    </div>
  );
}

// ── one finished clip ─────────────────────────────────────────────────────────

function VideoResult({ job }: { job: VideoJob }) {
  if (!job.output) {
    return <p className="text-xs text-gray-500">{job.status === "done" ? "Finished without a file." : job.error ?? job.status}</p>;
  }
  const src = fileUrl(job.output);
  const clipSeconds = job.frames / job.fps;
  const vsm = job.latencyMs ? videoSecondsPerMinute(clipSeconds, job.latencyMs) : null;
  const ph = job.phases ?? {};
  const s = (ms?: number) => (ms == null ? "—" : `${(ms / 1000).toFixed(0)} s`);
  return (
    <div className="space-y-3">
      <video src={src} controls playsInline preload="metadata" className="w-full rounded-lg border border-gray-800 bg-black" />
      <Filmstrip src={src} />
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] sm:grid-cols-3">
        <Stat k="Clip" v={`${clipSeconds.toFixed(1)} s · ${job.width}×${job.height} · ${job.frames} frames @ ${job.fps} fps${job.hasAudio ? " · audio" : ""}`} />
        <Stat k="Generation" v={job.latencyMs ? `${(job.latencyMs / 1000).toFixed(0)} s${vsm != null ? ` · ${vsm} s of video per minute` : ""}` : "—"} />
        {job.local ? (
          <>
            <Stat k="Phases" v={`load ${s(ph.load)} · sample ${s(ph.sample)} · decode+write ${s(ph.decode)}`} />
            {job.processPeakVramGb != null && (
              <Stat
                k="ComfyUI itself (peak)"
                v={`${job.processPeakVramGb.toFixed(1)} GB VRAM · ${(job.processPeakRamGb ?? 0).toFixed(1)} GB RAM resident`}
              />
            )}
            <Stat
              k="Peak VRAM (card)"
              v={job.peakVramGb != null ? `${job.peakVramGb.toFixed(1)} GB (+${Math.max(0, job.peakVramGb - (job.baselineVramGb ?? 0)).toFixed(1)})` : "—"}
            />
            <Stat
              k="Peak RAM used (box)"
              v={job.peakRamUsedGb != null ? `${job.peakRamUsedGb.toFixed(1)} GB (+${Math.max(0, job.peakRamUsedGb - (job.baselineRamUsedGb ?? 0)).toFixed(1)})` : "—"}
            />
            <Stat k="Seed · steps" v={`${job.seed} · ${job.steps}`} />
          </>
        ) : (
          <Stat k="Cost" v={job.costUsd != null ? `$${job.costUsd.toFixed(2)}` : "—"} />
        )}
      </dl>
      <p className="text-[10px] text-gray-600">
        {job.local
          ? job.processPeakVramGb != null
            ? "“ComfyUI itself” is per-process (Windows GPU counters) — what the model needed. Card and box figures include everything else running. "
            : "Memory figures are box-wide, sampled each second while the job held the GPU — anything else running shows up in them. "
          : ""}
        <a href={`${src}&download=1`} className="text-gray-400 hover:text-gray-200">
          Download mp4
        </a>
        {job.outputBytes ? ` · ${(job.outputBytes / 1e6).toFixed(1)} MB` : ""}
      </p>
    </div>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-wide text-gray-600">{k}</dt>
      <dd className="truncate text-gray-300" title={v}>
        {v}
      </dd>
    </div>
  );
}

/** Eight frames across the clip, pulled in the browser by seeking a hidden copy. */
function Filmstrip({ src, count = 8 }: { src: string; count?: number }) {
  const [frames, setFrames] = useState<string[]>([]);
  useEffect(() => {
    let dead = false;
    const v = document.createElement("video");
    v.muted = true;
    v.preload = "auto";
    v.src = src;
    const shots: string[] = [];
    const canvas = document.createElement("canvas");
    const grab = async () => {
      const d = v.duration;
      if (!Number.isFinite(d) || d <= 0) return;
      canvas.width = 192;
      canvas.height = Math.round((192 * v.videoHeight) / Math.max(1, v.videoWidth));
      for (let i = 0; i < count && !dead; i++) {
        await new Promise<void>((res) => {
          v.onseeked = () => res();
          v.currentTime = Math.min(d - 0.05, (d * i) / (count - 1));
        });
        canvas.getContext("2d")?.drawImage(v, 0, 0, canvas.width, canvas.height);
        shots.push(canvas.toDataURL("image/jpeg", 0.7));
      }
      if (!dead) setFrames([...shots]);
    };
    v.onloadeddata = () => void grab();
    return () => {
      dead = true;
      v.removeAttribute("src");
      v.load();
    };
  }, [src, count]);
  if (!frames.length) return null;
  return (
    <div className="flex gap-1 overflow-x-auto" aria-label="Frames across the clip">
      {frames.map((f, i) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img key={i} src={f} alt={`Frame ${i + 1} of ${frames.length}`} className="h-16 shrink-0 rounded border border-gray-800" />
      ))}
    </div>
  );
}

// ── queue + "will it fit" ─────────────────────────────────────────────────────

/** Finished clips the page itself shows; the whole history opens in a dialog. */
const QUEUE_ON_PAGE = 6;
const FINISHED = new Set(["done", "failed", "cancelled"]);

const ORIGIN: Record<string, string> = { forge: "Video Forge", lab: "Lab", mcp: "MCP", bench: "Bench", montage: "Montage" };

function QueueAndFit({ jobs, fit, reload }: { jobs: VideoJob[]; fit: Fit | null; reload: () => void }) {
  const [open, setOpen] = useState<VideoJob | null>(null);
  const [all, setAll] = useState(false);
  // What is still to come, always; of what is finished, only the latest few.
  const pending = jobs.filter((j) => !FINISHED.has(j.status));
  const finished = jobs.filter((j) => FINISHED.has(j.status));
  const recent = finished.slice(0, QUEUE_ON_PAGE);
  const made = finished.filter((j) => j.status === "done").length;
  const localModels = useMemo(() => fit?.models.filter((m) => m.spec.local && m.available) ?? [], [fit]);
  const remove = async (j: VideoJob) => {
    await fetch(`/api/video/jobs/${j.id}?remove=1`, { method: "DELETE" });
    reload();
  };
  return (
    <div className="grid gap-4 xl:grid-cols-[3fr_2fr]">
      <section className="min-w-0 rounded-2xl border border-gray-800 bg-gray-900/40 p-4">
        <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-sm font-medium text-gray-200">Clips</h2>
          <p className="text-[11px] text-gray-500">
            {pending.length ? `${pending.length} in the queue · ` : ""}
            {made} made{finished.length > made ? ` · ${finished.length - made} failed or cancelled` : ""}
          </p>
          {jobs.length > pending.length + recent.length && (
            <button type="button" onClick={() => setAll(true)} className="ml-auto text-[11px] text-gray-400 underline-offset-4 hover:text-gray-200 hover:underline">
              See all {finished.length} →
            </button>
          )}
        </div>
        {jobs.length === 0 ? (
          <p className="py-6 text-center text-xs text-gray-500">Nothing queued yet. Every clip lands here and in Recent runs, and keeps running if you leave the page.</p>
        ) : (
          <div className="space-y-4">
            {pending.map((j) => (
              <ActiveCard key={j.id} job={j} fit={fit} reload={reload} />
            ))}
            {recent.length > 0 && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 2xl:grid-cols-3">
                {recent.map((j) => (
                  <ClipCard key={j.id} job={j} onOpen={() => setOpen(j)} onRemove={() => void remove(j)} />
                ))}
              </div>
            )}
          </div>
        )}
        <Dialog open={all} onClose={() => setAll(false)} title="Every clip" subtitle="Newest first. Hover to play, open one to see its settings and timings." size="xl">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            {finished.map((j) => (
              <ClipCard key={j.id} job={j} compact onOpen={() => setOpen(j)} onRemove={() => void remove(j)} />
            ))}
          </div>
        </Dialog>
        <Dialog open={!!open} onClose={() => setOpen(null)} title={open ? (getVideoModel(open.model)?.label ?? open.model) : ""} subtitle={open?.prompt} size="xl">
          {open && <VideoResult job={open} />}
        </Dialog>
      </section>

      <section className="rounded-2xl border border-gray-800 bg-gray-900/40">
        <h2 className="border-b border-gray-800 px-4 py-2.5 text-sm font-medium text-gray-200">
          Will it fit right now?
          {fit && (
            <span className="ml-2 text-[11px] font-normal text-gray-500">
              free: {fit.free.vramGb != null ? `${fit.free.vramGb} GB VRAM · ` : ""}
              {fit.free.ramGb} GB RAM
            </span>
          )}
        </h2>
        {!fit ? (
          <p className="px-4 py-4 text-xs text-gray-500">Checking…</p>
        ) : (
          <ul className="divide-y divide-gray-800/70">
            {!fit.comfyUp && (
              <li className="flex items-center gap-3 px-4 py-2.5 text-xs text-amber-300">
                ComfyUI isn&apos;t running — it runs every local video model.
                <ServiceControl id="comfyui" up={false} probe={async () => (await fetch("/api/video/models").then((r) => r.json())).comfyUp} showLogs={false} />
              </li>
            )}
            {localModels.map((m) => (
              <li key={m.spec.id} className="space-y-1.5 px-4 py-2.5">
                <div className="flex items-center gap-2 text-xs">
                  <span className={`size-2 shrink-0 rounded-full ${m.installed === false ? "bg-gray-600" : m.fit?.ok ? "bg-emerald-400" : "bg-amber-400"}`} aria-hidden="true" />
                  <span className="text-gray-200">{m.spec.label}</span>
                  <span className="ml-auto text-[11px] text-gray-500">
                    {m.fit?.needVramGb != null ? `${m.fit.needVramGb} GB VRAM · ${m.fit.needRamGb} GB RAM` : "footprint not measured"}
                  </span>
                </div>
                {m.installed === false ? (
                  <p className="text-[11px] text-gray-500">Weights missing: {m.missing.slice(0, 2).join(", ")}{m.missing.length > 2 ? ` +${m.missing.length - 2}` : ""}</p>
                ) : m.fit && !m.fit.ok ? (
                  <div className="space-y-1">
                    <p className="text-[11px] text-amber-200/90">{m.fit.note}</p>
                    {m.fit.stop && m.fit.stop.length > 0 && <ReleaseButtons holders={m.fit.stop} onReleased={reload} />}
                  </div>
                ) : m.fit ? (
                  <p className="text-[11px] text-gray-500">{m.fit.note}</p>
                ) : null}
                {m.spec.caveat && <p className="text-[10px] text-amber-400/80">{m.spec.caveat}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** A small round progress dial over the first frame. */
function Dial({ pct }: { pct: number | null }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative grid size-20 place-items-center">
      <svg viewBox="0 0 64 64" className="absolute inset-0 -rotate-90" aria-hidden="true">
        <circle cx="32" cy="32" r={r} fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth="4" />
        {pct != null && <circle cx="32" cy="32" r={r} fill="none" stroke="white" strokeWidth="4" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)} className="transition-all duration-700" />}
      </svg>
      <span className="text-lg font-semibold tabular-nums text-white [text-shadow:0_1px_6px_rgba(0,0,0,0.6)]">{pct != null ? `${pct}%` : "…"}</span>
    </div>
  );
}

/** A clip being made: its first frame, breathing, with the dial, the step and the time left — or why it waits. */
function ActiveCard({ job: j, fit, reload }: { job: VideoJob; fit: Fit | null; reload: () => void }) {
  const spec = getVideoModel(j.model);
  const pct = j.stepsTotal ? Math.round(((j.stepsDone ?? 0) / j.stepsTotal) * 100) : null;
  const elapsed = useElapsed(j.startedAt ? j.startedAt : null);
  const fitFor = fit?.models.find((m) => m.spec.id === j.model)?.fit;
  const running = j.status === "running";
  const cancel = async () => {
    await fetch(`/api/video/jobs/${j.id}`, { method: "DELETE" });
    reload();
  };
  return (
    <article className="overflow-hidden rounded-xl border border-gray-800 bg-black/20">
      <div className="grid gap-0 sm:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <div className="relative aspect-video overflow-hidden bg-gray-950">
          {j.sourceImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={fileUrl(j.sourceImage)} alt="" className={`h-full w-full object-cover ${running ? "animate-[pulse_3s_ease-in-out_infinite]" : "opacity-60 grayscale-[40%]"}`} />
          ) : (
            <div className="h-full w-full bg-gradient-to-br from-gray-800 to-gray-950" />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-black/30" />
          <div className="absolute inset-0 grid place-items-center">{running ? <Dial pct={pct} /> : <span className="rounded-full bg-black/55 px-3 py-1 text-xs font-medium text-amber-200 backdrop-blur">{j.status === "waiting" ? "Waiting for room" : "Queued"}</span>}</div>
          <span className="absolute left-3 top-3 rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-white/90 backdrop-blur">{running ? "Rendering now" : j.status}</span>
          {j.origin && <span className="absolute right-3 top-3 rounded-full bg-black/55 px-2 py-0.5 text-[10px] text-white/80 backdrop-blur">{ORIGIN[j.origin] ?? j.origin}</span>}
        </div>
        <div className="flex min-w-0 flex-col gap-2 p-4">
          <p className="text-sm font-medium text-gray-100">{spec?.label ?? j.model}</p>
          <p className="line-clamp-3 text-xs leading-relaxed text-gray-400">{j.prompt}</p>
          <div className="mt-auto space-y-2">
            {running && pct != null && (
              <div className="h-1.5 overflow-hidden rounded-full bg-gray-800" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                <div className="h-full rounded-full bg-gradient-to-r from-orange-500 to-amber-300 transition-all duration-700" style={{ width: `${pct}%` }} />
              </div>
            )}
            <div className="flex flex-wrap gap-1.5 text-[11px]">
              <Chip>{j.seconds} s · {j.width}×{j.height}</Chip>
              {j.stepsTotal ? <Chip>step {j.stepsDone ?? 0}/{j.stepsTotal}</Chip> : null}
              {running && elapsed ? <Chip>{elapsed} in</Chip> : null}
              {j.etaSec != null ? <Chip strong>~{fmtDuration(j.etaSec)} {running ? "left" : "once it starts"}</Chip> : null}
            </div>
            {j.block && (
              <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 px-2.5 py-2">
                <p className="text-[11px] text-amber-200">{j.block.message}</p>
                {j.block.kind === "service-stopped" && j.block.serviceId ? (
                  <div className="mt-1.5">
                    <ServiceControl id={j.block.serviceId} up={false} probe={async () => (await fetch("/api/video/models").then((r) => r.json())).comfyUp} showLogs={false} />
                  </div>
                ) : j.block.kind === "capacity" && fitFor?.stop?.length ? (
                  <div className="mt-1.5 space-y-1">
                    <p className="text-[11px] text-gray-400">To make room, stop:</p>
                    <ReleaseButtons holders={fitFor.stop} onReleased={reload} />
                  </div>
                ) : j.block.kind === "slot" ? (
                  <p className="mt-1 text-[11px] text-gray-500">Another GPU job is running; this one starts when it finishes.</p>
                ) : null}
              </div>
            )}
            <button type="button" onClick={() => void cancel()} className="text-[11px] text-gray-500 hover:text-gray-200">
              Cancel
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}

function Chip({ children, strong }: { children: React.ReactNode; strong?: boolean }) {
  return <span className={`rounded-full border px-2 py-0.5 tabular-nums ${strong ? "border-orange-400/40 text-orange-200" : "border-gray-700 text-gray-400"}`}>{children}</span>;
}

/** A finished clip: it plays on hover, its first frame is the poster; a failed one shows why. */
function ClipCard({ job: j, onOpen, onRemove, compact }: { job: VideoJob; onOpen: () => void; onRemove: () => void; compact?: boolean }) {
  const spec = getVideoModel(j.model);
  const ref = useRef<HTMLVideoElement>(null);
  const ok = j.status === "done" && !!j.output;
  const poster = j.sourceImage ? fileUrl(j.sourceImage) : undefined;
  const ago = j.doneAt ? new Date(j.doneAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
  return (
    <article className="group relative overflow-hidden rounded-xl border border-gray-800 bg-black/20 transition hover:-translate-y-0.5 hover:border-gray-600 hover:shadow-[0_18px_40px_-20px_rgba(0,0,0,0.6)]">
      <button
        type="button"
        onClick={ok ? onOpen : undefined}
        onMouseEnter={() => void ref.current?.play().catch(() => undefined)}
        onMouseLeave={() => ref.current?.pause()}
        className={`relative block aspect-video w-full overflow-hidden bg-gray-950 text-left ${ok ? "cursor-pointer" : "cursor-default"}`}
        aria-label={ok ? `Open the clip: ${j.prompt}` : undefined}
      >
        {ok ? (
          <video ref={ref} src={fileUrl(j.output!)} poster={poster} muted loop playsInline preload="none" className="h-full w-full object-cover transition duration-500 group-hover:scale-[1.03]" />
        ) : poster ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={poster} alt="" className="h-full w-full object-cover opacity-50 grayscale" />
        ) : (
          <div className="h-full w-full bg-gradient-to-br from-gray-800 to-gray-950" />
        )}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/80 via-black/0 to-black/25" />
        <span
          className={`absolute left-2.5 top-2.5 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider backdrop-blur ${
            j.status === "done" ? "bg-emerald-500/25 text-emerald-100" : j.status === "failed" ? "bg-red-500/35 text-red-100" : "bg-black/50 text-white/70"
          }`}
        >
          {j.status === "done" ? "made" : j.status}
        </span>
        <span className="absolute right-2.5 top-2.5 rounded-full bg-black/50 px-2 py-0.5 text-[10px] tabular-nums text-white/85 backdrop-blur">
          {j.seconds} s{j.hasAudio ? " · ♪" : ""}
        </span>
        {ok && (
          <span className="pointer-events-none absolute inset-0 grid place-items-center opacity-0 transition group-hover:opacity-100">
            <span className="grid size-11 place-items-center rounded-full bg-white/85 text-black shadow-lg">▶</span>
          </span>
        )}
        <p className={`absolute inset-x-2.5 bottom-2 text-white/95 [text-shadow:0_1px_4px_rgba(0,0,0,0.7)] ${compact ? "line-clamp-1 text-[11px]" : "line-clamp-2 text-xs leading-snug"}`}>
          {j.status === "failed" && j.error ? j.error : j.prompt}
        </p>
      </button>
      <div className="flex items-center gap-2 px-3 py-2 text-[11px]">
        <span className="truncate text-gray-200">{spec?.label ?? j.model}</span>
        {j.latencyMs ? <span className="shrink-0 tabular-nums text-gray-500">· {(j.latencyMs / 1000).toFixed(0)} s</span> : null}
        {j.costUsd != null ? <span className="shrink-0 text-gray-500">· ${j.costUsd.toFixed(2)}</span> : null}
        <span className="ml-auto shrink-0 text-gray-600">{j.origin ? `${ORIGIN[j.origin] ?? j.origin} · ` : ""}{ago}</span>
        <button type="button" onClick={onRemove} className="shrink-0 text-gray-600 opacity-0 transition hover:text-gray-300 group-hover:opacity-100" title="Forget this clip (the file stays on disk)" aria-label="Forget this clip">
          ✕
        </button>
      </div>
    </article>
  );
}

/** One button per holder, plus one for all of them — "stop these two things". */
function ReleaseButtons({ holders, onReleased }: { holders: GpuHolder[]; onReleased: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const release = async (list: GpuHolder[], key: string) => {
    setBusy(key);
    setNote(null);
    try {
      for (const h of list) {
        const req = releaseRequest(h);
        const r = await fetch(req.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req.body) });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.error ?? `Could not free ${h.label}`);
        }
      }
      setNote(`Freed ${list.map((h) => h.label).join(" and ")}. The queue picks up as soon as the coordinator sees the room.`);
      onReleased();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-1.5">
        {holders.map((h) => {
          const req = releaseRequest(h);
          const cost = [h.vramGb ? `${h.vramGb} GB VRAM` : null, h.ramGb ? `${h.ramGb} GB RAM` : null].filter(Boolean).join(" · ");
          return (
            <button
              key={`${h.kind}:${h.id}`}
              type="button"
              disabled={busy !== null}
              onClick={() => void release([h], h.id)}
              title={req.title}
              className="rounded-md border border-amber-700/40 px-2 py-1 text-[11px] text-amber-300 hover:border-amber-600 hover:text-amber-200 disabled:opacity-40"
            >
              {busy === h.id ? "Freeing…" : `${req.verb} ${h.label}`}
              {cost && <span className="ml-1 text-amber-300/60">({cost})</span>}
            </button>
          );
        })}
        {holders.length > 1 && (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void release(holders, "all")}
            className="rounded-md border border-amber-600/60 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200 hover:border-amber-500 disabled:opacity-40"
          >
            {busy === "all" ? "Freeing…" : `Stop all ${holders.length}`}
          </button>
        )}
      </div>
      {note && <p className="text-[11px] text-gray-400">{note}</p>}
    </div>
  );
}

function useElapsed(since: string | null): string | null {
  const [, tick] = useState(0);
  const ref = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!since) return;
    ref.current = setInterval(() => tick((n) => n + 1), 1000);
    return () => {
      if (ref.current) clearInterval(ref.current);
    };
  }, [since]);
  if (!since) return null;
  return fmtDuration(Math.max(0, Math.round((Date.now() - new Date(since).getTime()) / 1000)));
}

function fmtDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m < 60 ? `${m}m ${String(s).padStart(2, "0")}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
