"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Archive, ArrowRight, Check, Folder, GitCommitHorizontal, Layers, Pin, X } from "lucide-react";
import "./session-library.css";
import HangarLoading from "./hangar-loading";
import { ProjectBadge, ProjectList } from "./project-identity";
import AgentMark from "./agent-mark";
import SessionReviews, { NAME, reviewLabel, type Review } from "./session-reviews";

export type LibrarySession = {
  id: string; key: string; provider: string; model: string; title: string; updatedAt: string; activityAt: string;
  state: string; summary: string; canResume: boolean; idleDays: number | null; unread: boolean | null;
  reviewed: boolean; group: string | null; nativeGroup: string | null; nativeKnown: boolean; pinned: boolean;
  archived: boolean; archiveScope: "hangar" | "codex" | "claude" | null; protected: boolean; reviewDue: boolean; snoozedUntil: string | null;
  /** The Claude app's one-line status of the last turn (completed, blocked on you, or ready for review), when it is current. */
  status?: { category: string; detail: string; needsAction: string } | null;
  /** A Hangar job is running in it, or its app shows a turn that has not ended and is still writing. */
  working?: boolean;
  projects: { id: string; name: string; evidence: string; files: string[] }[];
  suggestion: { id: string; name: string; reason: string; confidence: string } | null;
  /** Where Open takes it: its desktop app when the app can show it, otherwise a terminal. */
  opensIn?: "app" | "terminal";
  /** A scripted run in the system temp folder that edited no project: a test, not your work. */
  probe?: boolean;
  /** What it committed, newest first, with how Hangar knows. */
  changed?: { sha: string; subject: string; repo: string; repoId?: string; at: string; evidence: string }[];
  changedCount?: number;
  /** Helper agents it started (Claude); their edits and commits count as its own. */
  helpers?: number;
};
type Group = { id: string; name: string; source: string; nativeId?: string };
export type SessionLibraryData = { sessions: LibrarySession[]; groups: Group[]; idleDays: number; nativeAvailable: boolean; reviewCount: number; unreadReviewCount: number; claudeApp?: boolean; truncated: boolean; observedAt: string };
type Props = { machine: string; data: SessionLibraryData | null; error: string; onUpdate: (data: SessionLibraryData) => void; onContinue: (session: LibrarySession) => void; onOpen?: (session: LibrarySession) => void };
type Mode = "active" | "projects" | "review" | "groups" | "archived";
type Agent = "all" | "claude" | "codex";
const DAY = 86400000;
const agentOf = (s: LibrarySession) => s.provider === "codex" ? "codex" : "claude";
const appOf = (s: LibrarySession) => s.provider === "codex" ? "Codex" : "Claude";
/** Clean-up groups by how long a session has sat untouched, oldest first. */
const AGES = [{ id: "90", name: "Over 3 months", min: 90 }, { id: "60", name: "2–3 months", min: 60 }, { id: "30", name: "1–2 months", min: 30 }, { id: "14", name: "2–4 weeks", min: 14 }, { id: "7", name: "1–2 weeks", min: 0 }];
const STATUS: Record<string, string> = { completed: "Done", blocked: "Waiting on you", review_ready: "Ready for your review" };
/** Sessions to look at before any clean-up: a reply you have not opened, or a turn that stopped to ask you something. */
const held = (s: LibrarySession) => s.unread === true || s.status?.category === "blocked";
type Section = { id: string; name: string; rows: LibrarySession[]; all: LibrarySession[]; bulk?: boolean };
function cleanupSections(list: LibrarySession[], expanded: string[]): Section[] {
  const out: Section[] = [];
  const add = (id: string, name: string, all: LibrarySession[], bulk: boolean) => {
    if (all.length) out.push({ id, name, all, bulk, rows: expanded.includes(id) ? all : all.slice(0, 5) });
  };
  add("held", "Unread or waiting on you · look first", list.filter(held), false);
  const rest = list.filter(s => !held(s)).sort((a, b) => (b.idleDays || 0) - (a.idleDays || 0));
  AGES.forEach((age, i) => add(age.id, age.name, rest.filter(s => (s.idleDays || 0) >= age.min && (i === 0 || (s.idleDays || 0) < AGES[i - 1].min)), true));
  return out;
}
const lastSeen = (s: LibrarySession) => Date.parse(s.activityAt || s.updatedAt) || 0;
const ago = (t: number) => { const d = Math.floor((Date.now() - t) / DAY); return !t ? "unknown" : d <= 0 ? "today" : d === 1 ? "yesterday" : `${d}d ago`; };
/** Each project with its Claude and Codex sessions, most recently active first: where the two agents' work meets. */
function projectLanes(rows: LibrarySession[]) {
  const map = new Map<string, { id: string; name: string; sessions: LibrarySession[]; claude: number; codex: number; last: number }>();
  for (const s of rows) if (!s.archived) for (const p of s.projects) {
    const lane = map.get(p.id) || { id: p.id, name: p.name, sessions: [], claude: 0, codex: 0, last: 0 };
    lane.sessions.push(s); lane[agentOf(s)]++; lane.last = Math.max(lane.last, lastSeen(s));
    map.set(p.id, lane);
  }
  return [...map.values()].sort((a, b) => b.last - a.last);
}

