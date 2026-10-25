"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Archive, ArrowRight, Check, Folder, Layers, Pin, X } from "lucide-react";
import "./session-library.css";
import HangarLoading from "./hangar-loading";

export type LibrarySession = {
  id: string; key: string; provider: string; model: string; title: string; updatedAt: string; activityAt: string;
  state: string; summary: string; canResume: boolean; idleDays: number | null; unread: boolean | null;
  reviewed: boolean; group: string | null; nativeGroup: string | null; nativeKnown: boolean; pinned: boolean;
  archived: boolean; archiveScope: "hangar" | "codex" | null; protected: boolean; reviewDue: boolean; snoozedUntil: string | null;
  projects: { id: string; name: string; evidence: string; files: string[] }[];
  suggestion: { id: string; name: string; reason: string; confidence: string } | null;
  /** Where Open takes it: its desktop app when the app can show it, otherwise a terminal. */
  opensIn?: "app" | "terminal";
};
type Group = { id: string; name: string; source: string; nativeId?: string };
export type SessionLibraryData = { sessions: LibrarySession[]; groups: Group[]; idleDays: number; nativeAvailable: boolean; reviewCount: number; unreadReviewCount: number; truncated: boolean; observedAt: string };
type Props = { machine: string; data: SessionLibraryData | null; error: string; onUpdate: (data: SessionLibraryData) => void; onContinue: (session: LibrarySession) => void; onOpen?: (session: LibrarySession) => void };
type Mode = "active" | "projects" | "review" | "groups" | "archived";
type Agent = "all" | "claude" | "codex";
const DAY = 86400000;
const agentOf = (s: LibrarySession) => s.provider === "codex" ? "codex" : "claude";
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
  const dialog = useRef<HTMLElement>(null);
  const detail = useRef<HTMLElement>(null);
  const updateRef = useRef(onUpdate); updateRef.current = onUpdate;
  const busyRef = useRef(false);
  const endpoint = `/api/world/${machine}/proxy/sessions/library`;
  const rows = data?.sessions || [];
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
    if (!target) return;
    const previous = document.activeElement as HTMLElement | null;
    const el = dialog.current;
    const controls = () => [...el?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),a[href]') || []];
    controls()[0]?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) setTarget(null);
      if (event.key === "Tab") {
        const list = controls(), first = list[0], last = list.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    el?.addEventListener("keydown", key);
    return () => { el?.removeEventListener("keydown", key); previous?.focus(); };
  }, [target]);

  async function act(body: Record<string, unknown>, message: string) {
    if (busyRef.current) return false;
    busyRef.current = true; setBusy(true); setError(""); setNotice("");
    try {
      await request(endpoint, body);
      const next = await request<SessionLibraryData>(endpoint);
      onUpdate(next); setNotice(message); return true;
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
    if (mode === "review") list = [...list].sort((a, b) => Number(b.unread === true) - Number(a.unread === true) || (b.idleDays || 0) - (a.idleDays || 0));
    return list;
  }, [rows, mode, filter, query, agent, project, unreadOnly]);
  // Active work reads by topic; archive review and the archive stay one queue in their own order.
  const sections = useMemo(() => {
    const shown = visible.slice(0, limit);
    if (mode !== "active" || filter || project) return [{ id: "all", name: "", rows: shown }];
    const topics = new Map<string, { id: string; name: string; rows: LibrarySession[] }>();
    for (const row of shown) {
      const id = row.group ? `group:${row.group}` : row.suggestion ? `suggestion:${row.suggestion.id}` : "other";
      const name = row.group ? data?.groups.find(g => g.id === row.group)?.name || "Group"
        : row.suggestion ? `${row.suggestion.name} · suggested` : "Other sessions";
      if (!topics.has(id)) topics.set(id, { id, name, rows: [] });
      topics.get(id)!.rows.push(row);
    }
    return [...topics.values()].sort((a, b) => Number(a.id === "other") - Number(b.id === "other"));
  }, [visible, limit, mode, filter, data]);
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
    <div className="sl-toolbar"><div className="cw-family-tabs" aria-label="Session view">{([['active', 'Active'], ['projects', 'By project'], ['review', 'Archive review'], ['groups', 'Groups & sections'], ['archived', 'Archived']] as const).map(([id, label]) => <button key={id} aria-pressed={mode === id} onClick={() => chooseMode(id)}>{label}{id === "review" && !!data?.reviewCount && <small>{data.reviewCount}</small>}</button>)}</div><div className="sl-threshold" aria-label="Idle threshold"><span>Idle after</span>{[7, 14, 30].map(days => <button key={days} aria-pressed={data?.idleDays === days} disabled={busy || !data} onClick={() => act({ action: "settings", idleDays: days }, `Review threshold set to ${days} days.`)}>{days}d</button>)}</div></div>
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
          {project && <button className="sl-chip" onClick={() => setProject("")} title="Show every project">{laneOf.get(project)?.name || project}<X size={13} /></button>}
          <span>{visible.length} sessions</span>{filter && <button onClick={() => setFilter("")}>Clear group filter <X size={14} /></button>}</div>
        {mode === "review" && <p className="sl-help">{data.reviewCount ? `${data.reviewCount} sessions have had no observed activity for ${data.idleDays}+ days${data.unreadReviewCount ? `, ${data.unreadReviewCount} unread in Codex` : ""}. Nothing is archived without your choice. ` : ""}Unread sessions come first so useful results are not buried. Pinned sessions and projects with active or unobserved jobs are protected.</p>}
        {!!visible.length && <div className="sl-inbox">
          <div className="sl-list" aria-label="Sessions">
            {sections.map(section => <div className="sl-section" key={section.id}>
              {section.name && <h4>{section.name}<small>{section.rows.length}</small></h4>}
              {section.rows.map(row => <button type="button" key={row.key} aria-pressed={selected?.key === row.key} className={`sl-row ${row.unread ? "sl-unread" : ""}`} onClick={() => pick(row.key)}>
                <span className={`cw-session-provider is-${agentOf(row)}`}>{row.provider === "codex" ? "CX" : "CL"}</span>
                <span className="sl-row-text"><b>{row.title}</b><small>{[row.projects.map(p => p.name).join(", ") || "No project", row.idleDays === null ? "" : row.idleDays === 0 ? "today" : `${row.idleDays}d idle`, row.archived ? "archived" : ""].filter(Boolean).join(" · ")}</small></span>
                {row.unread === true && <i className="sl-dot" aria-label="Unread in Codex" />}
                {row.pinned && <Pin size={13} aria-label="Pinned in Codex" />}
              </button>)}
            </div>)}
            {visible.length > limit && <button className="sl-more" onClick={() => setLimit(n => n + 40)}>Show 40 more sessions</button>}
          </div>
          {selected && <article ref={detail} className={`sl-detail sl-session ${selected.unread ? "sl-unread" : ""}`} aria-label={`Session: ${selected.title}`}>
            <div className="sl-session-body"><div className="sl-session-title"><h3>{selected.title}</h3>{selected.pinned && <Pin size={14} aria-label="Pinned in Codex" />}</div>
            <div className="sl-tags"><span>{selected.unread === true ? "Unread in Codex" : selected.unread === false ? "Read in Codex" : "Read state unknown"}</span>{selected.reviewed && <span>Reviewed in Hangar</span>}<span>{selected.idleDays === null ? "Activity unknown" : `${selected.idleDays}d idle`}</span>{selected.group && <span>{data.groups.find(g => g.id === selected.group)?.name}</span>}{selected.protected && <span>Active project · protected</span>}{selected.archived && <span>Archived in {selected.archiveScope === "codex" ? "Codex" : "Hangar"}</span>}</div>
            <p>{selected.summary}</p>
            {selected.projects.length > 0 && <div className="sl-connect" aria-label="This session's projects">{selected.projects.map(p => { const lane = laneOf.get(p.id); return <button key={p.id} onClick={() => openProject(p.id)} aria-pressed={project === p.id} title={`Every session in ${p.name}`}>
              <b>{p.name}</b><span><i className="sl-swatch is-claude" aria-hidden="true" />{lane?.claude || 0} Claude</span><span><i className="sl-swatch is-codex" aria-hidden="true" />{lane?.codex || 0} Codex</span><ArrowRight size={13} /></button>; })}</div>}
            <details><summary>File evidence & session ID</summary><code>{selected.id}</code>{selected.projects.map(p => {
              const files = [...new Set(p.files)];
              return <div key={p.id}><b>{p.name}</b>{p.evidence === "working-directory" ? <p>Working directory match; no confirmed edit evidence.</p> : <ul>{files.slice(0, 30).map(f => <li key={f}>{f}</li>)}{files.length > 30 && <li>{files.length - 30} more files</li>}</ul>}</div>;
            })}</details>
            {selected.suggestion && <div className="sl-inline-suggestion"><span><b>Suggested: {selected.suggestion.name}</b><small>{selected.suggestion.reason}{selected.suggestion.confidence === "tentative" ? " · tentative" : ""}</small></span><button disabled={busy} title="Put this session in that Hangar group. Claude and Codex are not changed." onClick={() => act({ action: "acceptSuggestion", keys: [selected.key] }, "Grouped in Hangar. Native Codex sections are unchanged.")}>Add to this group <Check size={14} /></button></div>}
            <div className="sl-session-actions">{selected.archived ? <button disabled={busy || selected.protected || (selected.archiveScope === "codex" && !selected.nativeKnown)} onClick={() => act({ action: "restore", keys: [selected.key], scope: selected.archiveScope }, "Session restored; archive suggestions snoozed for seven days.")}>Restore in {selected.archiveScope === "codex" ? "Codex" : "Hangar"}</button> : <>
              {onOpen && <button className="sl-open" disabled={busy} title={selected.opensIn === "app" ? `Opens in the ${selected.provider === "codex" ? "Codex" : "Claude"} app` : `The ${selected.provider === "codex" ? "Codex" : "Claude"} app does not have this conversation (it was started outside the app), so it resumes in a terminal`} onClick={() => onOpen(selected)}>{selected.opensIn === "app" ? `Open in ${selected.provider === "codex" ? "Codex" : "Claude"}` : "Resume in a terminal"} <ArrowRight size={14} /></button>}
              <button disabled={busy || !selected.canResume || !selected.projects.length} title="Give it a new task from Hangar, with its history" onClick={async () => { if (await act({ action: "opened", keys: [selected.key] }, "Session opened in Hangar.")) onContinue(selected); }}>Continue from Hangar</button>
              <button disabled={busy} title="Hangar groups sort sessions from both agents together" onClick={() => { setChosenGroup(selected.group || ""); setTarget({ key: selected.key, purpose: "group" }); }}>Group…</button>
              <button disabled={busy || selected.protected || selected.pinned} onClick={() => setTarget({ key: selected.key, purpose: "archive" })}>{selected.reviewDue ? "Review archive" : "Archive…"}</button>
              {selected.reviewDue && <button disabled={busy} onClick={() => act({ action: "snooze", keys: [selected.key] }, "Kept active. Ask again in seven days.")}>Keep for 7 days</button>}
              <p className="sl-actions-help">Groups and archive are Hangar’s own tidy-up and change nothing in Claude Code. For a Codex session, archiving can also archive it in Codex; you choose that in the next step.</p>
            </>}</div>
          </div>
          </article>}
        </div>}
        {!visible.length && <div className="sl-empty"><Check size={24} /><h3>{mode === "review" ? "Nothing needs an archive decision." : "No sessions in this view."}</h3></div>}
      </>}
      </div>
    </>}
    {target && targetRow && <div className="cw-dialog-backdrop"><section ref={dialog} className="cw-dialog sl-dialog" role="dialog" aria-modal="true" aria-labelledby="sl-dialog-title"><button className="cw-dialog-close" aria-label="Close session review" disabled={busy} onClick={() => setTarget(null)}><X size={20} /></button><span className="cw-eyebrow">{targetRow.provider} · {targetRow.idleDays ?? "?"} DAYS IDLE</span><h2 id="sl-dialog-title">{target.purpose === "archive" ? "Keep it, or clear the space?" : "Give this work a home."}</h2><h3>{targetRow.title}</h3>
      {target.purpose === "archive" ? <>
        <p className="sl-help">{targetRow.unread === true ? "Codex marks this session unread. Review its result before deciding." : targetRow.unread === null ? "The agent’s read state is unknown. Age alone does not mean the result is disposable." : "Codex marks this session read."} Archiving preserves the session.</p>
        {machine === "local" && targetRow.provider === "codex" && targetRow.nativeKnown && <a className="sl-native-link" href={`codex://threads/${encodeURIComponent(targetRow.id)}`}>Read this session in Codex <ArrowRight size={15} /></a>}
        <div className="sl-dialog-actions"><button className="cw-primary" disabled={busy || targetRow.protected || targetRow.pinned} onClick={async () => { if (await act({ action: "archive", keys: [targetRow.key], scope: "hangar", activityAt: targetRow.activityAt }, "Archived in Hangar. Restore it from Archived at any time.")) setTarget(null); }}>Archive in Hangar <Archive size={16} /></button>
          {targetRow.provider === "codex" && <button disabled={busy || !targetRow.nativeKnown || targetRow.protected || targetRow.pinned} onClick={async () => { if (await act({ action: "archive", keys: [targetRow.key], scope: "codex", activityAt: targetRow.activityAt }, "Codex confirmed the archive.")) setTarget(null); }}>Archive in Codex too</button>}
          <button disabled={busy} onClick={async () => { if (await act({ action: "reviewed", keys: [targetRow.key] }, "Reviewed in Hangar. Codex’s own unread state is unchanged.")) setTarget(null); }}>I reviewed it · keep active</button>
        </div><p className="sl-help">Hangar archive only changes this workspace. Claude’s original history stays intact. Codex archive uses Codex’s own API.</p>
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
        <span className="sl-lane-head"><b>{l.name}</b>{l.claude > 0 && l.codex > 0 && <em>Both agents</em>}<small>{ago(l.last)}</small></span>
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
