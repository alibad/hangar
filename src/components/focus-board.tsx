"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Check, ExternalLink, GitCommitHorizontal, Megaphone, Moon, Plus, Search, Star, StarOff, Users, X } from "lucide-react";
import { ProjectEmblem } from "./project-identity";
import { MAX_FOCUS, MAX_GOALS, emptyFocus, isoWeek, lastWeek, quarter, weekMonday, type FocusData, type Metric } from "@/lib/focus-board";
import "./focus-board.css";

export type FocusRepo = { id: string; name: string; homepage?: string | null; hidden?: boolean; hiddenByIsland?: string; attention?: string | null; lastActivity?: string; sites: { dirty?: number }[] };
type Activity = { commits?: number; sessions?: number; away?: boolean };
type Tile = { metric: Metric; label: string };
const PEOPLE: Tile[] = [{ metric: "users", label: "users this week" }, { metric: "signups", label: "new signups" }];
const MARKETING: Tile[] = [{ metric: "posts", label: "posts this week" }, { metric: "visits", label: "visits from posts" }];
const SHELF = 6;

async function send<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, { method: body === undefined ? "GET" : "POST", cache: "no-store",
    headers: body === undefined ? undefined : { "Content-Type": "application/json", "X-Hangar": "1" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : `Request failed (${response.status})`);
  return data;
}
const host = (url?: string | null) => { try { return url ? new URL(url).host : ""; } catch { return ""; } };

/**
 * The map's Focus tab: the few projects you marked Focus, each with what Hangar knows (commits, unsaved work) beside the
 * numbers it can't read yet (people, posts), which you type each week; the quarter's goals above; everything else rests.
 */
