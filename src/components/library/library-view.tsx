"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { ArrowUpRight, CalendarDays, Database, Film, Image as ImageIcon, Layers, LoaderCircle, Pause, Play, RefreshCw, Search, Sparkles, X, type LucideIcon } from "lucide-react";
import { useTabActive } from "@/components/tab-pane";
import { onLibraryNav, openLibrary, takeLibraryNav, type LibraryNav } from "@/lib/library-nav";
import { DATES, fileUrl, hueOf, KIND_ICON, KIND_LABEL, nowPlaying, num, playSound, previewUrl, STATUS_LABEL, stopSound, STUDIO_LABEL, titleCase, type Facet, type LibraryFilter, type LibraryItem, type Summary } from "./library-shared";

type FacetSet = { kinds: Facet[]; projects: Facet[]; studios: Facet[]; factions: Facet[]; statuses: Facet[] };
import LibraryViewer from "./library-viewer";
import "./library.css";

const SHELF_ICON: Record<string, LucideIcon> = { videos: Film, generated: Sparkles, datasets: Database };
const PAGE = 96;

function queryString(f: LibraryFilter, extra: Record<string, string | number | undefined> = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...f, ...extra })) {
    if (k === "days" || v == null || v === "") continue;
    p.set(k, String(v));
  }
  if (f.days) p.set("from", String(Date.now() - f.days * 86_400_000));
  return p.toString();
}

/**
 * The Library: every video, AI-made file and dataset on this machine as one
 * poster wall. `lock` pins filters (a studio's History shows only its own
 * outputs); `compact` drops the shelves for use inside a studio.
 */
