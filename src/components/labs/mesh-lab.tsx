"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import LabShell from "./lab-shell";
import MeshViewer, { type MeshStats } from "./mesh-viewer";
import { ServiceControl } from "@/components/service-control";
import CapacityBlocker from "@/components/capacity-blocker";
import { IMAGE_MODELS } from "@/lib/image-models";
import { DETAIL, lastNoun, resolutionFor, type Detail } from "@/lib/mesh3d-shared";
import type { LabComponentProps } from "@/lib/labs";
import type { LabModel, LabRunResult } from "@/lib/lab-types";
import type { MeshLabOutput } from "@/app/api/labs/3d/run/route";
import type { MeshJobSummary } from "@/app/api/labs/3d/jobs/route";

/**
 * The 3D Lab: object image → SAM 3 cutout → mesh → an interactive viewer.
 *
 * The first two steps are this Lab's input, and each is its own request so you
 * can see (and redo) the image and the cutout before spending GPU on a mesh.
 * The mesh step is the shell's Run, which is what makes it a Lab: the models are
 * whatever this host serves as "3d", with Start/Stop, latency, VRAM and the runs
 * record for free.
 *
 * An object is a job folder on disk, so it outlives the page: every mesh made
 * from it is listed under the steps, any two can be orbited side by side, and
 * the gallery reopens an earlier object to run another model on the same cutout.
 * "Under a second" and "the best mesh" are different products; this is where
 * you see which one an object needs.
 */

type Mesh = MeshJobSummary["meshes"][number];
type Job = Omit<MeshJobSummary, "cutoutUrl" | "cutoutNote"> & { cutoutUrl: string | null; cutoutNote: string | null };

