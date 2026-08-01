"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { ServiceControls, ServiceStartupNote, useServiceLifecycle } from "./service-control";

type Health = {
  up: boolean;
  latency: number;
  ready?: boolean;
  device?: string;
  dtype?: string;
  model?: string;
  vram?: { used_gb: number; total_gb: number };
  error?: string;
};

type Instance = {
  id: number;
  concept: string;
  score: number;
  box: [number, number, number, number];
};

type SegResult = {
  ok: boolean;
  error?: string;
  width?: number;
  height?: number;
  prompt?: string[];
  count?: number;
  count_total?: number;
  instances?: Instance[];
  overlay_png?: string;
  latency_ms?: number;
};

type TrackedObject = { id: number; concept: string; frames: number; best_score: number };

type VideoResult = {
  ok: boolean;
  error?: string;
  width?: number;
  height?: number;
  frames?: number;
  source_fps?: number;
  out_fps?: number;
  prompt?: string[];
  object_count?: number;
  objects?: TrackedObject[];
  video_mp4?: string;
  latency_ms?: number;
};

// Concept colours — mirror the server palette (server.py _PALETTE) so the chips
// here match the mask/box colours drawn into the overlay.
const PALETTE = [
  "99,102,241", "244,63,94", "34,197,94", "245,158,11", "14,165,233",
  "168,85,247", "236,72,153", "16,185,129", "249,115,22", "59,130,246",
];
const QUICK = ["person", "face", "car", "dog", "tree", "building"];

// Video overlay colours are keyed by object id (server: _id_color = PALETTE[id % n]).
const idColor = (id: number) => PALETTE[((id % PALETTE.length) + PALETTE.length) % PALETTE.length];

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-gray-600">{k}</dt>
      <dd className="text-gray-300 text-right break-all">{v}</dd>
    </div>
  );
}