async function request<T>(url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { method: body ? "POST" : "GET", cache: "no-store", signal,
    headers: body ? { "Content-Type": "application/json", "X-Hangar": "1" } : undefined,
    body: body ? JSON.stringify(body) : undefined });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Session library unavailable.");
  return result;
}

export default function SessionLibrary({ machine, data, error: loadError, onUpdate, onContinue, onOpen }: Props) {
  const [mode, setMode] = useState<Mode>("active");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState<{ key: string; purpose: "archive" | "group" } | null>(null);
  const [chosenGroup, setChosenGroup] = useState("");
  const [limit, setLimit] = useState(40);
  const [selectedKey, setSelectedKey] = useState("");
  const [agent, setAgent] = useState<Agent>("all");
  const [project, setProject] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [reviewedOnly, setReviewedOnly] = useState(false);
  /** Each session's latest code review, so the list shows which sessions the other agent has checked. */
  const [latestReview, setLatestReview] = useState<Map<string, Review>>(new Map());
  const [showProbes, setShowProbes] = useState(false);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [bulk, setBulk] = useState<{ name: string; rows: LibrarySession[] } | null>(null);
  const [alsoCodex, setAlsoCodex] = useState(true);
  const dialog = useRef<HTMLElement>(null);
  const detail = useRef<HTMLElement>(null);
  const updateRef = useRef(onUpdate); updateRef.current = onUpdate;
  const busyRef = useRef(false);
  const endpoint = `/api/world/${machine}/proxy/sessions/library`;
  const everything = data?.sessions || [];
  const probes = everything.filter(s => s.probe).length;
  const rows = useMemo(() => showProbes ? everything : everything.filter(s => !s.probe), [everything, showProbes]);
  const targetRow = rows.find(s => s.key === target?.key);

  useEffect(() => {
    const controller = new AbortController();
    let inflight = false;
    const refresh = async () => {
      if (inflight || busyRef.current || document.hidden) return;
      inflight = true;
      try { const result = await request<SessionLibraryData>(endpoint, undefined, controller.signal); if (!controller.signal.aborted) { updateRef.current(result); setError(""); } }
      catch (e) { if (!controller.signal.aborted) setError((e as Error).message); }
      finally { inflight = false; }
    };
    const timer = setInterval(refresh, 60000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [endpoint]);

  useEffect(() => {
    let live = true;
    fetch(`/api/world/${machine}/proxy/reviews`, { cache: "no-store" }).then(r => r.ok ? r.json() : null).then((data: { reviews: Review[] } | null) => {
      if (!live || !data) return;
      const latest = new Map<string, Review>();
      for (const r of data.reviews) if (!latest.has(r.session)) latest.set(r.session, r);  // newest first
      setLatestReview(latest);
    }).catch(() => { /* the list still works without review badges */ });
    return () => { live = false; };
  }, [machine]);
  const onReviews = (key: string, list: Review[]) => setLatestReview(map => {
    if (map.get(key) === list[0] || (!list[0] && !map.has(key))) return map;
    const next = new Map(map);
    if (list[0]) next.set(key, list[0]); else next.delete(key);
    return next;
  });

  useEffect(() => {
    if (!target && !bulk) return;
    const previous = document.activeElement as HTMLElement | null;
    const el = dialog.current;
    const controls = () => [...el?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),a[href]') || []];
    controls()[0]?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) { setTarget(null); setBulk(null); }
      if (event.key === "Tab") {
        const list = controls(), first = list[0], last = list.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    el?.addEventListener("keydown", key);
    return () => { el?.removeEventListener("keydown", key); previous?.focus(); };
  }, [target, bulk]);

  async function act(body: Record<string, unknown>, message: string | ((result: Record<string, number>) => string)) {
    if (busyRef.current) return false;
    busyRef.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const result = await request<Record<string, number>>(endpoint, body);
      const next = await request<SessionLibraryData>(endpoint);
      onUpdate(next); setNotice(typeof message === "function" ? message(result) : message); return true;
    } catch (e) { setError((e as Error).message); return false; }
    finally { setBusy(false); busyRef.current = false; }
  }
  function chooseMode(next: Mode, group = "") { setMode(next); setFilter(group); setLimit(40); }
  const lanes = useMemo(() => projectLanes(rows), [rows]);
  const laneOf = useMemo(() => new Map(lanes.map(l => [l.id, l])), [lanes]);
  const openProject = (id: string) => { setProject(id); setMode("active"); setFilter(""); setLimit(40); setSelectedKey(""); };
  const visible = useMemo(() => {
    let list = rows.filter(s => mode === "archived" ? s.archived : !s.archived && (mode !== "review" || s.reviewDue));
    if (filter) list = list.filter(s => filter.startsWith("suggestion:") ? s.suggestion?.id === filter.slice(11) : s.group === filter);
    if (query.trim()) { const q = query.toLowerCase(); list = list.filter(s => [s.title, s.provider, s.model, ...s.projects.map(p => p.name)].join(" ").toLowerCase().includes(q)); }
    if (agent !== "all") list = list.filter(s => agentOf(s) === agent);
    if (project) list = [...list.filter(s => s.projects.some(p => p.id === project))].sort((a, b) => lastSeen(b) - lastSeen(a));
    if (unreadOnly) list = list.filter(s => s.unread === true);
    if (reviewedOnly) list = list.filter(s => latestReview.has(s.key));
    return list;
  }, [rows, mode, filter, query, agent, project, unreadOnly, reviewedOnly, latestReview]);
  // Active work reads by topic; clean-up reads by age, oldest first; the archive stays one queue.
  const sections = useMemo<Section[]>(() => {
    if (mode === "review") return cleanupSections(visible, expanded);
    const shown = visible.slice(0, limit);
    if (mode !== "active" || filter || project) return [{ id: "all", name: "", rows: shown, all: shown }];
    const topics = new Map<string, Section>();
    for (const row of shown) {
      const id = row.group ? `group:${row.group}` : row.suggestion ? `suggestion:${row.suggestion.id}` : "other";
      const name = row.group ? data?.groups.find(g => g.id === row.group)?.name || "Group"
        : row.suggestion ? `${row.suggestion.name} · suggested` : "Other sessions";
      if (!topics.has(id)) { const list: LibrarySession[] = []; topics.set(id, { id, name, rows: list, all: list }); }
      topics.get(id)!.rows.push(row);
    }
    return [...topics.values()].sort((a, b) => Number(a.id === "other") - Number(b.id === "other"));
  }, [visible, limit, mode, filter, project, data, expanded]);
  const selected = visible.find(row => row.key === selectedKey) ?? sections[0]?.rows[0] ?? null;
  const pick = (key: string) => {
    setSelectedKey(key);
    requestAnimationFrame(() => { if (window.matchMedia("(max-width: 1000px)").matches) detail.current?.scrollIntoView({ block: "start", behavior: "smooth" }); });
  };
  const proposals = useMemo(() => {
    const map = new Map<string, { id: string; name: string; count: number; strong: number }>();
    for (const row of rows) if (row.suggestion) {
      const s = row.suggestion;
      const group = map.get(s.id) || { id: s.id, name: s.name, count: 0, strong: 0 };
      group.count++; group.strong += Number(s.confidence === "strong"); map.set(s.id, group);
    }
    return [...map.values()].sort((a, b) => b.count - a.count);
  }, [rows]);

  return <section className="sl-library" aria-label="Session organization">
    <div className="cw-section-title"><h2>Session history</h2><span>Claude + Codex</span></div>
    <div className="sl-toolbar"><div className="cw-family-tabs" aria-label="Session view">{([['active', 'Active'], ['projects', 'By project'], ['review', 'Clean up'], ['groups', 'Groups & sections'], ['archived', 'Archived']] as const).map(([id, label]) => <button key={id} aria-pressed={mode === id} onClick={() => chooseMode(id)}>{label}{id === "review" && !!data?.reviewCount && <small>{data.reviewCount}</small>}</button>)}</div></div>
    {(loadError || error) && <p className="cw-error" role="alert">{error || loadError}</p>}
    {notice && <p className="sl-notice" role="status"><Check size={15} />{notice}</p>}
    {!data ? <HangarLoading label="Reading session history" steps={["Indexing Claude Code sessions", "Indexing Codex sessions", "Grouping them by project"]} shape="rows" /> : <>
      {!data.nativeAvailable && <p className="cw-muted">Codex section and read state are unavailable on this machine. Hangar groups still work.</p>}
      {data.truncated && <p className="cw-muted">This is a bounded index; older sessions may be outside this scan.</p>}
      {(mode === "active" || mode === "projects") && <Overview rows={rows} lanes={lanes} />}
      <div className={`sl-main ${mode === "groups" || mode === "projects" ? "is-scroll" : ""}`}>
      {mode === "groups" ? <>
        <div className="sl-group-heading"><div><h3>One set of groups. Both agents.</h3><p>Codex sections appear as they are. Claude joins the same structure through Hangar.</p></div><form onSubmit={async e => { e.preventDefault(); if (await act({ action: "createGroup", name }, "Hangar group created.")) setName(""); }}><label className="sr-only" htmlFor="sl-group-name">New group name</label><input id="sl-group-name" placeholder="New group name" value={name} maxLength={80} onChange={e => setName(e.target.value)} required /><button disabled={busy || !name.trim()}>Create group</button></form></div>
        <div className="sl-groups">{data.groups.map(group => {
          const members = rows.filter(s => s.group === group.id && !s.archived);
          return <button className="sl-group" key={group.id} onClick={() => chooseMode("active", group.id)}><div className="sl-group-top"><Folder size={20} /><span>{group.source === "codex" ? "Codex section" : "Hangar group"}</span><b>{members.length}</b></div><h3>{group.name}</h3><div className="sl-group-members">{members.slice(0, 3).map(s => <span key={s.key}><i>{s.provider === "codex" ? "CX" : "CL"}</i><span>{s.title}</span>{s.unread && <b aria-label="Unread">●</b>}</span>)}{!members.length && <span className="cw-muted">Ready for sessions</span>}</div><footer>{members.filter(s => s.provider === "claude").length} Claude · {members.filter(s => s.provider === "codex").length} Codex <ArrowRight size={15} /></footer></button>;
        })}</div>
        <div className="sl-group-heading"><div><h3>Suggested connections</h3><p>Work topics are suggested from session titles on this machine. Ambiguous titles fall back to file or folder evidence. Review each reason before accepting.</p></div></div>
        <div className="sl-suggestions">{proposals.map(p => <button key={p.id} onClick={() => chooseMode("active", `suggestion:${p.id}`)}><Layers size={19} /><span><b>{p.name}</b><small>{p.count} sessions · {p.strong} with confirmed edits</small></span><span>Review <ArrowRight size={15} /></span></button>)}</div>{!proposals.length && <p className="cw-muted">No unassigned sessions have a clear project match.</p>}
      </> : mode === "projects" ? <ProjectLanes lanes={lanes} onOpen={openProject} /> : <>
        <div className="sl-list-heading"><label><span className="sr-only">Find a session</span><input type="search" placeholder="Find a session or project…" value={query} onChange={e => { setQuery(e.target.value); setLimit(40); }} /></label><div className="sl-seg" role="group" aria-label="Agent">{([["all", "All"], ["claude", "Claude"], ["codex", "Codex"]] as const).map(([id, label]) => <button key={id} aria-pressed={agent === id} onClick={() => { setAgent(id); setLimit(40); }}>{id !== "all" && <i className={`sl-swatch is-${id}`} aria-hidden="true" />}{label}</button>)}</div>
          <button className="sl-toggle" aria-pressed={unreadOnly} onClick={() => setUnreadOnly(v => !v)}>Unread</button>
          {(latestReview.size > 0 || reviewedOnly) && <button className="sl-toggle" aria-pressed={reviewedOnly} title="Sessions whose work the other agent has reviewed" onClick={() => { setReviewedOnly(v => !v); setLimit(40); }}>Reviewed <small>{latestReview.size}</small></button>}
          {project && <button className="sl-chip" onClick={() => setProject("")} title="Show every project"><ProjectBadge id={project} name={laneOf.get(project)?.name || project} size="xs" /><X size={13} /></button>}
          <span>{visible.length} sessions</span>{probes > 0 && <button className="sl-toggle" aria-pressed={showProbes} title="Scripted runs in a temp folder that edited no project" onClick={() => setShowProbes(v => !v)}>{showProbes ? "Hide" : "Show"} {probes} test {probes === 1 ? "run" : "runs"}</button>}{filter && <button onClick={() => setFilter("")}>Clear group filter <X size={14} /></button>}</div>
        {mode === "review" && <p className="sl-help">Sessions untouched for {data.idleDays}+ days, oldest first. Archive a whole age group at once, or open one to decide. Unread sessions and ones waiting on you stay at the top and are never archived in bulk; pinned sessions and projects with a running job are left alone.</p>}
        {!!visible.length && <div className="sl-inbox">
          <div className="sl-list" aria-label="Sessions">
            {sections.map(section => <div className="sl-section" key={section.id}>
              {section.name && <h4><span>{section.name}</span><small>{section.all.length}</small>{section.bulk && <button className="sl-bulk" disabled={busy} title={`Archive the ${section.all.length} sessions in this group`} onClick={() => { setAlsoCodex(true); setBulk({ name: section.name, rows: section.all }); }}><Archive size={12} aria-hidden="true" />Archive all</button>}</h4>}
              {section.rows.map(row => <button type="button" key={row.key} aria-pressed={selected?.key === row.key} className={`sl-row ${row.unread ? "sl-unread" : ""}`} onClick={() => pick(row.key)}>
                <span className={`cw-session-provider is-${agentOf(row)}`}><AgentMark agent={agentOf(row)} /></span>
                <span className="sl-row-text"><b>{row.title}</b>{row.status?.detail ? <em className={`sl-changed sl-row-status is-${row.status.category}`} title={STATUS[row.status.category] || "Last turn"}><span className="sl-status-dot" aria-hidden="true" />{row.status.detail}</em> : !!row.changed?.length && <em className="sl-changed"><GitCommitHorizontal size={12} aria-hidden="true" />{row.changed[0].subject}{(row.changedCount || 0) > 1 && <i>+{(row.changedCount || 0) - 1}</i>}</em>}<small className="sl-row-meta"><ProjectList projects={row.projects} />{[row.idleDays === null ? "" : row.idleDays === 0 ? "today" : `${row.idleDays}d idle`, row.archived ? "archived" : ""].filter(Boolean).map(part => <span key={part}>{part}</span>)}</small></span>
                {(() => { const r = latestReview.get(row.key); return r && <span className={`sl-review is-${r.state === "done" ? r.verdict : r.state}`} title={`${NAME[r.reviewer]} reviewed this session’s work: ${reviewLabel(r)}`}><AgentMark agent={r.reviewer} />{reviewLabel(r)}</span>; })()}
                {row.working ? <span className="sl-flag is-live">Working</span> : row.status?.category === "blocked" && <span className="sl-flag is-wait">Needs you</span>}
                {row.unread === true && <i className="sl-dot" aria-label={`Unread in ${appOf(row)}`} />}
                {row.pinned && <Pin size={13} aria-label="Pinned in Codex" />}
              </button>)}
              {section.all.length > section.rows.length && <button className="sl-more sl-more-inline" onClick={() => setExpanded(list => [...list, section.id])}>Show all {section.all.length}</button>}
            </div>)}
            {mode !== "review" && visible.length > limit && <button className="sl-more" onClick={() => setLimit(n => n + 40)}>Show 40 more sessions</button>}
          </div>
          {selected && <article ref={detail} className={`sl-detail sl-session ${selected.unread ? "sl-unread" : ""}`} aria-label={`Session: ${selected.title}`}>
            <div className="sl-session-body"><div className="sl-session-title"><h3>{selected.title}</h3>{selected.pinned && <Pin size={14} aria-label="Pinned in Codex" />}</div>
            <div className="sl-tags">{selected.working && <span className="is-live">Working now</span>}{selected.unread === true && <span className="is-unread">{selected.provider === "codex" ? "Unread in Codex" : "New reply you haven’t opened"}</span>}{selected.unread === false && <span>Read</span>}{selected.reviewed && <span>Kept after archive check</span>}<span>{selected.idleDays === null ? "Activity unknown" : selected.idleDays === 0 ? "Active today" : `${selected.idleDays}d idle`}</span>{selected.group && <span>{data.groups.find(g => g.id === selected.group)?.name}</span>}{selected.protected && <span>Active project · protected</span>}{selected.archived && <span>Archived in {selected.archiveScope === "codex" ? "Codex" : selected.archiveScope === "claude" ? "the Claude app" : "Hangar"}</span>}</div>
            {selected.status && (selected.status.detail || selected.status.needsAction) && <div className={`sl-status is-${selected.status.category}`} aria-label="Where the session stands">
              <span className="sl-status-label"><span className="sl-status-dot" aria-hidden="true" />{STATUS[selected.status.category] || "Last turn"}</span>
              {selected.status.detail && <p>{selected.status.detail}</p>}
              {selected.status.needsAction && selected.status.needsAction !== selected.status.detail && <p className="sl-needs"><b>Needs you:</b> {selected.status.needsAction}</p>}
            </div>}
            <p>{selected.summary}</p>
            {!!selected.changed?.length && <div className="sl-commits" aria-label="What this session committed"><h4>What it changed<small>{selected.changedCount} {selected.changedCount === 1 ? "commit" : "commits"}</small></h4><ol>{selected.changed.map(c => <li key={`${c.repo}-${c.sha}`}><GitCommitHorizontal size={14} aria-hidden="true" /><span><b>{c.subject}</b><small>{c.repo} · {new Date(c.at).toLocaleDateString(undefined, { day: "numeric", month: "short" })} {new Date(c.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })} · <code>{c.sha}</code></small></span></li>)}</ol>{(selected.changedCount || 0) > selected.changed.length && <small>{(selected.changedCount || 0) - selected.changed.length} more in the last 30 days</small>}</div>}
            <SessionReviews key={selected.key} machine={machine} session={selected} onReviews={onReviews} />
            {selected.projects.length > 0 && <div className="sl-connect" aria-label="This session's projects">{selected.projects.map(p => { const lane = laneOf.get(p.id); return <button key={p.id} onClick={() => openProject(p.id)} aria-pressed={project === p.id} title={`Every session in ${p.name}`}>
              <ProjectBadge id={p.id} name={p.name} detail /><span className="sl-count"><i className="sl-swatch is-claude" aria-hidden="true" />{lane?.claude || 0}<small>Claude</small></span><span className="sl-count"><i className="sl-swatch is-codex" aria-hidden="true" />{lane?.codex || 0}<small>Codex</small></span><ArrowRight size={13} /></button>; })}</div>}
            <details><summary>File evidence & session ID</summary><code>{selected.id}</code>{selected.projects.map(p => {
              const files = [...new Set(p.files)];
              return <div key={p.id}><b>{p.name}</b>{p.evidence === "working-directory" ? <p>Working directory match; no confirmed edit evidence.</p> : <ul>{files.slice(0, 30).map(f => <li key={f}>{f}</li>)}{files.length > 30 && <li>{files.length - 30} more files</li>}</ul>}</div>;
            })}</details>
            {selected.suggestion && <div className="sl-inline-suggestion"><span><b>Belongs with {selected.suggestion.name}?</b><small>{selected.suggestion.reason}{selected.suggestion.confidence === "tentative" ? " · a guess" : ""}</small></span><button disabled={busy} title="Files it under that group in Hangar. Claude and Codex are not changed." onClick={() => act({ action: "acceptSuggestion", keys: [selected.key] }, `Filed under ${selected.suggestion?.name} in Hangar.`)}>File under {selected.suggestion.name} <Check size={14} /></button></div>}
            <div className="sl-session-actions">{selected.archived ? selected.archiveScope === "claude" ? <p className="sl-actions-help">Archived in the Claude app. Restore it there; Hangar follows.</p> : <button disabled={busy || selected.protected || (selected.archiveScope === "codex" && !selected.nativeKnown)} onClick={() => act({ action: "restore", keys: [selected.key], scope: selected.archiveScope }, "Session restored; it won’t be suggested for clean-up for seven days.")}>Restore in {selected.archiveScope === "codex" ? "Codex" : "Hangar"}</button> : <>
              {onOpen && <button className="sl-open" disabled={busy} title={selected.opensIn === "app" ? `Opens in the ${selected.provider === "codex" ? "Codex" : "Claude"} app` : `The ${selected.provider === "codex" ? "Codex" : "Claude"} app does not have this conversation (it was started outside the app), so it resumes in a terminal`} onClick={() => onOpen(selected)}>{selected.opensIn === "app" ? `Open in ${selected.provider === "codex" ? "Codex" : "Claude"}` : "Resume in a terminal"} <ArrowRight size={14} /></button>}
              <button disabled={busy || !selected.canResume || !selected.projects.length} title="Hangar sends this conversation a new instruction and runs it in the background, with its history" onClick={async () => { if (await act({ action: "opened", keys: [selected.key] }, "Session opened in Hangar.")) onContinue(selected); }}>Give it a task</button>
              <button disabled={busy} title="Hangar groups sort Claude and Codex sessions together" onClick={() => { setChosenGroup(selected.group || ""); setTarget({ key: selected.key, purpose: "group" }); }}>Move to group</button>
              <button disabled={busy || selected.protected || selected.pinned} onClick={() => setTarget({ key: selected.key, purpose: "archive" })}>Archive</button>
              {selected.reviewDue && <button disabled={busy} title="Leaves it out of Clean up for seven days" onClick={() => act({ action: "snooze", keys: [selected.key] }, "Kept. It won’t be suggested for clean-up for seven days.")}>Keep it</button>}
              <p className="sl-actions-help">Groups and archive here are Hangar’s. A Codex session can be archived in Codex too; the Claude app’s sidebar changes only in the app.</p>
            </>}</div>
          </div>
          </article>}
        </div>}
        {!visible.length && <div className="sl-empty"><Check size={24} /><h3>{mode === "review" ? "Nothing to clean up." : "No sessions in this view."}</h3></div>}
      </>}
      </div>
    </>}
    {bulk && (() => {
      const n = bulk.rows.length, codex = bulk.rows.filter(s => s.provider === "codex"), native = codex.filter(s => s.nativeKnown).length;
      const inApp = bulk.rows.filter(s => s.provider !== "codex" && s.opensIn === "app").length;
      return <div className="cw-dialog-backdrop"><section ref={dialog} className="cw-dialog sl-dialog" role="dialog" aria-modal="true" aria-labelledby="sl-dialog-title"><button className="cw-dialog-close" aria-label="Close" disabled={busy} onClick={() => setBulk(null)}><X size={20} /></button>
        <span className="cw-eyebrow">Clean up · untouched {bulk.name.toLowerCase()}</span><h2 id="sl-dialog-title">Archive {n} {n === 1 ? "session" : "sessions"}?</h2>
        <div className="sl-bulk-split"><span><i className="sl-swatch is-claude" aria-hidden="true" />{n - codex.length} Claude</span><span><i className="sl-swatch is-codex" aria-hidden="true" />{codex.length} Codex</span></div>
        <ul className="sl-bulk-list">{bulk.rows.slice(0, 6).map(s => <li key={s.key}><span>{s.title}</span><small>{s.idleDays}d</small></li>)}{n > 6 && <li className="is-more">and {n - 6} more</li>}</ul>
        {native > 0 && <label className="sl-check"><input type="checkbox" checked={alsoCodex} disabled={busy} onChange={e => setAlsoCodex(e.target.checked)} />Archive the {native} Codex {native === 1 ? "session" : "sessions"} in the Codex app too</label>}
        {inApp > 0 && <p className="sl-help">{inApp} of them are in the Claude app’s sidebar. Hangar can’t press the app’s Archive, so they stay there until they are archived in the app.</p>}
        <div className="sl-dialog-actions"><button className="cw-primary" disabled={busy} onClick={async () => {
          if (await act({ action: "archive", keys: bulk.rows.map(s => s.key), scope: alsoCodex && native ? "codex" : "hangar", activity: Object.fromEntries(bulk.rows.map(s => [s.key, s.activityAt])) },
            r => `Archived ${r.archived} in Hangar${r.codexArchived ? `, ${r.codexArchived} in Codex too` : ""}${r.codexFailed ? `; Codex refused ${r.codexFailed}, which stay archived in Hangar only` : ""}. Restore any from Archived.`)) setBulk(null);
        }}>Archive {n} <Archive size={16} /></button><button disabled={busy} onClick={() => setBulk(null)}>Cancel</button></div>
        <p className="sl-help">Unread sessions and ones waiting on you are not in this list. Restore any of these from Archived.</p>
        {error && <p className="cw-error" role="alert">{error}</p>}</section></div>;
    })()}
    {target && targetRow && <div className="cw-dialog-backdrop"><section ref={dialog} className="cw-dialog sl-dialog" role="dialog" aria-modal="true" aria-labelledby="sl-dialog-title"><button className="cw-dialog-close" aria-label="Close session review" disabled={busy} onClick={() => setTarget(null)}><X size={20} /></button><span className="cw-eyebrow">{targetRow.provider} · {targetRow.idleDays ?? "?"} DAYS IDLE</span><h2 id="sl-dialog-title">{target.purpose === "archive" ? "Keep it, or clear the space?" : "Give this work a home."}</h2><h3>{targetRow.title}</h3>
      {target.purpose === "archive" ? <>
        <p className="sl-help">{targetRow.unread === true ? `${appOf(targetRow)} shows a reply you haven’t opened. Look at it before deciding.` : targetRow.status?.category === "blocked" ? "Its last turn stopped to ask you something. Look at it before deciding." : targetRow.unread === null ? "Hangar can’t tell whether you have read its last reply." : `You have read its last reply in ${appOf(targetRow)}.`} Archiving keeps the whole conversation; restore it from Archived.</p>
        {machine === "local" && targetRow.provider === "codex" && targetRow.nativeKnown && <a className="sl-native-link" href={`codex://threads/${encodeURIComponent(targetRow.id)}`}>Read this session in Codex <ArrowRight size={15} /></a>}
        <div className="sl-dialog-actions"><button className="cw-primary" disabled={busy || targetRow.protected || targetRow.pinned} onClick={async () => { if (await act({ action: "archive", keys: [targetRow.key], scope: "hangar", activityAt: targetRow.activityAt }, "Archived in Hangar. Restore it from Archived at any time.")) setTarget(null); }}>Archive in Hangar <Archive size={16} /></button>
          {targetRow.provider === "codex" && <button disabled={busy || !targetRow.nativeKnown || targetRow.protected || targetRow.pinned} onClick={async () => { if (await act({ action: "archive", keys: [targetRow.key], scope: "codex", activityAt: targetRow.activityAt }, "Codex confirmed the archive.")) setTarget(null); }}>Archive in Codex too</button>}
          <button disabled={busy} onClick={async () => { if (await act({ action: "reviewed", keys: [targetRow.key] }, "Reviewed in Hangar. Codex’s own unread state is unchanged.")) setTarget(null); }}>I reviewed it · keep active</button>
        </div><p className="sl-help">Archive in Hangar hides it from Hangar’s lists. Archive in Codex also archives it in the Codex app. The Claude app’s sidebar changes only in the app.</p>
      </> : <>
        <fieldset className="sl-group-picker"><legend>Hangar group</legend><label><input type="radio" name="session-group" value="" checked={!chosenGroup} onChange={() => setChosenGroup("")} />Ungrouped</label>{data?.groups.map(g => <label key={g.id}><input type="radio" name="session-group" value={g.id} checked={chosenGroup === g.id} onChange={() => setChosenGroup(g.id)} /><span>{g.name}<small>{g.source === "codex" ? "Codex section" : "Hangar group"}</small></span></label>)}</fieldset>
        <div className="sl-dialog-actions"><button className="cw-primary" disabled={busy} onClick={async () => { if (await act({ action: "assign", keys: [targetRow.key], group: chosenGroup || null }, "Group saved in Hangar.")) setTarget(null); }}>Save Hangar group</button>
          {targetRow.provider === "codex" && <button disabled={busy || !targetRow.nativeKnown || !data?.groups.some(g => g.id === chosenGroup && g.source === "codex")} onClick={async () => { if (await act({ action: "moveCodex", keys: [targetRow.key], group: chosenGroup }, "Codex confirmed the section move.")) setTarget(null); }}>Move in Codex too</button>}
        </div><p className="sl-help">Claude groups live in Hangar. Codex’s native section changes only when you choose “Move in Codex too”.</p>
      </>}{error && <p className="cw-error" role="alert">{error}</p>}</section></div>}
  </section>;
}