export default function FocusBoard({ repos, prefix, busy, onOpen, onAttention }: {
  repos: FocusRepo[]; prefix: string; busy: boolean; onOpen: (repo: FocusRepo) => void; onAttention: (repo: FocusRepo, value: "focus" | null) => void;
}) {
  const [data, setData] = useState<FocusData>(emptyFocus());
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [activity, setActivity] = useState<Record<string, Activity>>({});
  const [find, setFind] = useState("");
  const now = new Date(), week = isoWeek(now), before = lastWeek(now), q = quarter(now);
  const focused = useMemo(() => repos.filter(r => !r.hidden && r.attention === "focus"), [repos]);
  const full = focused.length >= MAX_FOCUS;
  const ids = focused.map(r => r.id).join(",");

  useEffect(() => { send<FocusData>("/api/focus").then(d => { setData(d); setLoaded(true); }).catch(e => { setError(e.message); setLoaded(true); }); }, []);
  // What git says about each focus project this week: commits on its main branch and the sessions that worked on it.
  useEffect(() => {
    const controller = new AbortController();
    for (const id of ids ? ids.split(",") : []) {
      fetch(`${prefix}/activity?repo=${encodeURIComponent(id)}&days=7`, { cache: "no-store", signal: controller.signal })
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d) setActivity(a => ({ ...a, [id]: d.available ? { commits: d.commits?.length ?? 0, sessions: d.sessions?.length ?? 0 } : { away: true } })); })
        .catch(() => { /* the tile stays empty */ });
    }
    return () => controller.abort();
  }, [ids, prefix]);

  const change = async (action: Record<string, unknown>) => {
    setError("");
    try { setData(await send<FocusData>("/api/focus", action)); return true; }
    catch (e) { setError((e as Error).message); return false; }
  };
  const [goal, setGoal] = useState("");
  const [goalError, setGoalError] = useState("");
  const addGoal = async (e: FormEvent) => {
    e.preventDefault();
    if (!goal.trim()) { setGoalError("Write the goal first."); return; }
    if (await change({ action: "add-goal", text: goal })) setGoal("");
  };

  const resting = repos.filter(r => !r.hidden && r.attention !== "focus");
  const shelf = (find.trim() ? resting.filter(r => r.name.toLowerCase().includes(find.trim().toLowerCase()))
    : [...resting].sort((a, b) => (b.lastActivity || "").localeCompare(a.lastActivity || ""))).slice(0, SHELF);
  const monday = weekMonday(now).toLocaleDateString(undefined, { day: "numeric", month: "short" });

  return <div className="fb">
    <section className="fb-goals" aria-label="Goals this quarter">
      <div className="fb-head"><b>Goals</b><small>{q.label} · {q.weeksLeft} {q.weeksLeft === 1 ? "week" : "weeks"} left</small></div>
      {data.goals.length > 0 && <ul>{data.goals.map(g => <li key={g.id} className={g.done ? "is-done" : ""}>
        <button className="fb-check" aria-pressed={g.done} aria-label={g.done ? `Mark "${g.text}" not done` : `Mark "${g.text}" done`} onClick={() => void change({ action: "update-goal", id: g.id, done: !g.done })}>{g.done && <Check size={13} />}</button>
        <span>{g.text}</span>
        <button className="fb-x" aria-label={`Remove goal "${g.text}"`} title="Remove goal" onClick={() => void change({ action: "remove-goal", id: g.id })}><X size={14} /></button>
      </li>)}</ul>}
      {loaded && data.goals.length < MAX_GOALS && <form className="fb-add" onSubmit={addGoal}>
        <input aria-label="New goal" aria-invalid={!!goalError} maxLength={140} value={goal} onChange={e => { setGoal(e.target.value); setGoalError(""); }} placeholder={data.goals.length ? "Another goal" : "RTS AI: /play open to everyone"} />
        <button type="submit" aria-label="Add goal"><Plus size={15} /></button>
      </form>}
      {goalError && <p className="fb-error">{goalError}</p>}
    </section>

    {error && <p className="fb-error" role="status">{error}</p>}

    {focused.length ? <>
      <div className="fb-week">Week of {monday}</div>
      <div className="fb-cards">{focused.map(repo => {
        const a = activity[repo.id], unsaved = repo.sites.reduce((n, s) => n + (s.dirty || 0), 0), site = host(repo.homepage);
        const numbers = data.weeks[repo.id]?.[week] || {}, previous = data.weeks[repo.id]?.[before] || {};
        const save = (metric: Metric, value: number | null) => change({ action: "set-number", repo: repo.id, week, metric, value });
        return <article key={repo.id} className="fb-card" aria-label={repo.name}>
          <header>
            <button className="fb-name" onClick={() => onOpen(repo)} title={`Open ${repo.name}`}><ProjectEmblem id={repo.id} name={repo.name} size={30} /><span><b>{repo.name}</b><small>{site ? <><i className="fb-live" aria-hidden="true" />{site}</> : "No website yet"}</small></span></button>
            {repo.homepage && site && <a className="fb-icon" href={repo.homepage} target="_blank" rel="noreferrer" aria-label={`Open ${site}`} title={`Open ${site}`}><ExternalLink size={15} /></a>}
            <button className="fb-icon" disabled={busy} onClick={() => onAttention(repo, null)} aria-label={`Take ${repo.name} out of Focus`} title="Take out of Focus"><StarOff size={15} /></button>
          </header>
          <div className="fb-row"><span className="fb-label"><GitCommitHorizontal size={14} aria-hidden="true" />Building</span>
            <div className="fb-tile" title="Commits on its main branch in the last 7 days"><b>{a?.away ? "–" : a?.commits ?? "…"}</b><small>{a?.away ? "not on this machine" : "commits, 7 days"}</small></div>
            <div className={`fb-tile ${unsaved > 9 ? "is-warn" : ""}`} title="Changed files not committed yet"><b>{unsaved}</b><small>not saved to git</small></div>
          </div>
          <div className="fb-row"><span className="fb-label"><Users size={14} aria-hidden="true" />People</span>{PEOPLE.map(t => <NumberTile key={t.metric} label={t.label} value={numbers[t.metric]} previous={previous[t.metric]} onSave={v => save(t.metric, v)} />)}</div>
          <div className="fb-row"><span className="fb-label"><Megaphone size={14} aria-hidden="true" />Marketing</span>{MARKETING.map(t => <NumberTile key={t.metric} label={t.label} value={numbers[t.metric]} previous={previous[t.metric]} onSave={v => save(t.metric, v)} />)}</div>
        </article>;
      })}</div>
    </> : <div className="fb-empty"><Star size={22} aria-hidden="true" /><b>Pick what matters now</b><p>Star up to {MAX_FOCUS} projects. Everything else rests on the map.</p></div>}

    <section className="fb-shelf" aria-label="Resting projects">
      <div className="fb-head"><b><Moon size={14} aria-hidden="true" />{focused.length ? "Resting" : "Busiest lately"}</b><small>{resting.length} on the map</small></div>
      <label className="fb-find"><Search size={14} aria-hidden="true" /><input aria-label="Find a project to focus" value={find} onChange={e => setFind(e.target.value)} placeholder="Find a project" /></label>
      <div className="fb-chips">{shelf.map(r => <button key={r.id} className="fb-chip" disabled={busy || full} title={full ? `${MAX_FOCUS} is the most. Take one out first.` : `Add ${r.name} to Focus`} onClick={() => onAttention(r, "focus")}><ProjectEmblem id={r.id} name={r.name} size={16} /><span>{r.name}</span><Star size={13} aria-hidden="true" /></button>)}
        {!shelf.length && <small className="fb-none">No project matches “{find}”.</small>}</div>
    </section>

    <p className="fb-legend"><i className="is-known" aria-hidden="true" />from your repos <i className="is-typed" aria-hidden="true" />you type it, for now</p>
  </div>;
}

/** A number you type for this week. Saves when you leave the box or press Enter; empty clears it. */
function NumberTile({ label, value, previous, onSave }: { label: string; value?: number; previous?: number; onSave: (value: number | null) => Promise<boolean> }) {
  const shown = value === undefined ? "" : String(value);
  const [draft, setDraft] = useState(shown), [bad, setBad] = useState(false);
  useEffect(() => { setDraft(shown); setBad(false); }, [shown]);
  const commit = () => {
    const clean = draft.replace(/[\s,]/g, "");
    if (clean === shown) return;
    if (clean && !/^\d{1,10}$/.test(clean)) { setBad(true); return; }
    void onSave(clean ? Number(clean) : null);
  };
  const diff = value !== undefined && previous !== undefined ? value - previous : null;
  return <label className={`fb-tile is-typed ${value === undefined ? "is-empty" : ""} ${bad ? "is-bad" : ""}`}>
    <input inputMode="numeric" aria-label={label} aria-invalid={bad} value={draft} placeholder="–" onChange={e => { setDraft(e.target.value); setBad(false); }} onBlur={commit}
      onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { setDraft(shown); setBad(false); } }} />
    <small>{bad ? "Use a whole number" : label}</small>
    {diff !== null && diff !== 0 && <em className={diff > 0 ? "is-up" : "is-down"}>{diff > 0 ? "+" : "−"}{Math.abs(diff).toLocaleString()} on last week</em>}
  </label>;
}
