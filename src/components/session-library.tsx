"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Archive, ArrowRight, Check, Folder, Layers, Pin, X } from "lucide-react";
import "./session-library.css";

export type LibrarySession = {
  id: string; key: string; provider: string; model: string; title: string; updatedAt: string; activityAt: string;
  state: string; summary: string; canResume: boolean; idleDays: number | null; unread: boolean | null;
  reviewed: boolean; group: string | null; nativeGroup: string | null; nativeKnown: boolean; pinned: boolean;
  archived: boolean; archiveScope: "hangar" | "codex" | null; protected: boolean; reviewDue: boolean; snoozedUntil: string | null;
  projects: { id: string; name: string; evidence: string; files: string[] }[];
  suggestion: { id: string; name: string; reason: string; confidence: string } | null;
};
type Group = { id: string; name: string; source: string; nativeId?: string };
export type SessionLibraryData = { sessions: LibrarySession[]; groups: Group[]; idleDays: number; nativeAvailable: boolean; reviewCount: number; unreadReviewCount: number; truncated: boolean; observedAt: string };
type Props = { machine: string; data: SessionLibraryData | null; error: string; onUpdate: (data: SessionLibraryData) => void; onContinue: (session: LibrarySession) => void };
type Mode = "active" | "review" | "groups" | "archived";

async function request<T>(url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { method: body ? "POST" : "GET", cache: "no-store", signal,
    headers: body ? { "Content-Type": "application/json", "X-Hangar": "1" } : undefined,
    body: body ? JSON.stringify(body) : undefined });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Session library unavailable.");
  return result;
}

