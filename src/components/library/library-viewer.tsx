"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { Check, ChevronLeft, ChevronRight, Copy, Download, FolderOpen, Pause, Play, X } from "lucide-react";
import { useTabActive } from "@/components/tab-pane";
import { fileUrl, hueOf, num, previewUrl, stopSound, STATUS_LABEL, STUDIO_LABEL, titleCase, type LibraryFilter, type LibraryItem } from "./library-shared";

// three.js only loads when a model is opened.
const MeshViewer = dynamic(() => import("@/components/labs/mesh-viewer"), { ssr: false });

type Detail = LibraryItem & { path: string; samples: { name: string; kind: string | null }[] };

const date = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const bytes = (n: number | null) => (n == null ? null : n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

/** One file, as big as the window allows: clips play, sounds play over their waveform, models spin. */
export default function LibraryViewer({ items, index, colors, onIndex, onClose, onFilter }: {
  items: LibraryItem[]; index: number; colors: Record<string, string>;
  onIndex: (i: number) => void; onClose: () => void; onFilter: (f: LibraryFilter) => void;
}) {
  const item = items[index];
  const active = useTabActive();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [copied, setCopied] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    stopSound();
    closeRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    let live = true;
    setDetail(null);
    setCopied(false);
    fetch(`/api/library?view=item&id=${item.id}`).then((r) => (r.ok ? r.json() : null)).then((d) => live && setDetail(d)).catch(() => {});
    return () => { live = false; };
  }, [item.id]);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight" && index < items.length - 1) onIndex(index + 1);
      else if (e.key === "ArrowLeft" && index > 0) onIndex(index - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, index, items.length, onClose, onIndex]);

  const reveal = () => void fetch("/api/library", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "reveal", id: item.id }) });
  const copy = async () => {
    if (!item.prompt) return;
    await navigator.clipboard.writeText(detail?.prompt ?? item.prompt).catch(() => {});
    setCopied(true);
  };

  const facts = [date(item.mtime), bytes(item.size), item.kind === "collection" && item.count != null ? `${num(item.count)} files` : null].filter(Boolean);
  return (
    <div className="lib-viewer" role="dialog" aria-modal="true" aria-label={item.name} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <button ref={closeRef} type="button" className="lib-viewer-close" onClick={onClose} aria-label="Close"><X size={22} /></button>
      {index > 0 && <button type="button" className="lib-viewer-step is-prev" onClick={() => onIndex(index - 1)} aria-label="Previous"><ChevronLeft size={30} /></button>}
      {index < items.length - 1 && <button type="button" className="lib-viewer-step is-next" onClick={() => onIndex(index + 1)} aria-label="Next"><ChevronRight size={30} /></button>}

      <div className="lib-viewer-stage" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        {item.kind === "image" && <img key={item.id} src={fileUrl(item)} alt={item.prompt ?? item.name} />}
        {item.kind === "video" && <video key={item.id} src={fileUrl(item)} poster={previewUrl(item, "poster", 1280)} controls autoPlay playsInline />}
        {item.kind === "sound" && <SoundStage key={item.id} item={item} />}
        {item.kind === "model" && <MeshViewer key={item.id} url={fileUrl(item)} downloadName={item.name} autoSpin className="lib-mesh" />}
        {item.kind === "collection" && (
          <div className="lib-sample-grid">
            {(detail?.samples ?? []).map((s, i) => s.kind === "sound"
              ? <audio key={i} src={`/api/library/file?id=${item.id}&sample=${i}`} controls preload="none" />
              : <img key={i} src={`/api/library/file?id=${item.id}&sample=${i}`} alt={s.name} loading="lazy" />)}
          </div>
        )}
      </div>

      <aside className="lib-viewer-info">
        {(detail?.prompt ?? item.prompt) ? <p className="lib-viewer-prompt">{detail?.prompt ?? item.prompt}</p> : <p className="lib-viewer-name">{item.name}</p>}
        <div className="lib-viewer-tags">
          {item.project && <button type="button" onClick={() => onFilter({ project: item.project! })}><i className="lib-dot" style={{ background: `hsl(${hueOf(item.project)} 60% 55%)` }} />{item.project}</button>}
          {item.group && <button type="button" onClick={() => onFilter({ project: item.project ?? undefined, group: item.group! })}>{item.group}</button>}
          {item.studio && <button type="button" onClick={() => onFilter({ studio: item.studio! })}>{STUDIO_LABEL[item.studio] ?? item.studio}</button>}
          {item.faction && <button type="button" onClick={() => onFilter({ faction: item.faction! })}><i className="lib-dot" style={{ background: colors[item.faction] ?? "#888" }} />{titleCase(item.faction)}</button>}
          {item.status && <button type="button" onClick={() => onFilter({ status: item.status! })}><i className={`lib-status is-${item.status}`} />{STATUS_LABEL[item.status]}</button>}
          {item.model && <button type="button" onClick={() => onFilter({ q: item.model! })}>{item.model}</button>}
        </div>
        <p className="lib-viewer-facts">{facts.join(" · ")}{item.prompt ? <><br /><span>{item.name}</span></> : null}</p>
        <div className="lib-viewer-actions">
          <button type="button" onClick={reveal}><FolderOpen size={15} /> Show in folder</button>
          {item.kind !== "collection" && <a href={`${fileUrl(item)}&download=1`}><Download size={15} /> Download</a>}
          {item.prompt && <button type="button" onClick={() => void copy()}>{copied ? <Check size={15} /> : <Copy size={15} />} {copied ? "Copied" : "Copy prompt"}</button>}
        </div>
      </aside>
    </div>
  );
}

/** A sound's waveform, lit up as it plays; click anywhere on it to jump there. */
function SoundStage({ item }: { item: LibraryItem }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [at, setAt] = useState(0);
  const [on, setOn] = useState(false);
  const seek = (e: ReactMouseEvent<HTMLDivElement>) => {
    const a = audio.current;
    if (!a?.duration) return;
    const r = e.currentTarget.getBoundingClientRect();
    a.currentTime = ((e.clientX - r.left) / r.width) * a.duration;
    void a.play();
  };
  return (
    <div className="lib-sound-stage" style={{ "--tile-hue": hueOf(item.project) } as CSSProperties}>
      <div className="lib-sound-wave" onClick={seek}>
        <img src={previewUrl(item, "wave")} alt="" />
        <img src={previewUrl(item, "wave")} alt="" className="is-played" style={{ clipPath: `inset(0 ${100 - at * 100}% 0 0)` }} />
      </div>
      <button type="button" className="lib-sound-toggle" onClick={() => (on ? audio.current?.pause() : void audio.current?.play())} aria-label={on ? "Pause" : "Play"}>
        {on ? <Pause size={28} /> : <Play size={28} />}
      </button>
      <audio ref={audio} src={fileUrl(item)} autoPlay onPlay={() => setOn(true)} onPause={() => setOn(false)} onEnded={() => setOn(false)}
        onTimeUpdate={(e) => setAt(e.currentTarget.duration ? e.currentTarget.currentTime / e.currentTarget.duration : 0)} />
    </div>
  );
}