export default function MeshLab({ lab }: LabComponentProps) {
  const [mode, setMode] = useState<"describe" | "upload">("describe");
  const [subject, setSubject] = useState("");
  const [imageModel, setImageModel] = useState<string>("z-image-turbo");
  const [seed, setSeed] = useState("");
  const [concept, setConcept] = useState("");
  const [conceptTouched, setConceptTouched] = useState(false);
  const [detail, setDetail] = useState<Detail>("draft");
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState<null | "source" | "cutout">(null);
  const [stepError, setStepError] = useState<{ message: string; blocked: boolean } | null>(null);
  const [sam3Up, setSam3Up] = useState<boolean | undefined>(undefined);
  const [gallery, setGallery] = useState<MeshJobSummary[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const seedNum = seed.trim() === "" ? null : Number(seed);
  const seedValid = seedNum === null || (Number.isInteger(seedNum) && seedNum >= 0);

  useEffect(() => {
    if (!conceptTouched) setConcept(subject.trim() ? lastNoun(subject) : "");
  }, [subject, conceptTouched]);

  const probeSam3 = useCallback(async () => {
    try {
      const h = await fetch("/api/sam3/health", { cache: "no-store" }).then((r) => r.json());
      const up = !!(h?.up && h?.ready !== false);
      setSam3Up(up);
      return up;
    } catch {
      setSam3Up(false);
      return false;
    }
  }, []);
  useEffect(() => {
    void probeSam3();
    const t = setInterval(() => void probeSam3(), 15_000);
    return () => clearInterval(t);
  }, [probeSam3]);

  const loadGallery = useCallback(async () => {
    try {
      const j = await fetch("/api/labs/3d/jobs?limit=24", { cache: "no-store" }).then((r) => r.json());
      setGallery(Array.isArray(j?.jobs) ? j.jobs : []);
    } catch {
      /* the gallery is history; the Lab works without it */
    }
  }, []);
  useEffect(() => {
    void loadGallery();
  }, [loadGallery]);

  const open = (j: MeshJobSummary) => {
    setJob(j);
    setSubject(j.subject);
    // Restore the noun it was actually cut with; guess only if it never was.
    if (j.concept) {
      setConcept(j.concept);
      setConceptTouched(true);
    } else {
      setConceptTouched(false);
    }
    setStepError(null);
  };

  const generate = async () => {
    setBusy("source");
    setStepError(null);
    try {
      const r = await fetch("/api/labs/3d/source", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject, imageModel, seed: seedNum }),
      });
      const j = await r.json();
      if (!r.ok) throw Object.assign(new Error(j.error ?? `HTTP ${r.status}`), { blocked: !!j.resourceBlocked });
      setJob({
        id: j.job,
        subject,
        sourceUrl: j.sourceUrl,
        sourceNote: `${j.model} · seed ${j.seed} · ${(j.latencyMs / 1000).toFixed(1)}s`,
        cutoutUrl: null,
        cutoutNote: null,
        concept: null,
        meshes: [],
      });
      void loadGallery();
    } catch (e) {
      setStepError(stepFailure(e));
    } finally {
      setBusy(null);
    }
  };

  const upload = async (file: File) => {
    setBusy("source");
    setStepError(null);
    try {
      const fd = new FormData();
      fd.append("image", file);
      fd.append("subject", subject || file.name.replace(/\.[^.]+$/, ""));
      const r = await fetch("/api/labs/3d/source", { method: "POST", body: fd });
      const j = await r.json();
      if (!r.ok) throw Object.assign(new Error(j.error ?? `HTTP ${r.status}`), { blocked: !!j.resourceBlocked });
      setJob({ id: j.job, subject: j.subject, sourceUrl: j.sourceUrl, sourceNote: `uploaded · ${file.name}`, cutoutUrl: null, cutoutNote: null, concept: null, meshes: [] });
      void loadGallery();
    } catch (e) {
      setStepError(stepFailure(e));
    } finally {
      setBusy(null);
    }
  };

  const cutout = async () => {
    if (!job) return;
    setBusy("cutout");
    setStepError(null);
    try {
      const r = await fetch("/api/labs/3d/cutout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job: job.id, concept }),
      });
      const j = await r.json();
      if (!r.ok) throw Object.assign(new Error(j.error ?? `HTTP ${r.status}`), { blocked: !!j.resourceBlocked });
      setJob({ ...job, concept: j.concept, cutoutUrl: `${j.cutoutUrl}&v=${Date.now()}`, cutoutNote: `SAM 3 · "${j.concept}" · score ${j.score.toFixed(2)} · ${(j.latencyMs / 1000).toFixed(1)}s` });
      void loadGallery();
    } catch (e) {
      setStepError(stepFailure(e));
    } finally {
      setBusy(null);
    }
  };

  const run = async (model: LabModel, { compareGroup, signal }: { compareGroup: string; signal: AbortSignal }) => {
    const jobId = job?.id;
    const resolution = resolutionFor(model.id, detail);
    const r = await fetch("/api/labs/3d/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ job: jobId, model: model.id, seed: seedNum, resolution, compareGroup: compareGroup || null }),
      signal,
    });
    const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    const result: LabRunResult<MeshLabOutput> = r.ok ? j : { ok: false, model: model.id, local: model.local, error: j.error ?? `HTTP ${r.status}` };
    if (result.ok && result.output) {
      const out = result.output;
      const mesh: Mesh = {
        file: out.glbPath.split(/[\\/]/).pop() ?? out.downloadName,
        url: out.glbUrl,
        model: model.id,
        resolution: out.resolution,
        seed: seedNum ?? 42,
        latencyMs: result.latencyMs ?? null,
        bytes: out.bytes,
      };
      setJob((cur) => (cur && cur.id === jobId ? { ...cur, meshes: [...cur.meshes.filter((m) => m.file !== mesh.file), mesh] } : cur));
      void loadGallery();
    }
    return result;
  };

  const inputCls = "rounded-md border border-gray-700 bg-gray-950 px-2 py-1.5 text-sm text-gray-100 outline-none placeholder:text-gray-600 focus:border-gray-500";
  const btnCls =
    "rounded-lg border border-gray-600 px-3 py-1.5 text-xs font-medium text-gray-100 transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-40";
  const segCls = (on: boolean) => `px-2.5 py-1 ${on ? "bg-gray-700 text-gray-100" : "text-gray-400 hover:bg-gray-800"}`;

  return (
    <LabShell<MeshLabOutput>
      lab={lab}
      canRun={!!job && seedValid}
      input={
        <div className="space-y-4">
          {/* ── 1. the object ── */}
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400">1 · Object image</h3>
              <div className="flex overflow-hidden rounded-md border border-gray-800 text-[11px]" role="tablist">
                {(["describe", "upload"] as const).map((m) => (
                  <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => setMode(m)} className={segCls(mode === m)}>
                    {m === "describe" ? "Describe it" : "Upload"}
                  </button>
                ))}
              </div>
            </div>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="What is it? e.g. a cordless power drill, a gnarled tree stump, a cartoon fox explorer"
              aria-label="Object"
              className={`${inputCls} w-full`}
            />
            {mode === "describe" ? (
              <div className="flex flex-wrap items-center gap-3 text-xs text-gray-400">
                <label className="flex items-center gap-2">
                  Image model
                  <select value={imageModel} onChange={(e) => setImageModel(e.target.value)} className={inputCls} aria-label="Image model">
                    {IMAGE_MODELS.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-2">
                  Seed
                  <input
                    value={seed}
                    onChange={(e) => setSeed(e.target.value)}
                    inputMode="numeric"
                    placeholder="random"
                    aria-label="Seed"
                    className={`${inputCls} w-24 ${seedValid ? "" : "border-red-500"}`}
                  />
                </label>
                <button type="button" onClick={generate} disabled={!subject.trim() || !!busy || !seedValid} className={btnCls}>
                  {busy === "source" ? "Generating…" : "Generate image"}
                </button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-3 text-xs text-gray-400">
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void upload(f);
                    e.target.value = "";
                  }}
                />
                <button type="button" onClick={() => fileRef.current?.click()} disabled={!!busy} className={btnCls}>
                  {busy === "source" ? "Uploading…" : "Choose an image"}
                </button>
                <span>One object, whole, on a plain background works best. A PNG with transparency can skip the cutout.</span>
              </div>
            )}
          </div>

          {/* ── 2. cutout ── */}
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400">2 · Cut it out</h3>
            <input
              value={concept}
              onChange={(e) => {
                setConcept(e.target.value);
                setConceptTouched(true);
              }}
              placeholder="noun to segment"
              aria-label="Concept to segment"
              className={`${inputCls} w-40`}
            />
            <button type="button" onClick={cutout} disabled={!job || !concept.trim() || !!busy || sam3Up === false} className={btnCls}>
              {busy === "cutout" ? "Segmenting…" : "Cut out with SAM 3"}
            </button>
            {sam3Up === false && (
              <span className="flex items-center gap-2 text-[11px] text-amber-300">
                SAM 3 is not running.
                <ServiceControl id="sam3" up={false} probe={probeSam3} showLogs={false} />
              </span>
            )}
            <span className="text-[11px] text-gray-500">Optional — without it, the mesh model mattes the image itself.</span>
          </div>

          {stepError &&
            (stepError.blocked ? (
              // A capacity refusal is a remedy, not a bug: the image model, SAM 3 and
              // the mesh models rarely all fit beside what else the card holds.
              <CapacityBlocker message={stepError.message} onReleased={() => setStepError(null)} />
            ) : (
              <p className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-300">{stepError.message}</p>
            ))}

          {job && (
            <div className="flex flex-wrap gap-4">
              <figure className="w-40">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={job.sourceUrl} alt="Source image" className="aspect-square w-full rounded-lg border border-gray-800 object-cover" />
                <figcaption className="mt-1 text-[10px] text-gray-500">{job.sourceNote}</figcaption>
              </figure>
              {job.cutoutUrl && (
                <figure className="w-40">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={job.cutoutUrl}
                    alt="SAM 3 cutout"
                    data-testid="cutout"
                    className="aspect-square w-full rounded-lg border border-gray-800 object-contain"
                    style={{ backgroundImage: "repeating-conic-gradient(#1f2937 0 25%, #111827 0 50%)", backgroundSize: "16px 16px" }}
                  />
                  <figcaption className="mt-1 text-[10px] text-gray-500">{job.cutoutNote}</figcaption>
                </figure>
              )}
            </div>
          )}

          {/* ── 3. mesh settings (Run is below) ── */}
          <div className="flex flex-wrap items-center gap-3 text-xs text-gray-400">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400">3 · Mesh</h3>
            <div className="flex overflow-hidden rounded-md border border-gray-800 text-[11px]" role="radiogroup" aria-label="Detail">
              {DETAIL.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  role="radio"
                  aria-checked={detail === d.id}
                  title={`TRELLIS.2 at ${d.trellis} · Pixal3D at ${Math.max(1024, d.trellis)} (it has no 512 texture model) · TripoSR on a ${d.triposr}³ grid`}
                  onClick={() => setDetail(d.id)}
                  className={segCls(detail === d.id)}
                >
                  {d.label}
                </button>
              ))}
            </div>
            <span className="text-[11px] text-gray-500">
              {job
                ? `Meshes ${job.cutoutUrl ? "the cutout" : "the image as-is"}. TRELLIS.2 takes ~30–140 s at Draft and 1.5–14 min at Standard on this box; TripoSR ~2 s at Draft.`
                : "Make or reopen an object first."}
            </span>
          </div>

          {job && job.meshes.length > 0 && <Comparison key={job.id} meshes={job.meshes} />}

          {gallery.length > 0 && <Gallery jobs={gallery} current={job?.id ?? null} onOpen={open} />}
        </div>
      }
      run={run}
      renderOutput={(r) => (r.output ? <MeshOutput out={r.output} /> : null)}
    />
  );
}