export default function SessionLibrary({ machine, data, error: loadError, onUpdate, onContinue }: Props) {
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
  const dialog = useRef<HTMLElement>(null);
  const updateRef = useRef(onUpdate); updateRef.current = onUpdate;
  const busyRef = useRef(false);
  const endpoint = `/api/atlas/${machine}/proxy/sessions/library`;
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
  const visible = useMemo(() => {
    let list = rows.filter(s => mode === "archived" ? s.archived : !s.archived && (mode !== "review" || s.reviewDue));
    if (filter) list = list.filter(s => filter.startsWith("suggestion:") ? s.suggestion?.id === filter.slice(11) : s.group === filter);
    if (query.trim()) { const q = query.toLowerCase(); list = list.filter(s => [s.title, s.provider, s.model, ...s.projects.map(p => p.name)].join(" ").toLowerCase().includes(q)); }
    if (mode === "review") list = [...list].sort((a, b) => Number(b.unread === true) - Number(a.unread === true) || (b.idleDays || 0) - (a.idleDays || 0));
    return list;
  }, [rows, mode, filter, query]);
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
    {data && <div className="sl-review-banner"><Archive size={26} /><div><h3>{data.reviewCount ? `${data.reviewCount} sessions could leave your active space.` : "Room for the work that matters."}</h3><p>{data.reviewCount ? `${data.idleDays}+ days without observed activity${data.unreadReviewCount ? ` · ${data.unreadReviewCount} unread in Codex` : ""}. Review before archiving.` : `Quiet sessions surface here after ${data.idleDays} days. Nothing is archived automatically.`}</p></div><button onClick={() => chooseMode("review")}>Review idle sessions <ArrowRight size={16} /></button></div>}
    <div className="sl-toolbar"><div className="cw-family-tabs" aria-label="Session view">{([['active', 'Active'], ['review', 'Archive review'], ['groups', 'Groups & sections'], ['archived', 'Archived']] as const).map(([id, label]) => <button key={id} aria-pressed={mode === id} onClick={() => chooseMode(id)}>{label}{id === "review" && !!data?.reviewCount && <small>{data.reviewCount}</small>}</button>)}</div><div className="sl-threshold" aria-label="Idle threshold"><span>Idle after</span>{[7, 14, 30].map(days => <button key={days} aria-pressed={data?.idleDays === days} disabled={busy || !data} onClick={() => act({ action: "settings", idleDays: days }, `Review threshold set to ${days} days.`)}>{days}d</button>)}</div></div>
    {(loadError || error) && <p className="cw-error" role="alert">{error || loadError}</p>}
    {notice && <p className="sl-notice" role="status"><Check size={15} />{notice}</p>}
    {!data ? <p className="cw-muted">Reading local session history and organization…</p> : <>
      {!data.nativeAvailable && <p className="cw-muted">Codex section and read state are unavailable on this machine. Hangar groups still work.</p>}
      {data.truncated && <p className="cw-muted">This is a bounded index; older sessions may be outside this scan.</p>}
      {mode === "groups" ? <>
        <div className="sl-group-heading"><div><h3>One set of groups. Both agents.</h3><p>Codex sections appear as they are. Claude joins the same structure through Hangar.</p></div><form onSubmit={async e => { e.preventDefault(); if (await act({ action: "createGroup", name }, "Hangar group created.")) setName(""); }}><label className="sr-only" htmlFor="sl-group-name">New group name</label><input id="sl-group-name" placeholder="New group name" value={name} maxLength={80} onChange={e => setName(e.target.value)} required /><button disabled={busy || !name.trim()}>Create group</button></form></div>
        <div className="sl-groups">{data.groups.map(group => {
          const members = rows.filter(s => s.group === group.id && !s.archived);
          return <button className="sl-group" key={group.id} onClick={() => chooseMode("active", group.id)}><div className="sl-group-top"><Folder size={20} /><span>{group.source === "codex" ? "Codex section" : "Hangar group"}</span><b>{members.length}</b></div><h3>{group.name}</h3><div className="sl-group-members">{members.slice(0, 3).map(s => <span key={s.key}><i>{s.provider === "codex" ? "CX" : "CL"}</i><span>{s.title}</span>{s.unread && <b aria-label="Unread">●</b>}</span>)}{!members.length && <span className="cw-muted">Ready for sessions</span>}</div><footer>{members.filter(s => s.provider === "claude").length} Claude · {members.filter(s => s.provider === "codex").length} Codex <ArrowRight size={15} /></footer></button>;
        })}</div>
        <div className="sl-group-heading"><div><h3>Suggested connections</h3><p>Confirmed file edits first; working-folder matches are marked tentative. Multi-project sessions stay unassigned.</p></div></div>
        <div className="sl-suggestions">{proposals.map(p => <button key={p.id} onClick={() => chooseMode("active", `suggestion:${p.id}`)}><Layers size={19} /><span><b>{p.name}</b><small>{p.count} sessions · {p.strong} with confirmed edits</small></span><span>Review <ArrowRight size={15} /></span></button>)}</div>{!proposals.length && <p className="cw-muted">No unassigned sessions have a clear project match.</p>}
      </> : <>
        <div className="sl-list-heading"><label><span className="sr-only">Find a session</span><input type="search" placeholder="Find a session or project…" value={query} onChange={e => { setQuery(e.target.value); setLimit(40); }} /></label><span>{visible.length} sessions</span>{filter && <button onClick={() => setFilter("")}>Clear group filter <X size={14} /></button>}</div>
        {mode === "review" && <p className="sl-help">Unread sessions come first so useful results are not buried. Pinned sessions and projects with active or unobserved jobs are protected.</p>}
        {visible.slice(0, limit).map(session => <article className={`sl-session cw-session-row ${session.unread ? "sl-unread" : ""}`} key={session.key}>
          <div className="cw-session-provider">{session.provider === "codex" ? "CX" : "CL"}</div>
          <div className="sl-session-body"><div className="sl-session-title"><h3>{session.title}</h3>{session.pinned && <Pin size={14} aria-label="Pinned in Codex" />}</div>
            <div className="sl-tags"><span>{session.unread === true ? "Unread in Codex" : session.unread === false ? "Read in Codex" : "Read state unknown"}</span>{session.reviewed && <span>Reviewed in Hangar</span>}<span>{session.idleDays === null ? "Activity unknown" : `${session.idleDays}d idle`}</span>{session.group && <span>{data.groups.find(g => g.id === session.group)?.name}</span>}{session.protected && <span>Active project · protected</span>}{session.archived && <span>Archived in {session.archiveScope === "codex" ? "Codex" : "Hangar"}</span>}</div>
            <p>{session.summary}</p>
            <details><summary>File evidence & session ID</summary><code>{session.id}</code>{session.projects.map(p => <div key={p.id}><b>{p.name}</b>{p.evidence === "working-directory" ? <p>Working directory match; no confirmed edit evidence.</p> : <ul>{p.files.slice(0, 30).map(f => <li key={f}>{f}</li>)}{p.files.length > 30 && <li>{p.files.length - 30} more files</li>}</ul>}</div>)}</details>
            {session.suggestion && <div className="sl-inline-suggestion"><span><b>Suggested: {session.suggestion.name}</b><small>{session.suggestion.reason}{session.suggestion.confidence === "tentative" ? " · tentative" : ""}</small></span><button disabled={busy} onClick={() => act({ action: "acceptSuggestion", keys: [session.key] }, "Grouped in Hangar. Native Codex sections are unchanged.")}>Accept group <Check size={14} /></button></div>}
            <div className="sl-session-actions">{session.archived ? <button disabled={busy || session.protected || (session.archiveScope === "codex" && !session.nativeKnown)} onClick={() => act({ action: "restore", keys: [session.key], scope: session.archiveScope }, "Session restored; archive suggestions snoozed for seven days.")}>Restore in {session.archiveScope === "codex" ? "Codex" : "Hangar"}</button> : <>
              <button disabled={busy || !session.canResume || !session.projects.length} onClick={async () => { if (await act({ action: "opened", keys: [session.key] }, "Session opened in Hangar.")) onContinue(session); }}>Continue <ArrowRight size={14} /></button>
              <button disabled={busy} onClick={() => { setChosenGroup(session.group || ""); setTarget({ key: session.key, purpose: "group" }); }}>Organize</button>
              <button disabled={busy || session.protected || session.pinned} onClick={() => setTarget({ key: session.key, purpose: "archive" })}>{session.reviewDue ? "Review archive" : "Archive…"}</button>
              {session.reviewDue && <button disabled={busy} onClick={() => act({ action: "snooze", keys: [session.key] }, "Kept active. Ask again in seven days.")}>Keep for 7 days</button>}
            </>}</div>
          </div>
        </article>)}
        {!visible.length && <div className="sl-empty"><Check size={24} /><h3>{mode === "review" ? "Nothing needs an archive decision." : "No sessions in this view."}</h3></div>}
        {visible.length > limit && <button className="sl-more" onClick={() => setLimit(n => n + 40)}>Show 40 more sessions</button>}
      </>}
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