/** The two agents at a glance: how many sessions each has, how many projects both touched, and the last two weeks. */
function Overview({ rows, lanes }: { rows: LibrarySession[]; lanes: ReturnType<typeof projectLanes> }) {
  const live = rows.filter(s => !s.archived);
  const claude = live.filter(s => agentOf(s) === "claude").length, codex = live.length - claude;
  const both = lanes.filter(l => l.claude && l.codex).length;
  const today = new Date(); today.setHours(24, 0, 0, 0);
  const days = Array.from({ length: 14 }, () => ({ claude: 0, codex: 0 }));
  for (const s of live) { const d = Math.floor((today.getTime() - lastSeen(s)) / DAY); if (d >= 0 && d < 14) days[13 - d][agentOf(s)]++; }
  const peak = Math.max(1, ...days.map(d => d.claude + d.codex));
  return <div className="sl-overview">
    <div className="sl-stats">
      <span><b>{live.length}</b>sessions</span>
      <span><i className="sl-swatch is-claude" aria-hidden="true" /><b>{claude}</b>Claude</span>
      <span><i className="sl-swatch is-codex" aria-hidden="true" /><b>{codex}</b>Codex</span>
      <span><b>{lanes.length}</b>projects</span>
      <span><b>{both}</b>with both agents</span>
    </div>
    <div className="sl-days" role="img" aria-label={`Sessions active over the last 14 days: ${days.map(d => d.claude + d.codex).join(", ")}`}>
      {days.map((d, i) => <span key={i} title={`${d.claude} Claude · ${d.codex} Codex`}><i className="is-codex" style={{ height: `${d.codex / peak * 100}%` }} /><i className="is-claude" style={{ height: `${d.claude / peak * 100}%` }} /></span>)}
      <small>last 14 days</small>
    </div>
  </div>;
}

