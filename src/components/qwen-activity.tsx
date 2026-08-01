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
  model?: string;
  via?: string;
  modelRevision?: string;
  modelParams?: string;
  modelParamsTotal?: string;
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

const PAGE_SIZES = [100, 200, 500];

export default function QwenActivity() {
  const [items, setItems] = useState<Item[]>([]);
  const [sources, setSources] = useState<string[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [models, setModels] = useState<string[]>([]);
  const [modelCounts, setModelCounts] = useState<Record<string, number>>({});
  const [modelFilter, setModelFilter] = useState<string>("all");
  const [total, setTotal] = useState(0);      // every image on disk
  const [count, setCount] = useState(0);      // matching the active filter
  const [filter, setFilter] = useState<string>("all");
  const [loading, setLoading] = useState(true);
  const [dir, setDir] = useState<string>("");
  const [lightbox, setLightbox] = useState<Item | null>(null);
  // Paging is server-side: filter + offset are applied across the WHOLE archive,
  // so every page costs the same and the oldest image is always reachable.
  const [offset, setOffset] = useState(0);
  const [pageSize, setPageSize] = useState(200);
  /** Which offset the items currently in state were actually fetched for. */
  const [loadedOffset, setLoadedOffset] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ offset: String(offset), limit: String(pageSize) });
      if (filter !== "all") qs.set("source", filter);
      if (modelFilter !== "all") qs.set("model", modelFilter);
      const res = await fetch(`/api/qwen/archive?${qs}`);
      const data = await res.json();
      setItems(Array.isArray(data.images) ? data.images : []);
      setSources(Array.isArray(data.sources) ? data.sources : []);
      setCounts(data.counts ?? {});
      setModels(Array.isArray(data.models) ? data.models : []);
      setModelCounts(data.modelCounts ?? {});
      setTotal(typeof data.total === "number" ? data.total : 0);
      setCount(typeof data.count === "number" ? data.count : 0);
      setDir(data.dir ?? "");
      setLoadedOffset(typeof data.offset === "number" ? data.offset : offset);
    } catch {
      /* keep prior list */
    }
    setLoading(false);
  }, [offset, pageSize, filter, modelFilter]);

  useEffect(() => { setLoading(true); }, [offset, pageSize, filter, modelFilter]);

  // Poll while mounted — this is a live firehose, so it should feel current. Only
  // the newest page auto-refreshes: re-fetching while you're reading page 7 of
  // history would shuffle items under the cursor for no benefit.
  useEffect(() => {
    refresh();
    if (offset !== 0) return;
    const t = setInterval(refresh, 15000);
    return () => clearInterval(t);
  }, [refresh, offset]);

  // Changing the filter restarts at the newest page — offset is meaningless across filters.
  const pickFilter = useCallback((s: string) => { setFilter(s); setOffset(0); }, []);
  const pickModel = useCallback((m: string) => { setModelFilter(m); setOffset(0); }, []);

  const page = Math.floor(offset / pageSize) + 1;
  const pageCount = Math.max(1, Math.ceil(count / pageSize));

  // Where the open image sits in the current page — drives the ‹ › affordances
  // and the "n of m" readout.
  const lightboxIndex = useMemo(
    () => (lightbox ? items.findIndex((i) => i.rel === lightbox.rel) : -1),
    [lightbox, items],
  );

  /**
   * Stepping past either end of the loaded page pulls the neighbouring page and
   * resumes from its edge, so ← / → walk the entire archive rather than stopping
   * dead at an invisible page seam. `edgeSeek` remembers which end to land on
   * once the new page arrives.
   */
  const [edgeSeek, setEdgeSeek] = useState<null | "first" | "last">(null);

  const navLightbox = useCallback(
    (delta: 1 | -1) => {
      const i = items.findIndex((x) => x.rel === lightbox?.rel);
      if (i < 0) return;
      const j = i + delta;
      if (j >= 0 && j < items.length) { setLightbox(items[j]); return; }
      if (delta === 1 && offset + items.length < count) { setEdgeSeek("first"); setOffset(offset + pageSize); }
      else if (delta === -1 && offset > 0) { setEdgeSeek("last"); setOffset(Math.max(0, offset - pageSize)); }
    },
    [items, lightbox, offset, count, pageSize],
  );

  /**
   * Land on the correct edge of a page fetched by crossing a boundary.
   * Gated on `loadedOffset` — the offset the CURRENT items actually came from —
   * not on `loading`: the loading flag is set by a sibling effect in the same
   * commit, so this effect would still observe `false` and resolve against the
   * outgoing page, leaving the lightbox on an item absent from `items` (index
   * -1) and freezing navigation.
   */
  useEffect(() => {
    if (!edgeSeek || loadedOffset !== offset || items.length === 0) return;
    setLightbox(edgeSeek === "first" ? items[0] : items[items.length - 1]);
    setEdgeSeek(null);
  }, [edgeSeek, loadedOffset, offset, items]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { setLightbox(null); return; }
      if (!lightbox) return;
      if (e.key === "ArrowRight") { e.preventDefault(); navLightbox(1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); navLightbox(-1); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox, navLightbox]);

  /** Absolute on-disk location — the archive dir plus the image's relative path. */
  const fullPath = useCallback(
    (rel: string) => (dir ? `${dir}\\${rel.replace(/\//g, "\\")}` : rel),
    [dir],
  );
  const [copied, setCopied] = useState(false);
  const copyPath = useCallback(async (rel: string) => {
    try {
      await navigator.clipboard.writeText(fullPath(rel));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked — the path is on screen to select anyway */ }
  }, [fullPath]);

  // Filtering happens server-side across the whole archive, so the page IS the view.
  const visible = items;

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
              {count > 0 ? `${offset + 1}–${offset + items.length} of ${count}` : "0"} images
              {filter !== "all" && <span className="text-gray-600"> · {total} total</span>}
            </span>
          )}
          <button onClick={refresh} className="ml-auto text-[11px] text-gray-400 hover:text-white border border-gray-700 hover:border-gray-500 rounded-md px-2 py-1 transition">
            Refresh
          </button>
        </div>
        {dir && <p className="text-[11px] text-gray-600 mt-2 font-mono truncate" title={dir}>{dir}</p>}
      </section>

      {/* source filter — counts are whole-archive, not page-local */}
      <div className="flex items-center gap-2 flex-wrap">
        <Chip label="All" count={total} active={filter === "all"} onClick={() => pickFilter("all")} />
        {sources.map((s) => (
          <Chip
            key={s}
            label={s}
            count={counts[s] ?? 0}
            active={filter === s}
            styleClass={sourceStyle(s)}
            onClick={() => pickFilter(s)}
          />
        ))}
        <span className="ml-auto flex items-center gap-2 text-[11px] text-gray-500">
          per page{" "}
          {PAGE_SIZES.map((n) => (
            <button
              key={n}
              onClick={() => { setPageSize(n); setOffset(0); }}
              className={`px-2 py-0.5 rounded-md border tabular-nums transition ${
                pageSize === n ? "border-indigo-500/50 text-indigo-300 bg-indigo-500/10" : "border-gray-800 text-gray-500 hover:border-gray-600"
              }`}
            >
              {n}
            </button>
          ))}
        </span>
      </div>

      {/* model filter — the whole-archive tally, same contract as the source chips.
          "untagged" is everything generated before model provenance was recorded;
          it is labelled honestly rather than attributed to a guessed model. */}
      {models.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[11px] text-gray-600 uppercase tracking-wide mr-1">Model</span>
          <Chip label="Any" count={total} active={modelFilter === "all"} onClick={() => pickModel("all")} />
          {models.map((m) => (
            <Chip
              key={m}
              label={m === "untagged" ? "untagged" : m.split("/").pop()!}
              count={modelCounts[m] ?? 0}
              active={modelFilter === m}
              styleClass={m === "untagged"
                ? "bg-gray-600/20 text-gray-400 border-gray-600/40"
                : "bg-violet-500/15 text-violet-300 border-violet-500/30"}
              onClick={() => pickModel(m)}
            />
          ))}
        </div>
      )}

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

          {/* pager — the whole archive is reachable, oldest included */}
          {pageCount > 1 && (
            <div className="flex items-center justify-center gap-2 pt-2">
              <PagerBtn label="⏮ Newest" disabled={offset === 0} onClick={() => setOffset(0)} />
              <PagerBtn label="← Newer" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - pageSize))} />
              <span className="text-xs text-gray-500 tabular-nums px-2">
                page {page} of {pageCount}
              </span>
              <PagerBtn
                label="Older →"
                disabled={offset + items.length >= count}
                onClick={() => setOffset(offset + pageSize)}
              />
              <PagerBtn
                label="Oldest ⏭"
                disabled={offset + items.length >= count}
                onClick={() => setOffset(Math.max(0, (pageCount - 1) * pageSize))}
              />
            </div>
          )}
        </div>
      )}

      {/* lightbox */}
      {lightbox && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4" onClick={() => setLightbox(null)}>
          <div
            className="max-w-5xl max-h-full flex flex-col md:flex-row bg-gray-900 rounded-2xl border border-gray-800 overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* image + in-place navigation (also ← / → on the keyboard) */}
            <div className="relative flex items-center justify-center bg-black">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={lightbox.url} alt={lightbox.prompt} className="max-h-[80vh] object-contain" />
              {/* Bounds are archive-wide, not page-wide — crossing an edge loads the next page. */}
              {offset + lightboxIndex > 0 && (
                <NavArrow side="left" onClick={() => navLightbox(-1)} />
              )}
              {lightboxIndex >= 0 && offset + lightboxIndex < count - 1 && (
                <NavArrow side="right" onClick={() => navLightbox(1)} />
              )}
              {lightboxIndex >= 0 && (
                <span className="absolute bottom-2 left-1/2 -translate-x-1/2 text-[11px] text-gray-300 bg-black/60 rounded-full px-2.5 py-1 tabular-nums select-none">
                  {offset + lightboxIndex + 1} of {count}
                </span>
              )}
            </div>
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
                {lightbox.model && <Row k="model" v={lightbox.model} />}
                {lightbox.modelParams && (
                  <Row
                    k="params"
                    v={lightbox.modelParamsTotal && lightbox.modelParamsTotal !== lightbox.modelParams
                      ? `${lightbox.modelParams} denoiser · ${lightbox.modelParamsTotal} total`
                      : lightbox.modelParams}
                  />
                )}
                {lightbox.modelRevision && (
                  <Row k="revision" v={lightbox.modelRevision.slice(0, 12)} />
                )}
                {lightbox.via && <Row k="via" v={lightbox.via} />}
              </dl>

              {/* Where this actually lives on disk — the whole point of the archive
                  view is that these are real files you can go open. */}
              <div className="space-y-1 pt-1 border-t border-gray-800">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-gray-600">path</span>
                  <button
                    onClick={() => copyPath(lightbox.rel)}
                    className="text-[11px] text-gray-500 hover:text-gray-200 border border-gray-800 hover:border-gray-600 rounded px-1.5 py-0.5 transition cursor-pointer"
                  >
                    {copied ? "copied ✓" : "copy"}
                  </button>
                </div>
                <p
                  className="text-[11px] text-gray-400 font-mono break-all leading-relaxed select-all"
                  title={fullPath(lightbox.rel)}
                >
                  {fullPath(lightbox.rel)}
                </p>
              </div>

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

/** Hover-revealed prev/next affordance parked over the lightbox image. */
function NavArrow({ side, onClick }: { side: "left" | "right"; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-label={side === "left" ? "Previous image" : "Next image"}
      className={`absolute top-1/2 -translate-y-1/2 ${side === "left" ? "left-2" : "right-2"} w-9 h-9 rounded-full bg-black/50 hover:bg-black/80 text-white text-lg leading-none flex items-center justify-center transition cursor-pointer`}
    >
      {side === "left" ? "‹" : "›"}
    </button>
  );
}

function PagerBtn({ label, disabled, onClick }: { label: string; disabled: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="text-xs px-3 py-1.5 rounded-lg border border-gray-800 text-gray-400 hover:text-gray-100 hover:border-gray-600 transition disabled:opacity-30 disabled:hover:border-gray-800 disabled:hover:text-gray-400 cursor-pointer disabled:cursor-default"
    >
      {label}
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