export default function LibraryView({ lock, compact = false, refreshKey }: { lock?: LibraryFilter; compact?: boolean; refreshKey?: string }) {
  const active = useTabActive();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [filter, setFilter] = useState<LibraryFilter>({});
  const [text, setText] = useState("");
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openAt, setOpenAt] = useState<number | null>(null);
  // What each filter can narrow to from here, counted by the server.
  const [facets, setFacets] = useState<FacetSet>({ kinds: [], projects: [], studios: [], factions: [], statuses: [] });
  const request = useRef(0);
  const sentinel = useRef<HTMLDivElement>(null);
  const lockKey = JSON.stringify(lock ?? {});
  const effective = useMemo(() => ({ ...filter, ...(lock ?? {}) }), [filter, lockKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const key = JSON.stringify(effective);

  // Arriving from a studio, a World project or Storage, already filtered.
  useEffect(() => {
    if (compact) return;
    const apply = (nav: LibraryNav) => {
      setFilter(nav);
      setText(nav.q ?? "");
      setOpenAt(null);
    };
    const waiting = takeLibraryNav();
    if (waiting) apply(waiting);
    return onLibraryNav(apply);
  }, [compact]);

  // Typing searches after a short pause.
  useEffect(() => {
    const t = setTimeout(() => setFilter((f) => ((f.q ?? "") === text.trim() ? f : { ...f, q: text.trim() || undefined })), 280);
    return () => clearTimeout(t);
  }, [text]);

  const loadSummary = useCallback(async () => {
    try {
      const res = await fetch("/api/library?view=summary", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Library unavailable (${res.status})`);
      setSummary(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const loadPage = useCallback(async (cursor: string | null) => {
    const id = ++request.current;
    setLoading(true);
    try {
      const res = await fetch(`/api/library?view=list&${queryString(effective, { cursor: cursor ?? undefined, limit: PAGE })}`, { cache: "no-store" });
      const data = await res.json();
      if (id !== request.current) return;
      if (!res.ok) throw new Error(data.error || `Library unavailable (${res.status})`);
      setItems((prev) => (cursor ? [...prev, ...data.items] : data.items));
      setNext(data.next);
      if (!cursor) {
        setTotal(data.total ?? null);
        if (data.facets) setFacets(data.facets);
      }
      setError(null);
    } catch (e) {
      if (id === request.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void loadPage(null);
  }, [loadPage]);

  // A studio changes its key when it saves something: its folders are re-read
  // (a second or two) and the wall shows the new file.
  const seenKey = useRef(refreshKey);
  useEffect(() => {
    if (refreshKey === undefined || refreshKey === seenKey.current) return;
    seenKey.current = refreshKey;
    let live = true;
    void fetch("/api/library", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "scan", scope: "studios" }) })
      .then(() => { if (live) void loadPage(null); })
      .catch(() => {});
    return () => { live = false; };
  }, [refreshKey, loadPage]);

  useEffect(() => {
    if (active) void loadSummary();
  }, [active, loadSummary]);

  // While a scan runs the shelves fill in; when it ends, the wall catches up.
  const scanning = summary?.scan.state === "scanning";
  useEffect(() => {
    if (!scanning || !active) return;
    const t = setInterval(() => void loadSummary(), 3000);
    return () => clearInterval(t);
  }, [scanning, active, loadSummary]);
  const wasScanning = useRef(false);
  useEffect(() => {
    if (wasScanning.current && !scanning) void loadPage(null);
    wasScanning.current = scanning;
  }, [scanning, loadPage]);

  useEffect(() => {
    if (!active) stopSound();
  }, [active]);
  useEffect(() => () => stopSound(), []);

  // More posters as the end of the wall comes near.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !next) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && !loading) void loadPage(next);
    }, { rootMargin: "1400px" });
    io.observe(el);
    return () => io.disconnect();
  }, [next, loading, loadPage]);

  const rescan = async () => {
    await fetch("/api/library", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "scan" }) }).catch(() => {});
    void loadSummary();
  };

  const toggle = (k: keyof LibraryFilter, v: string | number) =>
    setFilter((f) => ({ ...f, [k]: f[k] === v ? undefined : v }));

  // The filters offered are the chosen shelf's, or every shelf's together.
  const colors = summary?.factionColors ?? {};
  const hasAny = (summary?.shelves ?? []).some((s) => s.count > 0);
  const filtered = Object.entries(filter).some(([k, v]) => v != null && v !== "" && !(lock && k in lock));
  const studioChips = !lock?.studio && (effective.project === "Hangar" || !!effective.studio) && facets.studios.length > 1;
  const rtsaiChips = effective.project === "RTSAI" && (facets.factions.length > 0 || facets.statuses.length > 0);

  return (
    <div className={`lib ${compact ? "is-compact" : ""}`}>
      <header className="lib-head">
        {!compact && <h1 className="lib-title">Library</h1>}
        <label className="lib-search">
          <Search size={18} aria-hidden="true" />
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Find by prompt, model or name" aria-label="Search prompts, models and names" />
          {text && <button type="button" onClick={() => setText("")} aria-label="Clear search"><X size={16} /></button>}
        </label>
        <div className="lib-head-side">
          {total != null && <span className="lib-total">{num(total)}</span>}
          {scanning ? (
            <span className="lib-scanning" title="Reading your folders"><LoaderCircle size={15} className="animate-spin" /> {num(summary?.scan.seen ?? 0)}</span>
          ) : !compact ? (
            <button type="button" className="lib-icon-button" onClick={() => void rescan()} title="Look for new files" aria-label="Look for new files"><RefreshCw size={16} /></button>
          ) : (
            <button type="button" className="lib-open" onClick={() => openLibrary({ ...(lock ?? {}), q: text.trim() || undefined })}>Open in Library <ArrowUpRight size={14} /></button>
          )}
        </div>
      </header>

      {!compact && (
        <section className="lib-shelves" aria-label="Shelves">
          {(summary?.shelves ?? []).map((s) => {
            const Icon = SHELF_ICON[s.id] ?? Layers;
            const on = effective.shelf === s.id;
            return (
              <button key={s.id} type="button" className={`lib-shelf ${on ? "is-on" : ""}`} aria-pressed={on}
                onClick={() => setFilter(on ? {} : { shelf: s.id })}>
                <span className="lib-shelf-mosaic" aria-hidden="true">
                  {Array.from({ length: 6 }, (_, i) => s.samples[i]).map((it, i) =>
                    it ? <img key={it.id} className={it.kind === "sound" ? "is-wave" : undefined} style={it.kind === "sound" ? { background: `hsl(${hueOf(it.project)} 34% 20%)` } : undefined}
                      src={previewUrl(it, it.kind === "sound" ? "wave" : "poster", 320)} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.visibility = "hidden"; }} /> : <span key={i} />,
                  )}
                </span>
                <span className="lib-shelf-label">
                  <Icon size={18} aria-hidden="true" />
                  <b>{s.label}</b>
                  <small>{num(s.count)}</small>
                </span>
              </button>
            );
          })}
        </section>
      )}

      {(hasAny || compact) && (
        <nav className="lib-chips" aria-label="Filters">
          {facets.kinds.length > 1 && facets.kinds.map((f) => {
            const Icon = KIND_ICON[f.value] ?? Layers;
            return <Chip key={`k-${f.value}`} on={effective.kind === f.value} onClick={() => toggle("kind", f.value)} count={f.count}><Icon size={14} />{KIND_LABEL[f.value] ?? f.value}</Chip>;
          })}
          {!lock?.project && facets.projects.length > 1 && <span className="lib-chip-gap" />}
          {!lock?.project && facets.projects.length > 1 && facets.projects.map((f) => (
            <Chip key={`p-${f.value}`} on={effective.project === f.value} onClick={() => toggle("project", f.value)} count={f.count}>
              <i className="lib-dot" style={{ background: `hsl(${hueOf(f.value)} 60% 55%)` }} />{f.value}
            </Chip>
          ))}
          <label className={`lib-chip lib-when ${effective.days ? "is-on" : ""}`}>
            <CalendarDays size={13} aria-hidden="true" />
            <select value={effective.days ?? ""} onChange={(e) => setFilter((f) => ({ ...f, days: Number(e.target.value) || undefined }))} aria-label="When">
              <option value="">Any time</option>
              {DATES.map(([label, days]) => <option key={days} value={days}>{label}</option>)}
            </select>
          </label>
          {filtered && <button type="button" className="lib-clear" onClick={() => { setFilter({}); setText(""); }}><X size={13} /> Clear</button>}
        </nav>
      )}

      {/* A project's own filters appear once it is chosen: Hangar's studios,
          RTS AI's factions and Faction Studio's verdicts. */}
      {(studioChips || rtsaiChips) && (
        <nav className="lib-chips is-sub" aria-label={`${effective.project ?? "Studio"} filters`}>
          {studioChips && facets.studios.map((f) => (
            <Chip key={`s-${f.value}`} on={effective.studio === f.value} onClick={() => toggle("studio", f.value)} count={f.count}>{STUDIO_LABEL[f.value] ?? f.value}</Chip>
          ))}
          {rtsaiChips && facets.factions.map((f) => (
            <Chip key={`f-${f.value}`} on={effective.faction === f.value} onClick={() => toggle("faction", f.value)} count={f.count}>
              <i className="lib-dot" style={{ background: colors[f.value] ?? "#888" }} />{titleCase(f.value)}
            </Chip>
          ))}
          {rtsaiChips && facets.statuses.length > 0 && <span className="lib-chip-gap" />}
          {rtsaiChips && facets.statuses.map((f) => (
            <Chip key={`r-${f.value}`} on={effective.status === f.value} onClick={() => toggle("status", f.value)} count={f.count}>
              <i className={`lib-status is-${f.value}`} />{STATUS_LABEL[f.value] ?? f.value}
            </Chip>
          ))}
        </nav>
      )}

      {error && <p className="lib-error" role="alert">{error}</p>}

      {!hasAny && summary && !compact && (
        <div className="lib-empty">
          {scanning ? <><LoaderCircle className="animate-spin" size={28} /><b>Reading your folders</b><span>{num(summary.scan.seen)} files so far</span></>
            : summary.roots.some((r) => r.present)
              ? <><Sparkles size={28} /><b>Nothing here yet</b><span>Pictures, clips, sounds and 3D models appear as soon as they are in your folders.</span></>
              : <><Database size={28} /><b>No media folders on this machine</b><span>List them in config/library.local.json (see library.example.json).</span></>}
        </div>
      )}

      <section className="lib-wall" aria-label="Poster wall" aria-busy={loading}>
        {items.map((it, i) => <Tile key={it.id} item={it} color={it.faction ? colors[it.faction] : undefined} onOpen={() => setOpenAt(i)} />)}
        {loading && !items.length && Array.from({ length: 18 }, (_, i) => <span key={i} className="lib-tile is-ghost" />)}
      </section>
      {!loading && hasAny && !items.length && <p className="lib-none">No match. Try fewer words or another shelf.</p>}
      <div ref={sentinel} className="lib-sentinel" />

      {openAt != null && items[openAt] && (
        <LibraryViewer
          items={items} index={openAt} colors={colors}
          onIndex={(i) => { setOpenAt(i); if (i >= items.length - 6 && next && !loading) void loadPage(next); }}
          onClose={() => setOpenAt(null)}
          onFilter={(f) => { setOpenAt(null); setFilter({ ...f }); setText(f.q ?? ""); }}
        />
      )}
    </div>
  );
}

function Chip({ on, onClick, count, children }: { on: boolean; onClick: () => void; count?: number; children: ReactNode }) {
  return (
    <button type="button" className={`lib-chip ${on ? "is-on" : ""}`} aria-pressed={on} onClick={onClick}>
      {children}{count != null && <small>{num(count)}</small>}
    </button>
  );
}

/** One poster on the wall. Clips scrub on hover, sounds play in place, models sway. */
function Tile({ item, color, onOpen }: { item: LibraryItem; color?: string; onOpen: () => void }) {
  const [sprite, setSprite] = useState<string | null>(null);
  const [frame, setFrame] = useState(-1);
  const [failed, setFailed] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const Icon = KIND_ICON[item.kind] ?? ImageIcon;

  const enter = () => {
    if (item.kind !== "video" || sprite) return;
    const url = previewUrl(item, "scrub", 480);
    const img = new window.Image();
    img.onload = () => setSprite(url);
    img.src = url;
  };
  const move = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (item.kind !== "video") return;
    const r = e.currentTarget.getBoundingClientRect();
    setFrame(Math.max(0, Math.min(11, Math.floor(((e.clientX - r.left) / r.width) * 12))));
  };
  const key = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpen();
    }
  };
  const play = (e: ReactMouseEvent) => {
    e.stopPropagation();
    if (nowPlaying()?.id === item.id) {
      stopSound();
      return;
    }
    const audio = new Audio(fileUrl(item));
    audio.addEventListener("timeupdate", () => setProgress(audio.duration ? audio.currentTime / audio.duration : 0));
    audio.addEventListener("ended", () => stopSound());
    playSound({ id: item.id, audio, stop: () => setProgress(null) });
    setProgress(0);
  };

  const style = { "--tile-hue": hueOf(item.project) } as CSSProperties;
  return (
    <div role="button" tabIndex={0} className={`lib-tile is-${item.kind}${frame >= 0 && sprite ? " is-scrubbing" : ""}`} style={style}
      onClick={onOpen} onKeyDown={key} onMouseEnter={enter} onMouseMove={move} onMouseLeave={() => setFrame(-1)}
      aria-label={item.prompt ? `${item.name}: ${item.prompt}` : item.name}>
      {item.kind === "sound" ? (
        <>
          <img className="lib-wave" src={previewUrl(item, "wave")} alt="" loading="lazy" onError={() => setFailed(true)} />
          {progress != null && <img className="lib-wave is-played" src={previewUrl(item, "wave")} alt="" style={{ clipPath: `inset(0 ${100 - progress * 100}% 0 0)` }} />}
          <button type="button" className="lib-play" onClick={play} aria-label={progress != null ? `Stop ${item.name}` : `Play ${item.name}`}>
            {progress != null ? <Pause size={22} /> : <Play size={22} />}
          </button>
          <span className="lib-sound-name">{item.name.replace(/\.[^.]+$/, "")}</span>
        </>
      ) : item.poster && !failed ? (
        <img className="lib-poster" src={previewUrl(item)} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
      ) : (
        <span className="lib-placeholder"><Icon size={34} />{item.kind === "collection" && <b>{titleCase(item.name)}</b>}</span>
      )}
      {item.kind === "video" && sprite && frame >= 0 && (
        <>
          <span className="lib-scrub" style={{ backgroundImage: `url(${sprite})`, backgroundPosition: `${(frame / 11) * 100}% 0` }} />
          <span className="lib-scrub-bar" style={{ width: `${((frame + 1) / 12) * 100}%` }} />
        </>
      )}
      <span className="lib-badges">
        {color && <i className="lib-faction" style={{ background: color }} />}
        {item.status && <i className={`lib-status is-${item.status}`} title={STATUS_LABEL[item.status]} />}
        {item.kind !== "image" && item.kind !== "sound" && <span className="lib-kind"><Icon size={13} />{item.kind === "collection" && item.count != null ? num(item.count) : null}</span>}
      </span>
      {item.kind !== "sound" && (item.prompt || item.kind === "video" || item.kind === "collection") && (
        <span className="lib-caption">{item.prompt ?? item.name.replace(/\.[^.]+$/, "")}</span>
      )}
    </div>
  );
}