function stepFailure(e: unknown): { message: string; blocked: boolean } {
  return {
    message: e instanceof Error ? e.message : String(e),
    blocked: !!(e as { blocked?: boolean } | null)?.blocked,
  };
}

function MeshOutput({ out }: { out: MeshLabOutput }) {
  const [stats, setStats] = useState<MeshStats | null>(null);
  return (
    <div className="space-y-3">
      <MeshViewer url={out.glbUrl} downloadName={out.downloadName} onStats={setStats} />
      <dl className="grid grid-cols-3 gap-x-4 gap-y-1 text-[11px]">
        {out.steps.map((s) => (
          <div key={s.name}>
            <dt className="text-gray-600">{s.name}</dt>
            <dd className="tabular-nums text-gray-300" title={s.detail}>
              {s.ms != null ? `${(s.ms / 1000).toFixed(s.ms < 10_000 ? 2 : 1)}s` : "—"}
            </dd>
          </div>
        ))}
      </dl>
      <p className="text-[10px] text-gray-600">
        {out.resolution != null && `resolution ${out.resolution} · `}
        {(out.bytes / 1024 / 1024).toFixed(1)} MB GLB
        {out.reportedPeakVramMb != null && ` · service-reported torch peak ${(out.reportedPeakVramMb / 1024).toFixed(1)} GB`}
        {stats && stats.textureSize == null && !stats.vertexColors && " · untextured"}
      </p>
    </div>
  );
}

