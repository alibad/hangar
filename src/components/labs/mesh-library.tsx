"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Copy, Search, Wrench } from "lucide-react";
import Dialog, { buttonStyles } from "@/components/dialog";
import MeshViewer from "./mesh-viewer";
import type { MeshJobSummary, MeshJobsPage } from "@/app/api/labs/3d/jobs/route";

/**
 * Everything the 3D Lab has made, findable: search, sets, filters and a grid,
 * and one click opens the object in a 3D viewer with how it was made — the
 * prompt, the picture, the cutout and every mesh. Before this, the Lab showed
 * its last 24 jobs, and a click loaded a job into the form at the top of the
 * page, out of sight.
 */

type Job = MeshJobSummary;

const PAGE = 48;
const checker = { backgroundImage: "repeating-conic-gradient(rgb(128 128 128 / 0.12) 0 25%, transparent 0 50%)", backgroundSize: "14px 14px" };

/** The words before the style the prompt adds: "a cracked cup, a symbolic sculpture in…" → "a cracked cup". */
export function shortSubject(s: string): string {
  if (s.length <= 64) return s;
  const cut = s.search(/, (a |an )?(symbolic sculpture|miniature diorama|stylized character|ornate talisman|small architectural shrine|cute chunky)/);
  const head = cut > 12 ? s.slice(0, cut) : s.split(", ")[0];
  return head.length > 90 ? `${head.slice(0, 88)}…` : head;
}