export default function Sam3View() {
  const [health, setHealth] = useState<Health | null>(null);
  const [mode, setMode] = useState<"image" | "video">("image");
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [concepts, setConcepts] = useState("person");
  const [minScore, setMinScore] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SegResult | null>(null);
  const [vid, setVid] = useState<VideoResult | null>(null);
  const [isolate, setIsolate] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Returns the fresh verdict as well as storing it: the lifecycle hook polls this
  // after a Start to know when the service has actually come up.
  const checkHealth = useCallback(async (): Promise<boolean> => {
    try {
      const h: Health = await fetch("/api/sam3/health").then((r) => r.json());
      setHealth(h);
      return !!h.up;
    } catch {
      setHealth({ up: false, latency: 0, error: "unreachable" });
      return false;
    }
  }, []);
  useEffect(() => {
    checkHealth();
    const t = setInterval(checkHealth, 15000);
    return () => clearInterval(t);
  }, [checkHealth]);

  const lifecycle = useServiceLifecycle("sam3", health?.up, checkHealth);

  function reset() {
    setResult(null);
    setVid(null);
    setError(null);
    setIsolate(null);
  }

  function switchMode(m: "image" | "video") {
    if (m === mode) return;
    setMode(m);
    setFile(null);
    setFileUrl(null);
    reset();
  }

  function pickFile(f: File) {
    const wantVideo = mode === "video";
    if (wantVideo ? !f.type.startsWith("video/") : !f.type.startsWith("image/")) return;
    setFile(f);
    reset();
    setFileUrl(URL.createObjectURL(f));
  }

  const promptList = concepts.split(",").map((c) => c.trim()).filter(Boolean);
  const ready = !!(health?.up && health?.ready);

  async function segment() {
    if (!file || busy || !promptList.length) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const fd = new FormData();
      fd.append("image", file);
      fd.append("concepts", promptList.join(", "));
      fd.append("min_score", String(minScore));
      fd.append("overlay", "true");
      const data: SegResult = await fetch("/api/sam3/segment", { method: "POST", body: fd }).then((r) => r.json());
      if (data.ok) setResult(data);
      else setError(data.error || "Segmentation failed");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }

  async function track(onlyId?: number | null) {
    if (!file || busy || !promptList.length) return;
    setBusy(true);
    setError(null);
    setIsolate(onlyId ?? null);
    try {
      const fd = new FormData();
      fd.append("video", file);
      fd.append("concepts", promptList.join(", "));
      fd.append("min_score", String(minScore));
      if (onlyId != null) fd.append("only_ids", String(onlyId));
      const data: VideoResult = await fetch("/api/sam3/segment_video", { method: "POST", body: fd }).then((r) => r.json());
      if (data.ok) setVid(data);
      else setError(data.error || "Tracking failed");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }

  const colorFor = (concept: string) => {
    const i = (result?.prompt ?? promptList).indexOf(concept);
    return PALETTE[(i < 0 ? 0 : i) % PALETTE.length];
  };
  const byConcept: Record<string, number> = {};
  for (const inst of result?.instances ?? []) byConcept[inst.concept] = (byConcept[inst.concept] ?? 0) + 1;

  const tabBtn = (m: "image" | "video", label: string) => (
    <button
      onClick={() => switchMode(m)}
      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${mode === m ? "bg-indigo-600 on-accent" : "text-gray-400 hover:text-gray-200"}`}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-6">
      {/* health header */}
      <section className="bg-gray-900 rounded-xl border border-gray-800 p-4">
        <div className="flex items-center gap-3 flex-wrap">
          <span className={`w-2.5 h-2.5 rounded-full ${
            lifecycle.busyVerb ? "bg-amber-400 animate-pulse"
            : !health ? "bg-gray-600"
            : ready ? "bg-green-500"
            : health.up ? "bg-yellow-500 animate-pulse"
            : "bg-red-500"
          }`} />
          <span className="font-semibold text-sm">SAM 3</span>
          <span className="text-xs text-gray-500">localhost:8010</span>
          <span className={`text-[11px] px-2 py-0.5 rounded-full ${
            lifecycle.busyVerb ? "bg-amber-500/10 text-amber-400"
            : !health?.up ? "bg-red-500/10 text-red-400"
            : ready ? "bg-green-500/10 text-green-400"
            : "bg-yellow-500/10 text-yellow-400"
          }`}>
            {lifecycle.busyVerb
              ? `${lifecycle.busyVerb === "stop" ? "stopping" : lifecycle.busyVerb === "restart" ? "restarting" : "starting"}…`
              : !health?.up ? "offline"
              : ready ? `ready · ${health.device}${health.dtype ? ` · ${health.dtype}` : ""}`
              : "loading model…"}
          </span>
          {health?.vram && <span className="text-[11px] text-gray-500 tabular-nums">VRAM {health.vram.used_gb}/{health.vram.total_gb} GB</span>}
          {/* Lifecycle where the problem is reported — not "go to another tab". */}
          <ServiceControls lifecycle={lifecycle} onRefresh={checkHealth} className="ml-auto" />
        </div>
        <ServiceStartupNote lifecycle={lifecycle} downMessage="SAM 3 isn't running." className="mt-2" />
      </section>

      {/* uploader + concept prompt */}
      <section className="bg-gray-900 rounded-xl border border-gray-800 p-5 space-y-4">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 bg-gray-950 border border-gray-800 rounded-lg p-0.5">
            {tabBtn("image", "Image")}
            {tabBtn("video", "Video · track")}
          </div>
          <p className="text-xs text-gray-500">
            {mode === "image"
              ? "Name a concept → SAM 3 masks every matching instance."
              : "Name a concept → SAM 3 detects & tracks every matching object across the clip (stable id + colour per object)."}
          </p>
        </div>

        <div
          className={`rounded-xl border-2 border-dashed transition p-6 text-center cursor-pointer ${dragOver ? "border-indigo-500 bg-indigo-500/5" : "border-gray-700 hover:border-gray-500"}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) pickFile(f); }}
          onClick={() => fileRef.current?.click()}
        >
          <input
            ref={fileRef}
            type="file"
            accept={mode === "video" ? "video/*" : "image/*"}
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) pickFile(f); e.target.value = ""; }}
          />
          {file ? <p className="text-sm text-gray-300">{file.name} — click to change</p> : <p className="text-sm text-gray-400 py-2">{mode === "video" ? "Drop a video, or click to upload" : "Drop a photo, or click to upload"}</p>}
        </div>

        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <input
              value={concepts}
              onChange={(e) => setConcepts(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") (mode === "video" ? track() : segment()); }}
              placeholder="person, car, dog"
              className="flex-1 bg-gray-950 border border-gray-700 focus:border-indigo-500 outline-none rounded-lg px-3 py-2 text-sm text-gray-200 placeholder:text-gray-600"
            />
            <button
              onClick={() => (mode === "video" ? track() : segment())}
              disabled={!file || busy || !ready || !promptList.length}
              className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 rounded-xl px-6 py-2.5 text-sm font-medium transition"
            >
              {busy ? (mode === "video" ? "Tracking…" : "Segmenting…") : mode === "video" ? "Track" : "Segment"}
            </button>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            {QUICK.map((q) => (
              <button
                key={q}
                onClick={() => setConcepts(q)}
                className="text-[11px] px-2 py-0.5 rounded-full border border-gray-700 text-gray-400 hover:border-indigo-500 hover:text-indigo-300 transition"
              >
                {q}
              </button>
            ))}
            <label className="flex items-center gap-2 text-[11px] text-gray-500 ml-auto select-none">
              min score {minScore.toFixed(2)}
              <input type="range" min={0} max={1} step={0.05} value={minScore} onChange={(e) => setMinScore(Number(e.target.value))} className="accent-indigo-500" />
            </label>
          </div>
        </div>

        {mode === "video" && <p className="text-[11px] text-gray-600">Tracking runs inference on every frame — the clip is sampled to ~8 fps, up to 120 frames. Give it a few seconds.</p>}
        {!ready && health?.up && <p className="text-[11px] text-amber-400">Model still loading — give it a moment.</p>}
        {error && <div className="text-xs px-3 py-2 rounded-lg bg-red-500/10 text-red-400 border border-red-500/20">{error}</div>}
      </section>

      {/* IMAGE results */}
      {mode === "image" && (fileUrl || result) && (
        <section className="grid md:grid-cols-2 gap-5">
          <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">{result ? "Segmentation overlay" : "Image"}</h3>
            {/* eslint-disable-next-line @next/next/no-img-element -- data-URI preview */}
            <img src={result?.overlay_png || fileUrl || ""} alt="segmentation" className="w-full rounded-lg border border-gray-800 bg-black" />
            {!result && fileUrl && <p className="text-[11px] text-gray-600 mt-2">Name a concept and hit “Segment”.</p>}
          </div>
          <div className="bg-gray-900 rounded-xl border border-gray-800 p-4 space-y-3">
            {result ? (
              <>
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="text-2xl font-semibold text-gray-100 tabular-nums">{result.count ?? 0}</span>
                  <span className="text-xs text-gray-500">
                    instance{(result.count ?? 0) === 1 ? "" : "s"}
                    {result.count_total != null && result.count_total !== result.count ? ` (of ${result.count_total})` : ""}
                    {result.latency_ms != null ? ` · ${(result.latency_ms / 1000).toFixed(1)}s` : ""}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {Object.entries(byConcept).map(([c, n]) => (
                    <span key={c} className="text-[11px] px-2 py-0.5 rounded-full flex items-center gap-1.5" style={{ background: `rgba(${colorFor(c)},0.12)`, color: `rgb(${colorFor(c)})` }}>
                      <span className="w-2 h-2 rounded-full" style={{ background: `rgb(${colorFor(c)})` }} />
                      {c} × {n}
                    </span>
                  ))}
                </div>
                <div className="max-h-64 overflow-auto rounded-lg border border-gray-800 divide-y divide-gray-800/70">
                  {(result.instances ?? []).map((inst, i) => (
                    <div key={inst.id ?? i} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: `rgb(${colorFor(inst.concept)})` }} />
                      <span className="text-gray-300 truncate">{inst.concept}</span>
                      <span className="ml-auto tabular-nums text-gray-500">{(inst.score * 100).toFixed(1)}%</span>
                    </div>
                  ))}
                  {(result.instances ?? []).length === 0 && (
                    <div className="px-3 py-4 text-xs text-gray-600 text-center">No instances found for “{(result.prompt ?? []).join(", ")}”.</div>
                  )}
                </div>
              </>
            ) : (
              <p className="text-[11px] text-gray-600">Masks, boxes and per-instance scores appear here after you segment.</p>
            )}
          </div>
        </section>
      )}

      {/* VIDEO results */}
      {mode === "video" && (fileUrl || vid) && (
        <section className="grid md:grid-cols-2 gap-5">
          <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">{vid ? "Tracked" : "Clip"}</h3>
            {/* eslint-disable-next-line jsx-a11y/media-has-caption -- generated preview */}
            <video src={vid?.video_mp4 || fileUrl || ""} controls autoPlay loop muted playsInline className="w-full rounded-lg border border-gray-800 bg-black" />
            {!vid && fileUrl && <p className="text-[11px] text-gray-600 mt-2">Name a concept and hit “Track”.</p>}
          </div>
          <div className="bg-gray-900 rounded-xl border border-gray-800 p-4 space-y-3">
            {vid ? (
              <>
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="text-2xl font-semibold text-gray-100 tabular-nums">{vid.object_count ?? 0}</span>
                  <span className="text-xs text-gray-500">
                    tracked object{(vid.object_count ?? 0) === 1 ? "" : "s"}
                    {vid.frames != null ? ` · ${vid.frames} frames` : ""}
                    {vid.out_fps != null ? ` @ ${vid.out_fps}fps` : ""}
                    {vid.latency_ms != null ? ` · ${(vid.latency_ms / 1000).toFixed(1)}s` : ""}
                  </span>
                </div>
                <p className="text-[11px] text-gray-600">Each object keeps its colour + id across the whole clip. Click one to re-track it on its own.</p>
                <div className="max-h-64 overflow-auto rounded-lg border border-gray-800 divide-y divide-gray-800/70">
                  {(vid.objects ?? []).map((o) => (
                    <button
                      key={o.id}
                      onClick={() => track(o.id)}
                      disabled={busy}
                      className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left transition hover:bg-gray-800/60 ${isolate === o.id ? "bg-indigo-500/10" : ""}`}
                    >
                      <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: `rgb(${idColor(o.id)})` }} />
                      <span className="text-gray-300">{o.concept} <span className="text-gray-600">#{o.id}</span></span>
                      <span className="ml-auto tabular-nums text-gray-500">{o.frames}f · {(o.best_score * 100).toFixed(0)}%</span>
                    </button>
                  ))}
                  {(vid.objects ?? []).length === 0 && (
                    <div className="px-3 py-4 text-xs text-gray-600 text-center">No objects found for “{(vid.prompt ?? []).join(", ")}”.</div>
                  )}
                </div>
                {isolate != null && (
                  <button onClick={() => track(null)} disabled={busy} className="text-[11px] text-indigo-400 hover:text-indigo-300">← show all tracked objects</button>
                )}
              </>
            ) : (
              <p className="text-[11px] text-gray-600">Upload a clip, name what to follow, and hit “Track”. Every matching object is detected and followed frame-to-frame with a stable id.</p>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