const meshLabel = (m: Mesh) =>
  `${m.model}${m.resolution != null ? ` @${m.resolution}` : ""}${m.latencyMs != null ? ` · ${m.latencyMs < 10_000 ? (m.latencyMs / 1000).toFixed(1) : Math.round(m.latencyMs / 1000)}s` : ""}`;

/** Every mesh of this object; any two orbit side by side. */
function Comparison({ meshes }: { meshes: Mesh[] }) {
  const [picked, setPicked] = useState<string[]>(() => meshes.slice(-2).map((m) => m.file));
  // A newly made mesh joins the comparison, replacing the older of the two.
  const last = meshes[meshes.length - 1]?.file;
  useEffect(() => {
    if (last) setPicked((p) => (p.includes(last) ? p : [...p, last].slice(-2)));
  }, [last]);
  const toggle = (file: string) =>
    setPicked((p) => (p.includes(file) ? p.filter((f) => f !== file) : [...p, file].slice(-2)));
  const shown = picked.map((f) => meshes.find((m) => m.file === f)).filter((m): m is Mesh => !!m);
  return (
    <div className="space-y-2 rounded-lg border border-gray-800 p-3" data-testid="mesh-comparison">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="mr-1 text-xs font-semibold uppercase tracking-wider text-gray-400">This object&apos;s meshes</h3>
        {meshes.map((m) => (
          <button
            key={m.file}
            type="button"
            aria-pressed={picked.includes(m.file)}
            onClick={() => toggle(m.file)}
            className={`rounded-full border px-2 py-0.5 text-[11px] ${picked.includes(m.file) ? "border-emerald-600 bg-emerald-900/30 text-emerald-200" : "border-gray-700 text-gray-400 hover:bg-gray-800"}`}
          >
            {meshLabel(m)}
          </button>
        ))}
        <span className="text-[10px] text-gray-500">pick up to two</span>
      </div>
      {shown.length > 0 && (
        <div className={`grid gap-4 ${shown.length > 1 ? "md:grid-cols-2" : ""}`}>
          {shown.map((m) => (
            <div key={m.file} className="min-w-0">
              <p className="mb-1 text-xs text-gray-300">{meshLabel(m)}</p>
              <MeshViewer url={m.url} downloadName={m.file} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Gallery({ jobs, current, onOpen }: { jobs: MeshJobSummary[]; current: string | null; onOpen: (j: MeshJobSummary) => void }) {
  return (
    <details className="rounded-lg border border-gray-800 p-3" open={!current}>
      <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-gray-400">Earlier objects ({jobs.length})</summary>
      <div className="mt-3 grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6">
        {jobs.map((j) => (
          <button
            key={j.id}
            type="button"
            onClick={() => onOpen(j)}
            title={j.subject}
            className={`group min-w-0 rounded-lg border p-1.5 text-left transition hover:border-gray-500 ${j.id === current ? "border-emerald-600" : "border-gray-800"}`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={j.cutoutUrl ?? j.sourceUrl}
              alt=""
              loading="lazy"
              className="aspect-square w-full rounded object-contain"
              style={{ backgroundImage: "repeating-conic-gradient(#1f2937 0 25%, #111827 0 50%)", backgroundSize: "12px 12px" }}
            />
            <span className="mt-1 block truncate text-[11px] text-gray-300">{j.subject}</span>
            <span className="block text-[10px] text-gray-500">
              {j.meshes.length ? `${j.meshes.length} mesh${j.meshes.length > 1 ? "es" : ""}` : "no mesh yet"}
            </span>
          </button>
        ))}
      </div>
    </details>
  );
}