/** Every project as a lane: Claude and Codex counts, a 30-day track of when each agent worked on it, and the latest session. */
function ProjectLanes({ lanes, onOpen }: { lanes: ReturnType<typeof projectLanes>; onOpen: (project: string) => void }) {
  const [scope, setScope] = useState<"all" | "both" | "claude" | "codex">("all");
  const count = { all: lanes.length, both: lanes.filter(l => l.claude && l.codex).length, claude: lanes.filter(l => l.claude && !l.codex).length, codex: lanes.filter(l => l.codex && !l.claude).length };
  const shown = lanes.filter(l => scope === "all" || (scope === "both" ? l.claude && l.codex : scope === "claude" ? l.claude && !l.codex : l.codex && !l.claude));
  const now = Date.now(), span = 30 * DAY;
  return <>
    <div className="sl-seg sl-lane-scope" role="group" aria-label="Which projects">{([["all", "All projects"], ["both", "Both agents"], ["claude", "Claude only"], ["codex", "Codex only"]] as const).map(([id, label]) => <button key={id} aria-pressed={scope === id} onClick={() => setScope(id)}>{label}<small>{count[id]}</small></button>)}</div>
    <div className="sl-lanes">{shown.map(l => {
      const latest = [...l.sessions].sort((a, b) => lastSeen(b) - lastSeen(a))[0];
      return <button key={l.id} className="sl-lane" onClick={() => onOpen(l.id)} title={`Open ${l.name}'s sessions`}>
        <span className="sl-lane-head"><ProjectBadge id={l.id} name={l.name} size="md" detail />{l.claude > 0 && l.codex > 0 && <em>Both agents</em>}<small>{ago(l.last)}</small></span>
        <span className="sl-lane-split" aria-hidden="true"><i className="is-claude" style={{ flexGrow: l.claude }} /><i className="is-codex" style={{ flexGrow: l.codex }} /></span>
        <span className="sl-lane-counts"><span><i className="sl-swatch is-claude" aria-hidden="true" />{l.claude} Claude</span><span><i className="sl-swatch is-codex" aria-hidden="true" />{l.codex} Codex</span></span>
        <span className="sl-lane-track" aria-hidden="true">{l.sessions.map(s => { const age = now - lastSeen(s); return age <= span ? <i key={s.key} className={`is-${agentOf(s)}`} style={{ left: `${Math.max(0, 100 - age / span * 100)}%` }} /> : null; })}</span>
        <span className="sl-lane-scale" aria-hidden="true"><small>30 days ago</small><small>today</small></span>
        {latest && <span className="sl-lane-latest"><i className={`sl-swatch is-${agentOf(latest)}`} aria-hidden="true" />{latest.title}</span>}
      </button>;
    })}</div>
    {!shown.length && <p className="cw-muted">No projects in this view.</p>}
  </>;
}
