"use client";

import { useState, useEffect, useCallback, useMemo } from "react";

type Item = {
  rel: string;
  file: string;
  url: string;
  source: string;
  kind: "generate" | "edit";
  prompt: string;
  seed?: number;
  width?: number;
  height?: number;
  steps?: number;
  cfg?: number;
  ms?: number;
  inputCount?: number;
  savedAt?: string;
  bytes?: number;
};

const SOURCE_STYLES: Record<string, string> = {
  console: "bg-pink-500/15 text-pink-300 border-pink-500/30",
  "quote-forge": "bg-amber-500/15 text-amber-300 border-amber-500/30",
  misc: "bg-gray-600/20 text-gray-400 border-gray-600/40",
};
function sourceStyle(s: string): string {
  return SOURCE_STYLES[s] || "bg-indigo-500/15 text-indigo-300 border-indigo-500/30";
}

function fmtBytes(n?: number) {
  if (!n) return "";
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}
function fmtMs(ms?: number) {
  if (ms == null) return "";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

export default function QwenActivity() {
  const [items, setItems] = useState<Item[]>([]);
  const [sources, setSources] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState<string>("all");
  const [loading, setLoading] = useState(true);
  const [dir, setDir] = useState<string>("");
  const [lightbox, setLightbox] = useState<Item | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/qwen/archive");
      const data = await res.json();
      setItems(Array.isArray(data.images) ? data.images : []);
      setSources(Array.isArray(data.sources) ? data.sources : []);
      setTotal(typeof data.count === "number" ? data.count : 0);
      setDir(data.dir ?? "");
    } catch {
      /* keep prior list */
    }
    setLoading(false);
  }, []);

  // Poll while mounted — this is a live firehose, so it should feel current.
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setLightbox(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of items) m.set(it.source, (m.get(it.source) ?? 0) + 1);
    return m;
  }, [items]);

  const visible = useMemo(
    () => (filter === "all" ? items : items.filter((i) => i.source === filter)),
    [items, filter],
  );

  const groups = useMemo(() => {
    const map = new Map<string, Item[]>();
    for (const it of visible) {
      const key = it.savedAt
        ? new Date(it.savedAt).toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "long", day: "numeric" })
        : "Undated";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(it);
    }
    return [...map.entries()];
  }, [visible]);

  return (
    <div className="space-y-6">
      {/* header */}
      <section className="bg-gray-900 rounded-xl border border-gray-800 p-4">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="w-2.5 h-2.5 rounded-full bg-indigo-500" />
          <span className="font-semibold text-sm">Activity</span>
          <span className="text-xs text-gray-500">every image this box generates — console, quote-forge, scripts</span>
          {total > 0 && (
            <span className="text-[11px] text-gray-500 tabular-nums">
              {items.length}
              {total > items.length ? ` of ${total}` : ""} images
            </span>
          )}
          <button onClick={refresh} className="ml-auto text-[11px] text-gray-400 hover:text-white border border-gray-700 hover:border-gray-500 rounded-md px-2 py-1 transition">
            Refresh
          </button>
        </div>
        {dir && <p className="text-[11px] text-gray-600 mt-2 font-mono truncate" title={dir}>{dir}</p>}
      </section>

      {/* source filter */}
      <div className="flex items-center gap-2 flex-wrap">
        <Chip label="All" count={items.length} active={filter === "all"} onClick={() => setFilter("all")} />
        {sources.map((s) => (
          <Chip
            key={s}
            label={s}
            count={counts.get(s) ?? 0}
            active={filter === s}
            styleClass={sourceStyle(s)}
            onClick={() => setFilter(s)}
          />
        ))}
      </div>

      {/* grid */}
      {loading ? (
        <p className="text-sm text-gray-500 py-12 text-center">Loading…</p>
      ) : visible.length === 0 ? (
        <div className="text-center py-16 text-gray-500">
          <p className="text-sm">No images yet.</p>
          <p className="text-xs text-gray-600 mt-1">Every generation from any caller shows up here automatically.</p>
        </div>
      ) : (
        <div className="space-y-8">
          {groups.map(([day, imgs]) => (
            <div key={day}>
              <h3 className="text-xs font-medium text-gray-500 mb-3">
                {day} <span className="text-gray-700">· {imgs.length}</span>
              </h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
                {imgs.map((it) => (
                  <button
                    key={it.rel}
                    onClick={() => setLightbox(it)}
                    className="group relative aspect-square rounded-lg overflow-hidden border border-gray-800 bg-gray-900 text-left"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={it.url} alt={it.prompt} loading="lazy" className="w-full h-full object-cover transition group-hover:scale-105" />
                    <span className={`absolute top-1.5 left-1.5 text-[10px] px-1.5 py-0.5 rounded-full border ${sourceStyle(it.source)}`}>{it.source}</span>
                    {it.kind === "edit" && (
                      <span className="absolute top-1.5 right-1.5 text-[10px] px-1.5 py-0.5 rounded-full border bg-purple-500/15 text-purple-300 border-purple-500/30">edit</span>
                    )}
                    {it.prompt && (
                      <span className="absolute inset-x-0 bottom-0 p-2 text-[10px] text-gray-200 bg-gradient-to-t from-black/80 to-transparent opacity-0 group-hover:opacity-100 transition line-clamp-2">
                        {it.prompt}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* lightbox */}
      {lightbox && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4" onClick={() => setLightbox(null)}>
          <div
            className="max-w-5xl max-h-full flex flex-col md:flex-row bg-gray-900 rounded-2xl border border-gray-800 overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={lightbox.url} alt={lightbox.prompt} className="max-h-[80vh] object-contain bg-black" />
            <div className="p-5 w-full md:w-80 space-y-3 text-sm overflow-y-auto">
              <div className="flex items-center gap-2">
                <span className={`text-[11px] px-2 py-0.5 rounded-full border ${sourceStyle(lightbox.source)}`}>{lightbox.source}</span>
                <span className="text-[11px] text-gray-500">{lightbox.kind}</span>
              </div>
              {lightbox.prompt && <p className="text-gray-200 leading-relaxed">{lightbox.prompt}</p>}
              <dl className="text-xs text-gray-400 space-y-1">
                {lightbox.seed != null && <Row k="seed" v={String(lightbox.seed)} />}
                {lightbox.width ? <Row k="size" v={`${lightbox.width}×${lightbox.height}`} /> : null}
                {lightbox.steps != null && <Row k="steps" v={String(lightbox.steps)} />}
                {lightbox.cfg != null && <Row k="cfg" v={String(lightbox.cfg)} />}
                {lightbox.inputCount != null && <Row k="inputs" v={String(lightbox.inputCount)} />}
                {lightbox.ms != null && <Row k="time" v={fmtMs(lightbox.ms)} />}
                {lightbox.bytes != null && <Row k="file" v={fmtBytes(lightbox.bytes)} />}
                {lightbox.savedAt && <Row k="when" v={new Date(lightbox.savedAt).toLocaleString()} />}
              </dl>
              <a href={lightbox.url} download={lightbox.file} className="inline-block text-xs text-indigo-300 hover:text-indigo-200 border border-indigo-500/30 rounded-lg px-3 py-1.5 transition">
                Download PNG
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Chip({
  label,
  count,
  active,
  onClick,
  styleClass,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  styleClass?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`text-xs px-3 py-1.5 rounded-full border transition ${
        active ? styleClass || "bg-white/10 text-white border-white/30" : "bg-gray-900 text-gray-400 border-gray-800 hover:border-gray-600"
      }`}
    >
      {label} <span className="text-gray-500 tabular-nums">{count}</span>
    </button>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-gray-600">{k}</dt>
      <dd className="text-gray-300 text-right break-all">{v}</dd>
    </div>
  );
}
