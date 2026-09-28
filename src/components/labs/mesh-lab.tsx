"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, PersonStanding } from "lucide-react";
import LabShell from "./lab-shell";
import MeshViewer, { type MeshStats } from "./mesh-viewer";
import { ServiceControl } from "@/components/service-control";
import CapacityBlocker from "@/components/capacity-blocker";
import { IMAGE_MODELS } from "@/lib/image-models";
import { DETAIL, SUBJECT_STORAGE_KEY, capabilityFor, lastNoun, resolutionFor, type Detail, type Subject3d } from "@/lib/mesh3d-shared";
import type { LabComponentProps } from "@/lib/labs";
import type { LabModel, LabRunResult } from "@/lib/lab-types";
import type { MeshLabOutput } from "@/app/api/labs/3d/run/route";
import type { BodyLabOutput } from "@/app/api/labs/3d/body/run/route";
import type { MeshJobSummary } from "@/app/api/labs/3d/jobs/route";

/**
 * The 3D Lab: a picture → 3D, for two kinds of subject.
 *
 * - An OBJECT: image → SAM 3 cutout → a textured mesh (TRELLIS.2, Pixal3D,
 *   TripoSR — whatever this host serves as "3d").
 * - A PERSON: photo → (optionally pick one person with SAM 3) → SAM 3D Body's
 *   body mesh and 70-joint pose (whatever serves "3d-body"). This used to be a
 *   separate "3D Body" tab with its own upload box and viewer; it is the same
 *   job — one picture in, a thing to orbit and download out — so it lives here.
 *
 * The Object / Person choice sits above the model list because it decides which
 * capability the shell lists models for. Everything else — Start/Stop,
 * latency, VRAM, the runs record, the gallery, the viewer — is shared.
 */

type Mesh = MeshJobSummary["meshes"][number];
type Job = Omit<MeshJobSummary, "cutoutUrl" | "cutoutNote"> & { cutoutUrl: string | null; cutoutNote: string | null };
type Output = MeshLabOutput | BodyLabOutput;

const SUBJECT_KEY = SUBJECT_STORAGE_KEY;

function readSubject(): Subject3d {
  try {
    return window.localStorage.getItem(SUBJECT_KEY) === "person" ? "person" : "object";
  } catch {
    return "object";
  }
}

const COPY = {
  object: {
    step1: "1 · Object image",
    placeholder: "What is it? e.g. a cordless power drill, a gnarled tree stump, a cartoon fox explorer",
    uploadHint: "One object, whole, on a plain background works best. A PNG with transparency can skip the cutout.",
    step2: "2 · Cut it out",
    step2Button: "Cut out with SAM 3",
    step2Hint: "Optional — without it, the mesh model mattes the image itself.",
    meshes: "This object's meshes",
    empty: "Make or reopen an object first.",
  },
  person: {
    step1: "1 · Photo of a person",
    placeholder: "Who? e.g. a dancer mid-leap, a runner in the starting blocks, a child waving",
    uploadHint: "One person, the whole body in frame — head to feet, not cut off at the knees.",
    step2: "2 · Pick the person",
    step2Button: "Pick with SAM 3",
    step2Hint: "Only needed when there are several people: the cutout's box tells SAM 3D Body which one. Otherwise it takes the most prominent person.",
    meshes: "This person's bodies",
    empty: "Add or reopen a photo of a person first.",
  },
} as const;