function when(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (days < 1 && d.getDate() === new Date().getDate()) return `today ${time}`;
  if (days < 2) return `yesterday ${time}`;
  return d.toLocaleDateString([], { day: "numeric", month: "short", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

/** Fetch one page of the library. */
async function fetchPage(params: Record<string, string>): Promise<MeshJobsPage> {
  const r = await fetch(`/api/labs/3d/jobs?${new URLSearchParams(params)}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as MeshJobsPage;
}

// ── the full library ────────────────────────────────────────────────────────

export default function MeshLibrary({ refreshKey = 0, onOpenInLab }: { refreshKey?: number; onOpenInLab: (j: Job) => void }) {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"all" | "object" | "person">("all");
  const [meshedOnly, setMeshedOnly] = useState(false);
  const [group, setGroup] = useState("");
  const [page, setPage] = useState<MeshJobsPage | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openAt, setOpenAt] = useState<number | null>(null);
  const reqId = useRef(0);

  // Typing settles for a moment before it searches.
  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  const params = useMemo(() => {
    const p: Record<string, string> = { limit: String(PAGE) };
    if (query) p.q = query;
    if (kind !== "all") p.kind = kind;
    if (meshedOnly) p.has = "mesh";
    if (group) p.group = group;
    return p;
  }, [query, kind, meshedOnly, group]);

  const load = useCallback(
    async (offset: number) => {
      const id = ++reqId.current;
      setLoading(true);
      try {
        const p = await fetchPage({ ...params, offset: String(offset) });
        if (id !== reqId.current) return;
        setPage(p);
        setJobs((cur) => (offset === 0 ? p.jobs : [...cur, ...p.jobs.filter((j) => !cur.some((c) => c.id === j.id))]));
        setError(null);
      } catch (e) {
        if (id === reqId.current) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (id === reqId.current) setLoading(false);
      }
    },
    [params],
  );

  useEffect(() => {
    void load(0);
  }, [load, refreshKey]);

  const more = page ? page.total > jobs.length : false;
  const open = openAt != null ? jobs[openAt] : null;
  const step = (d: number) => {
    if (openAt == null) return;
    const next = openAt + d;
    if (next < 0) return;
    if (next >= jobs.length - 3 && more && !loading) void load(jobs.length);
    if (next < jobs.length) setOpenAt(next);
  };

  const inputCls = "rounded-md border border-gray-700 bg-gray-950 px-2 py-1.5 text-sm text-gray-100 outline-none placeholder:text-gray-600 focus:border-gray-500";
  const segCls = (on: boolean) => `px-2.5 py-1 ${on ? "bg-gray-700 text-gray-100" : "text-gray-400 hover:bg-gray-800"}`;

  return (
    <section className="space-y-4 rounded-xl border border-gray-800 bg-gray-900/40 p-4" data-testid="mesh-library">
      <div className="flex flex-wrap items-center gap-3">
        <label className="relative min-w-[14rem] flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-500" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search what was made: lotus, monk, tank, ladder…"
            aria-label="Search the library"
            className={`${inputCls} w-full pl-7`}
          />
        </label>
        <select value={group} onChange={(e) => setGroup(e.target.value)} className={inputCls} aria-label="Set">
          <option value="">All sets</option>
          <option value="none">Made by hand in the Lab</option>
          {page?.groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.label} ({g.count})
            </option>
          ))}
        </select>
        <div className="flex overflow-hidden rounded-md border border-gray-800 text-[11px]" role="radiogroup" aria-label="Kind">
          {(["all", "object", "person"] as const).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)} className={segCls(kind === k)}>
              {k === "all" ? "All" : k === "object" ? "Objects" : "People"}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-xs text-gray-400">
          <input type="checkbox" checked={meshedOnly} onChange={(e) => setMeshedOnly(e.target.checked)} className="accent-orange-500" />
          Has a 3D model
        </label>
        <span className="ml-auto text-[11px] tabular-nums text-gray-500">
          {page ? (page.total === page.all ? `${page.all.toLocaleString()} made` : `${page.total.toLocaleString()} of ${page.all.toLocaleString()}`) : "Loading…"}
        </span>
      </div>

      {error && <p className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-300">Could not load the library: {error}</p>}

      {page && jobs.length === 0 && !loading ? (
        <p className="py-10 text-center text-sm text-gray-500">Nothing matches. Try fewer words, or All sets.</p>
      ) : (
        <JobGrid jobs={jobs} onOpen={setOpenAt} />
      )}

      {more && (
        <div className="flex justify-center">
          <button type="button" onClick={() => void load(jobs.length)} disabled={loading} className={buttonStyles.secondarySm}>
            {loading ? "Loading…" : `Show ${Math.min(PAGE, (page?.total ?? 0) - jobs.length)} more`}
          </button>
        </div>
      )}

      <JobDialog
        job={open}
        position={openAt != null && page ? `${openAt + 1} of ${page.total.toLocaleString()}` : ""}
        onClose={() => setOpenAt(null)}
        onPrev={openAt ? () => step(-1) : undefined}
        onNext={openAt != null && (openAt < jobs.length - 1 || more) ? () => step(1) : undefined}
        onOpenInLab={(j) => {
          setOpenAt(null);
          onOpenInLab(j);
        }}
      />
    </section>
  );
}

// ── the last few, under the Make form ───────────────────────────────────────

/** The newest jobs, a click from the 3D viewer, with the way into the full library. */
export function RecentJobs({
  refreshKey = 0,
  current,
  onOpenInLab,
  onShowAll,
}: {
  refreshKey?: number;
  current: string | null;
  onOpenInLab: (j: Job) => void;
  onShowAll: () => void;
}) {
  const [page, setPage] = useState<MeshJobsPage | null>(null);
  const [openAt, setOpenAt] = useState<number | null>(null);
  useEffect(() => {
    fetchPage({ limit: "12" })
      .then(setPage)
      .catch(() => {
        /* history; the Lab works without it */
      });
  }, [refreshKey]);
  if (!page || page.jobs.length === 0) return null;
  const jobs = page.jobs;
  return (
    <div className="space-y-3 rounded-lg border border-gray-800 p-3">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400">Recently made</h3>
        <span className="text-[11px] text-gray-500">Click one to orbit it in 3D.</span>
        <button type="button" onClick={onShowAll} className="ml-auto text-xs text-orange-300 hover:text-orange-200">
          All {page.all.toLocaleString()} in the library →
        </button>
      </div>
      <JobGrid jobs={jobs} current={current} onOpen={setOpenAt} dense />
      <JobDialog
        job={openAt != null ? jobs[openAt] : null}
        position={openAt != null ? `${openAt + 1} of ${jobs.length} recent` : ""}
        onClose={() => setOpenAt(null)}
        onPrev={openAt ? () => setOpenAt(openAt - 1) : undefined}
        onNext={openAt != null && openAt < jobs.length - 1 ? () => setOpenAt(openAt + 1) : undefined}
        onOpenInLab={(j) => {
          setOpenAt(null);
          onOpenInLab(j);
        }}
      />
    </div>
  );
}

// ── shared pieces ───────────────────────────────────────────────────────────

function JobGrid({ jobs, current, onOpen, dense }: { jobs: Job[]; current?: string | null; onOpen: (i: number) => void; dense?: boolean }) {
  return (
    <div className={`grid gap-3 ${dense ? "grid-cols-3 sm:grid-cols-4 lg:grid-cols-6" : "grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6"}`}>
      {jobs.map((j, i) => (
        <button
          key={j.id}
          type="button"
          onClick={() => onOpen(i)}
          title={j.subject}
          className={`group relative min-w-0 rounded-lg border p-1.5 text-left transition hover:border-gray-500 hover:bg-gray-800/40 ${j.id === current ? "border-emerald-600" : "border-gray-800"}`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={j.cutoutUrl ?? j.sourceUrl} alt="" loading="lazy" className="aspect-square w-full rounded object-contain" style={checker} />
          <span className="absolute left-2.5 top-2.5 flex gap-1">
            {j.meshes.length > 0 ? (
              <span className="rounded bg-emerald-900/80 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-emerald-100">3D</span>
            ) : (
              <span className="rounded bg-gray-950/80 px-1 py-0.5 text-[9px] uppercase tracking-wide text-gray-300">picture only</span>
            )}
            {j.kind === "person" && <span className="rounded bg-gray-950/80 px-1 py-0.5 text-[9px] uppercase tracking-wide text-orange-200">person</span>}
          </span>
          <span className="mt-1 line-clamp-2 text-[11px] leading-snug text-gray-200">{shortSubject(j.subject)}</span>
          <span className="block truncate text-[10px] text-gray-500">
            {j.groupLabel ?? "Made in the Lab"} · {when(j.createdAt)}
          </span>
        </button>
      ))}
    </div>
  );
}

const meshLabel = (m: Job["meshes"][number]) =>
  `${m.model}${m.resolution != null ? ` @${m.resolution}` : ""}${m.seed != null ? ` · seed ${m.seed}` : ""}${m.latencyMs != null ? ` · ${m.latencyMs < 10_000 ? (m.latencyMs / 1000).toFixed(1) : Math.round(m.latencyMs / 1000)}s` : ""}`;

/** One job, in 3D, with how it was made. ← and → step through the grid it came from. */
function JobDialog({
  job,
  position,
  onClose,
  onPrev,
  onNext,
  onOpenInLab,
}: {
  job: Job | null;
  position: string;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  onOpenInLab: (j: Job) => void;
}) {
  const [file, setFile] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    setFile(job?.meshes[job.meshes.length - 1]?.file ?? null);
    setCopied(false);
  }, [job]);
  useEffect(() => {
    if (!job) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest("input, textarea, select")) return;
      if (e.key === "ArrowLeft" && onPrev) onPrev();
      if (e.key === "ArrowRight" && onNext) onNext();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [job, onPrev, onNext]);

  const mesh = job?.meshes.find((m) => m.file === file) ?? null;
  const prompt = job?.prompt ?? job?.subject ?? "";
  const navBtn = "rounded-md border border-gray-700 p-1 text-gray-300 hover:bg-gray-800 disabled:opacity-30";

  return (
    <Dialog
      open={!!job}
      onClose={onClose}
      size="xl"
      title={job ? shortSubject(job.subject) : ""}
      subtitle={
        job && (
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{job.groupLabel ?? "Made in the Lab"}</span>
            <span className="text-gray-500">{when(job.createdAt)}</span>
            <span className="ml-auto flex items-center gap-2 text-xs text-gray-500">
              <button type="button" onClick={onPrev} disabled={!onPrev} className={navBtn} aria-label="Previous">
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="tabular-nums">{position}</span>
              <button type="button" onClick={onNext} disabled={!onNext} className={navBtn} aria-label="Next">
                <ChevronRight className="h-4 w-4" />
              </button>
            </span>
          </span>
        )
      }
    >
      {job && (
        <div className="grid gap-5 md:grid-cols-[3fr_2fr]" data-testid="mesh-detail">
          <div className="min-w-0">
            {mesh ? (
              <MeshViewer key={mesh.url} url={mesh.url} downloadName={`${shortSubject(job.subject).replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${mesh.file}`} />
            ) : (
              <div className="space-y-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={job.cutoutUrl ?? job.sourceUrl} alt="" className="aspect-square w-full rounded-lg border border-gray-800 object-contain" style={checker} />
                <p className="text-xs text-gray-400">No 3D model yet. Open it in the Lab to cut it out and mesh it.</p>
              </div>
            )}
          </div>
          <div className="min-w-0 space-y-4 text-sm">
            {job.meshes.length > 1 && (
              <div className="space-y-1.5">
                <h4 className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Meshes ({job.meshes.length})</h4>
                <div className="flex flex-wrap gap-1.5">
                  {job.meshes.map((m) => (
                    <button
                      key={m.file}
                      type="button"
                      aria-pressed={m.file === file}
                      onClick={() => setFile(m.file)}
                      className={`rounded-full border px-2 py-0.5 text-[11px] ${m.file === file ? "border-emerald-600 bg-emerald-900/30 text-emerald-200" : "border-gray-700 text-gray-400 hover:bg-gray-800"}`}
                    >
                      {meshLabel(m)}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {mesh && job.meshes.length === 1 && <p className="text-[11px] text-gray-500">{meshLabel(mesh)}</p>}

            <div className="space-y-1.5">
              <h4 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                {job.prompt ? "Prompt sent to the image model" : "Subject"}
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard?.writeText(prompt).then(() => setCopied(true));
                  }}
                  className="flex items-center gap-1 rounded px-1 py-0.5 text-[10px] font-normal normal-case tracking-normal text-gray-400 hover:bg-gray-800"
                >
                  <Copy className="h-3 w-3" /> {copied ? "copied" : "copy"}
                </button>
              </h4>
              <p className="whitespace-pre-wrap rounded-lg border border-gray-800 bg-gray-950/60 px-3 py-2 text-xs leading-relaxed text-gray-300">{prompt}</p>
            </div>

            <div className="flex gap-3">
              <figure className="w-1/2 min-w-0">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={job.sourceUrl} alt="Picture" className="aspect-square w-full rounded-lg border border-gray-800 object-cover" />
                <figcaption className="mt-1 truncate text-[10px] text-gray-500" title={job.sourceNote}>
                  Picture · {job.sourceNote}
                </figcaption>
              </figure>
              <figure className="w-1/2 min-w-0">
                {job.cutoutUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={job.cutoutUrl} alt="Cutout" className="aspect-square w-full rounded-lg border border-gray-800 object-contain" style={checker} />
                ) : (
                  <div className="grid aspect-square w-full place-items-center rounded-lg border border-dashed border-gray-800 px-3 text-center text-[11px] text-gray-500">
                    No cutout: the mesh model matted the whole picture.
                  </div>
                )}
                <figcaption className="mt-1 truncate text-[10px] text-gray-500" title={job.cutoutNote ?? undefined}>
                  {job.cutoutNote ? `Cutout · ${job.cutoutNote}` : "Cutout"}
                </figcaption>
              </figure>
            </div>

            <div className="flex flex-wrap items-center gap-2 border-t border-gray-800 pt-3">
              <button type="button" onClick={() => onOpenInLab(job)} className={buttonStyles.secondarySm}>
                <Wrench className="h-3.5 w-3.5" /> Open in the Lab
              </button>
              <span className="text-[11px] text-gray-500">to cut it again or mesh it with another model.</span>
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}
