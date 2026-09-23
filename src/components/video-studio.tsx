"use client";

import { useEffect, useState } from "react";
import { Film, LoaderCircle, Upload } from "lucide-react";
import ModelPicker from "@/components/model-picker";
import { ToolPageHeader } from "@/components/tool-page";
import { runtimeStatus, runtimeSummary } from "@/lib/runtimes";

export default function VideoStudio() {
  const [prompt, setPrompt] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);

  const pickImage = (file?: File) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setImage(String(reader.result));
    reader.readAsDataURL(file);
  };

  const generate = async () => {
    if (!prompt.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/video/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, image, width: 768, height: 448, frames: 49, steps: 30 }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || body.error || `Video generation failed (${res.status})`);
      }
      const next = URL.createObjectURL(await res.blob());
      if (url) URL.revokeObjectURL(url);
      setUrl(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const videoStatus = runtimeStatus("video");

  return (
    <div className="space-y-4">
      <ToolPageHeader
        eyebrow="Local creation"
        title="Video Studio"
        description="Generate video locally with Draw Things and Wan 2.2. Nothing is uploaded. Image-to-video accepts one optional starting frame."
        icon={<Film className="h-5 w-5" />}
      />
      {/* Driven by the profile's runtimes.video, not by a hostname. The old
          version of this block was `getHostId() === "b5"` and it WARNED while
          leaving Generate live — so the honest thing it said ("the smoke test
          produced undecoded frames") could still be ignored with one click,
          spending minutes of GPU on garbage. A warning that does not stop the
          action is decoration. */}
      {videoStatus !== "verified" && (
        <div role="alert" className="rounded-xl border border-amber-500/30 bg-amber-500/[0.07] px-4 py-3 text-xs leading-relaxed text-amber-200">
          {runtimeSummary("video")}{" "}
          {videoStatus === "unverified" && (
            <>Generating is disabled until it passes, because a bad video run costs minutes rather than seconds. Run <code className="rounded bg-gray-950/60 px-1 py-0.5">node scripts/doctor.mjs video --write</code> to check it.</>
          )}
        </div>
      )}
      <section className="grid gap-4 lg:grid-cols-[minmax(0,420px)_1fr]">
        <div className="space-y-4 rounded-xl border border-gray-800 bg-gray-900 p-4">
          <ModelPicker capability="video" compact />
          <label className="block text-xs font-medium text-gray-300">
            Prompt
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={6}
              placeholder="A paper kite glides above a quiet desert at golden hour…"
              className="mt-2 w-full resize-y rounded-lg border border-gray-700 bg-gray-950 p-3 text-sm text-gray-100 outline-none focus:border-indigo-500"
            />
          </label>
          <label className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-gray-700 px-3 py-3 text-xs text-gray-400 transition hover:border-gray-500 hover:text-gray-200">
            <Upload className="h-4 w-4" />
            {image ? "Starting frame selected · choose another" : "Optional starting frame"}
            <input type="file" accept="image/*" className="hidden" onChange={(event) => pickImage(event.target.files?.[0])} />
          </label>
          <button
            type="button"
            disabled={busy || !prompt.trim() || videoStatus !== "verified"}
            onClick={generate}
            title={videoStatus !== "verified" ? "This machine's video runtime has not been verified — see the notice above." : undefined}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Film className="h-4 w-4" />}
            {busy ? "Generating locally…" : videoStatus === "verified" ? "Generate video" : "Video runtime unverified"}
          </button>
          <p className="text-[11px] leading-relaxed text-gray-500">Wan video is compute-heavy and shares unified memory with the other local models. Hangar queues it so image, speech, and video jobs do not fight each other.</p>
          {error && <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">{error}</p>}
        </div>
        <div className="flex min-h-[360px] items-center justify-center overflow-hidden rounded-xl border border-gray-800 bg-black/30 p-4">
          {url ? <video src={url} controls autoPlay loop className="max-h-[70vh] w-full rounded-lg" /> : (
            <div className="max-w-sm text-center text-gray-600">
              <Film className="mx-auto mb-3 h-10 w-10" />
              <p className="text-sm">Your generated MP4 will appear here.</p>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