export default function MeshLab({ lab }: LabComponentProps) {
  const [subject3d, setSubject3d] = useState<Subject3d>("object");
  const [srcMode, setSrcMode] = useState<"describe" | "upload">("describe");
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
  const [dragging, setDragging] = useState(false);
  // The mesh the last Run made; it already has a full viewer under the form.
  const [fresh, setFresh] = useState<{ job: string; file: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const person = subject3d === "person";
  const copy = COPY[subject3d];
  const seedNum = seed.trim() === "" ? null : Number(seed);
  const seedValid = seedNum === null || (Number.isInteger(seedNum) && seedNum >= 0);

  // The last mode used (or the one an old #sam3d link asked for) — per viewer.
  useEffect(() => {
    const s = readSubject();
    setSubject3d(s);
    if (s === "person") setSrcMode("upload");
  }, []);

  const choose = (s: Subject3d) => {
    if (s === subject3d) return;
    setSubject3d(s);
    try {
      window.localStorage.setItem(SUBJECT_KEY, s);
    } catch {
      /* a convenience only */
    }
    setSrcMode(s === "person" ? "upload" : "describe");
    // A fox's description is no prompt for a person, and the other way round.
    setSubject("");
    setJob(null);
    setStepError(null);
    setConceptTouched(false);
  };

  useEffect(() => {
    if (conceptTouched) return;
    setConcept(person ? "person" : subject.trim() ? lastNoun(subject) : "");
  }, [subject, conceptTouched, person]);

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
    // Quick while it is down, so a start made elsewhere (Services, another
    // Lab) enables Pick within seconds; relaxed once it is up.
    const t = setInterval(() => void probeSam3(), sam3Up ? 15_000 : 5_000);
    return () => clearInterval(t);
  }, [probeSam3, sam3Up]);

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
    if (j.kind !== subject3d) {
      setSubject3d(j.kind);
      try {
        window.localStorage.setItem(SUBJECT_KEY, j.kind);
      } catch {
        /* a convenience only */
      }
    }
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

  const newJob = (id: string, subjectText: string, sourceUrl: string, sourceNote: string): Job => ({
    id,
    subject: subjectText,
    sourceUrl,
    sourceNote,
    cutoutUrl: null,
    cutoutNote: null,
    concept: null,
    kind: subject3d,
    meshes: [],
  });

  const generate = async () => {
    setBusy("source");
    setStepError(null);
    try {
      const r = await fetch("/api/labs/3d/source", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject, kind: subject3d, imageModel, seed: seedNum }),
      });
      const j = await r.json();
      if (!r.ok) throw Object.assign(new Error(j.error ?? `HTTP ${r.status}`), { blocked: !!j.resourceBlocked });
      setJob(newJob(j.job, subject, j.sourceUrl, `${j.model} · seed ${j.seed} · ${(j.latencyMs / 1000).toFixed(1)}s`));
      void loadGallery();
    } catch (e) {
      setStepError(stepFailure(e));
    } finally {
      setBusy(null);
    }
  };

  const upload = async (file: File) => {
    if (!file.type.startsWith("image/")) {
      setStepError({ message: `${file.name} is not an image.`, blocked: false });
      return;
    }
    setBusy("source");
    setStepError(null);
    try {
      const fd = new FormData();
      fd.append("image", file);
      fd.append("kind", subject3d);
      fd.append("subject", subject || file.name.replace(/\.[^.]+$/, ""));
      const r = await fetch("/api/labs/3d/source", { method: "POST", body: fd });
      const j = await r.json();
      if (!r.ok) throw Object.assign(new Error(j.error ?? `HTTP ${r.status}`), { blocked: !!j.resourceBlocked });
      setJob(newJob(j.job, j.subject, j.sourceUrl, `uploaded · ${file.name}`));
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

  const run = async (model: LabModel, { compareGroup, signal }: { compareGroup: string; signal: AbortSignal }): Promise<LabRunResult<Output>> => {
    const jobId = job?.id;
    const r = await fetch(person ? "/api/labs/3d/body/run" : "/api/labs/3d/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        person
          ? { job: jobId, model: model.id, compareGroup: compareGroup || null }
          : { job: jobId, model: model.id, seed: seedNum, resolution: resolutionFor(model.id, detail), compareGroup: compareGroup || null },
      ),
      signal,
    });
    const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    const result: LabRunResult<Output> = r.ok ? j : { ok: false, model: model.id, local: model.local, error: j.error ?? `HTTP ${r.status}` };
    if (result.ok && result.output) {
      const out = result.output;
      const mesh: Mesh = {
        file: out.glbPath.split(/[\\/]/).pop() ?? out.downloadName,
        url: out.glbUrl,
        model: model.id,
        resolution: "resolution" in out ? out.resolution : null,
        seed: "joints" in out ? null : (seedNum ?? 42),
        latencyMs: result.latencyMs ?? null,
        bytes: out.bytes,
        poseUrl: "poseUrl" in out ? out.poseUrl : null,
      };
      setJob((cur) => (cur && cur.id === jobId ? { ...cur, meshes: [...cur.meshes.filter((m) => m.file !== mesh.file), mesh] } : cur));
      if (jobId) setFresh({ job: jobId, file: mesh.file });
      void loadGallery();
    }
    return result;
  };

  const shellLab = useMemo(() => ({ ...lab, capability: capabilityFor(subject3d) }), [lab, subject3d]);

  const inputCls = "rounded-md border border-gray-700 bg-gray-950 px-2 py-1.5 text-sm text-gray-100 outline-none placeholder:text-gray-600 focus:border-gray-500";
  const btnCls =
    "rounded-lg border border-gray-600 px-3 py-1.5 text-xs font-medium text-gray-100 transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-40";
  const segCls = (on: boolean) => `px-2.5 py-1 ${on ? "bg-gray-700 text-gray-100" : "text-gray-400 hover:bg-gray-800"}`;

  const toolbar = (
    <section className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="What to turn into 3D">
      {(
        [
          { id: "object", icon: Box, title: "An object", body: "A textured mesh from one picture: props, products, characters. TRELLIS.2, Pixal3D or TripoSR." },
          { id: "person", icon: PersonStanding, title: "A person", body: "A body shape and its 3D pose from one photo — 70 joints and a mesh. SAM 3D Body." },
        ] as const
      ).map((o) => {
        const on = subject3d === o.id;
        const Icon = o.icon;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => choose(o.id)}
            className={`flex items-start gap-3 rounded-xl border p-3 text-left transition ${on ? "border-orange-500/70 bg-orange-500/[0.07]" : "border-gray-800 bg-gray-900/40 hover:border-gray-600"}`}
          >
            <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${on ? "text-orange-300" : "text-gray-500"}`} />
            <span>
              <span className={`block text-sm font-medium ${on ? "text-gray-100" : "text-gray-300"}`}>{o.title}</span>
              <span className="block text-[11px] text-gray-500">{o.body}</span>
            </span>
          </button>
        );
      })}
    </section>
  );

  return (
    <LabShell<Output>
      key={subject3d}
      lab={shellLab}
      toolbar={toolbar}
      canRun={!!job && (person || seedValid)}
      input={
        <div className="space-y-4">
          {/* ── 1. the picture ── */}
          <div
            className={`space-y-2 rounded-lg ${dragging ? "outline outline-2 outline-dashed outline-orange-500/60 outline-offset-4" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const f = e.dataTransfer.files?.[0];
              if (f) void upload(f);
            }}
          >
            <div className="flex items-center gap-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400">{copy.step1}</h3>
              <div className="flex overflow-hidden rounded-md border border-gray-800 text-[11px]" role="tablist">
                {(["upload", "describe"] as const).map((m) => (
                  <button key={m} type="button" role="tab" aria-selected={srcMode === m} onClick={() => setSrcMode(m)} className={segCls(srcMode === m)}>
                    {m === "describe" ? "Describe it" : "Upload"}
                  </button>
                ))}
              </div>
            </div>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder={srcMode === "upload" ? (person ? "What's in the photo? (optional — just a label)" : "What is it? (optional — a label, and the noun to cut out)") : copy.placeholder}
              aria-label="Object"
              className={`${inputCls} w-full`}
            />
            {srcMode === "describe" ? (
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
                  {busy === "source" ? "Generating…" : person ? "Generate photo" : "Generate image"}
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={!!busy}
                className="flex w-full flex-col items-center gap-1 rounded-lg border-2 border-dashed border-gray-700 px-4 py-5 text-center text-xs text-gray-400 transition hover:border-gray-500 disabled:opacity-50"
              >
                <span className="text-sm text-gray-200">{busy === "source" ? "Uploading…" : "Drop a photo here, or click to choose one"}</span>
                <span className="text-[11px] text-gray-500">{copy.uploadHint}</span>
              </button>
            )}
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
          </div>

          {/* ── 2. cutout / pick the person ── */}
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400">{copy.step2}</h3>
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
              {busy === "cutout" ? "Segmenting…" : copy.step2Button}
            </button>
            {sam3Up === false && (
              <span className="flex items-center gap-2 text-[11px] text-amber-300">
                SAM 3 is not running.
                <ServiceControl id="sam3" up={false} probe={probeSam3} showLogs={false} />
              </span>
            )}
            <span className="text-[11px] text-gray-500">{copy.step2Hint}</span>
          </div>

          {stepError &&
            (stepError.blocked ? (
              // A capacity refusal is a remedy, not a bug: the image model, SAM 3 and
              // the 3D models rarely all fit beside what else the card holds.
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

          {/* ── 3. what the Run does ── */}
          {person ? (
            <div className="flex flex-wrap items-center gap-3 text-xs text-gray-400">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400">3 · Body and pose</h3>
              <span className="text-[11px] text-gray-500">
                {job
                  ? `Reconstructs ${job.cutoutUrl ? "the picked person" : "the most prominent person"}: a body mesh and 70 3D joints, in seconds once the model is loaded. It recovers body shape and pose — not clothes or hair.`
                  : copy.empty}
              </span>
            </div>
          ) : (
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
                  : copy.empty}
              </span>
            </div>
          )}

          {/* Only once there is something besides the result already shown below. */}
          {job && job.meshes.some((m) => fresh?.job !== job.id || fresh.file !== m.file) && (
            <Comparison key={job.id} meshes={job.meshes} title={copy.meshes} />
          )}

          {gallery.length > 0 && <Gallery jobs={gallery} current={job?.id ?? null} onOpen={open} />}
        </div>
      }
      run={run}
      renderOutput={(r) => (!r.output ? null : "joints" in r.output ? <BodyOutput out={r.output} /> : <MeshOutput out={r.output} />)}
    />
  );
}

function stepFailure(e: unknown): { message: string; blocked: boolean } {
  return {
    message: e instanceof Error ? e.message : String(e),
    blocked: !!(e as { blocked?: boolean } | null)?.blocked,
  };
}

function Steps({ steps }: { steps: { name: string; ms: number | null; detail?: string }[] }) {
  return (
    <dl className="grid grid-cols-3 gap-x-4 gap-y-1 text-[11px]">
      {steps.map((s) => (
        <div key={s.name}>
          <dt className="text-gray-600">{s.name}</dt>
          <dd className="tabular-nums text-gray-300" title={s.detail}>
            {s.ms != null ? `${(s.ms / 1000).toFixed(s.ms < 10_000 ? 2 : 1)}s` : "—"}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function MeshOutput({ out }: { out: MeshLabOutput }) {
  const [stats, setStats] = useState<MeshStats | null>(null);
  return (
    <div className="space-y-3">
      <MeshViewer url={out.glbUrl} downloadName={out.downloadName} onStats={setStats} />
      <Steps steps={out.steps} />
      <p className="text-[10px] text-gray-600">
        {out.resolution != null && `resolution ${out.resolution} · `}
        {(out.bytes / 1024 / 1024).toFixed(1)} MB GLB
        {out.reportedPeakVramMb != null && ` · service-reported torch peak ${(out.reportedPeakVramMb / 1024).toFixed(1)} GB`}
        {stats && stats.textureSize == null && !stats.vertexColors && " · untextured"}
      </p>
    </div>
  );
}

function BodyOutput({ out }: { out: BodyLabOutput }) {
  return (
    <div className="space-y-3">
      <div className="grid gap-4 md:grid-cols-[3fr_2fr]">
        <MeshViewer url={out.glbUrl} downloadName={out.downloadName} />
        <div className="space-y-2">
          <PoseOverlay photoUrl={out.photoUrl} overlay={out.overlay} box={out.box} />
          <p className="text-[11px] text-gray-400">
            {out.joints} 3D joints · {out.vertices.toLocaleString()} vertices · {out.faces.toLocaleString()} faces
          </p>
          <a
            href={out.poseUrl}
            download={out.downloadName.replace(/\.glb$/, "-pose.json")}
            className="inline-flex items-center gap-1 rounded-md border border-gray-700 px-2 py-1 text-[11px] text-gray-300 hover:bg-gray-800"
            title="The 70 3D joints (MHR-70), global rotation, and the 33 MediaPipe landmarks"
          >
            Download pose (JSON)
          </a>
        </div>
      </div>
      <Steps steps={out.steps} />
    </div>
  );
}

// MediaPipe Pose 33-landmark skeleton — what SAM 3D Body's joints are mapped onto.
const POSE_CONNECTIONS: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 7], [0, 4], [4, 5], [5, 6], [6, 8], [9, 10],
  [11, 12], [11, 13], [13, 15], [15, 17], [15, 19], [15, 21], [17, 19],
  [12, 14], [14, 16], [16, 18], [16, 20], [16, 22], [18, 20],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [27, 29], [27, 31], [29, 31],
  [24, 26], [26, 28], [28, 30], [28, 32], [30, 32],
];

/** The photo with the detected skeleton — and the pick box, if one chose the person — drawn on it. */
function PoseOverlay({ photoUrl, overlay, box }: { photoUrl: string; overlay: BodyLabOutput["overlay"]; box: BodyLabOutput["box"] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 480 / img.naturalWidth);
      const w = Math.round(img.naturalWidth * scale);
      const h = Math.round(img.naturalHeight * scale);
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, w, h);
      if (box) {
        ctx.strokeStyle = "rgba(251,146,60,0.9)";
        ctx.setLineDash([6, 4]);
        ctx.lineWidth = 2;
        ctx.strokeRect(box[0] * w, box[1] * h, (box[2] - box[0]) * w, (box[3] - box[1]) * h);
        ctx.setLineDash([]);
      }
      const pts = overlay?.points;
      if (!pts) return;
      ctx.lineWidth = Math.max(2, w / 200);
      ctx.strokeStyle = "rgba(52,211,153,0.95)";
      for (const [a, b] of POSE_CONNECTIONS) {
        const pa = pts[a], pb = pts[b];
        if (!pa || !pb || pa[2] < 0.3 || pb[2] < 0.3) continue;
        ctx.beginPath();
        ctx.moveTo(pa[0] * w, pa[1] * h);
        ctx.lineTo(pb[0] * w, pb[1] * h);
        ctx.stroke();
      }
      ctx.fillStyle = "#f43f5e";
      for (const p of pts) {
        if (!p || p[2] < 0.3) continue;
        ctx.beginPath();
        ctx.arc(p[0] * w, p[1] * h, Math.max(3, w / 140), 0, Math.PI * 2);
        ctx.fill();
      }
    };
    img.src = photoUrl;
  }, [photoUrl, overlay, box]);
  return <canvas ref={ref} data-testid="pose-overlay" className="w-full rounded-lg border border-gray-800 bg-black" />;
}

// A body is either of the whole photo's most prominent person or of the one SAM 3 picked.
const bodyOf = (m: Mesh) => (m.poseUrl ? (m.file.endsWith("-picked.glb") ? " · picked person" : " · whole photo") : "");
const meshLabel = (m: Mesh) =>
  `${m.model}${bodyOf(m)}${m.resolution != null ? ` @${m.resolution}` : ""}${m.latencyMs != null ? ` · ${m.latencyMs < 10_000 ? (m.latencyMs / 1000).toFixed(1) : Math.round(m.latencyMs / 1000)}s` : ""}`;

/** Every mesh of this object (or body of this person); any two orbit side by side. */
function Comparison({ meshes, title }: { meshes: Mesh[]; title: string }) {
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
        <h3 className="mr-1 text-xs font-semibold uppercase tracking-wider text-gray-400">{title}</h3>
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
        {meshes.length > 1 && <span className="text-[10px] text-gray-500">pick up to two</span>}
      </div>
      {shown.length > 0 && (
        <div className={`grid gap-4 ${shown.length > 1 ? "md:grid-cols-2" : ""}`}>
          {shown.map((m) => (
            <div key={m.file} className="min-w-0">
              <p className="mb-1 flex items-center gap-2 text-xs text-gray-300">
                {meshLabel(m)}
                {m.poseUrl && (
                  <a href={m.poseUrl} download className="text-[10px] text-gray-500 underline hover:text-gray-300">
                    pose JSON
                  </a>
                )}
              </p>
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
      <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-gray-400">Earlier objects and people ({jobs.length})</summary>
      <div className="mt-3 grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6">
        {jobs.map((j) => (
          <button
            key={j.id}
            type="button"
            onClick={() => onOpen(j)}
            title={j.subject}
            className={`group relative min-w-0 rounded-lg border p-1.5 text-left transition hover:border-gray-500 ${j.id === current ? "border-emerald-600" : "border-gray-800"}`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={j.cutoutUrl ?? j.sourceUrl}
              alt=""
              loading="lazy"
              className="aspect-square w-full rounded object-contain"
              style={{ backgroundImage: "repeating-conic-gradient(#1f2937 0 25%, #111827 0 50%)", backgroundSize: "12px 12px" }}
            />
            {j.kind === "person" && (
              <span className="absolute left-2.5 top-2.5 rounded bg-gray-950/80 px-1 py-0.5 text-[9px] uppercase tracking-wide text-orange-200">person</span>
            )}
            <span className="mt-1 block truncate text-[11px] text-gray-300">{j.subject}</span>
            <span className="block text-[10px] text-gray-500">
              {j.meshes.length
                ? `${j.meshes.length} ${j.kind === "person" ? "bod" + (j.meshes.length > 1 ? "ies" : "y") : "mesh" + (j.meshes.length > 1 ? "es" : "")}`
                : j.kind === "person"
                  ? "no body yet"
                  : "no mesh yet"}
            </span>
          </button>
        ))}
      </div>
    </details>
  );
}
