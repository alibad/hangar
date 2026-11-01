"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { workspaceResponse } from "@/lib/workspace-response";
import { boardDay, boardTotals, defaultDay, windowDays, type ActivitySession, type BoardData } from "@/lib/project-activity";
import { NAMES, OverlapCard, WeekPager, weekQuery } from "./project-activity";
import type { SessionPick } from "./session-pane";
import { ProjectEmblem } from "./project-identity";
import "./project-activity.css";

const SHOWN = 8; // collisions and the busiest projects first; the quiet tail on request

/** Where the board stands: the week (its last day, "" for the one ending now) and the day picked in it. */
export type BoardFocus = { end: string; day: string };

/** Every project's week at once: which agent changed what, and where Claude and Codex worked on the same project at
 *  the same time. One row per project, a Claude lane over a Codex lane, all on one clock. A dot (a commit) or a bar
 *  (a session's stretch of work) opens that session in the side pane through `onPick`; a project opens on the same
 *  week and day. */
export default function ActivityBoard({ machine, onOpenProject, picked, onPick, onLoad }: {
  machine: string; onOpenProject?: (repo: string, focus: BoardFocus) => void; picked?: SessionPick | null; onPick?: (pick: SessionPick) => void; onLoad?: (data: BoardData) => void;
}) {
  const [data, setData] = useState<BoardData | null>(null), [error, setError] = useState("");
  const [end, setEnd] = useState(""), [day, setDay] = useState(""), [all, setAll] = useState(false);
  useEffect(() => { if (data) onLoad?.(data); }, [data, onLoad]);
  useEffect(() => {
    const controller = new AbortController(); setData(null); setError("");
    fetch(`/api/world/${machine}/proxy/activity/all?${weekQuery(end)}`, { signal: controller.signal, cache: "no-store" })
      .then(r => {
        if (r.status === 404) throw new Error("Hangar’s engine on this machine predates this view. Restart Hangar to see who changed what.");
        return workspaceResponse<BoardData>(r);
      }).then(d => { if (!controller.signal.aborted) setData(d); })
      .catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [machine, end]);
  const totals = useMemo(() => data?.available ? boardTotals(data) : null, [data]);
  const days = useMemo(() => totals ? windowDays(totals, Date.parse(totals.to)) : [], [totals]);
  const key = days.some(d => d.key === day) ? day : defaultDay(days);
  const view = useMemo(() => data?.available && key ? boardDay(data, key) : null, [data, key]);
  const sessions = useMemo(() => new Map<string, ActivitySession>((data?.projects || []).flatMap(p => p.sessions.map(s => [s.key, s] as const))), [data]);
  // The Sessions tab already names the view; the board only says what it covers.
  const head = <p className="ab-scope">All projects · <WeekPager end={end} onEnd={next => { setEnd(next); setDay(""); setAll(false); }} /> · main</p>;
  if (error) return <section className="pa ab">{head}<p className="pa-note">{error}</p></section>;
  if (!data || !totals || !view) return <section className="pa ab" aria-busy="true">{head}<div className="pa-skeleton" aria-label="Reading every project's commits and sessions" /></section>;
  const peak = Math.max(1, ...days.map(d => d.claude + d.codex + d.unknown));
  const collisions = totals.overlaps.filter(o => o.crossAgent).length;
  const overlapsToday = view.rows.flatMap(r => r.bands.map(b => ({ project: r.project, overlap: b.overlap })));
  // The cards are for Claude and Codex meeting; two sessions of one agent are only counted.
  const today = overlapsToday.filter(x => x.overlap.crossAgent), sameAgent = overlapsToday.length - today.length;
  return <section className="pa ab" aria-label="Who changed what across all projects">
    {head}
    <div className="ab-stats">
      <span><b>{totals.commits.length}</b>commits</span>
      <span><i className="pa-swatch is-claude" /><b>{totals.commits.filter(c => c.agent === "claude").length}</b>Claude</span>
      <span><i className="pa-swatch is-codex" /><b>{totals.commits.filter(c => c.agent === "codex").length}</b>Codex</span>
      <span><b>{data.projects.length}</b>projects</span>
      <span className={collisions ? "is-collision" : ""}><AlertTriangle size={14} /><b>{collisions}</b>{collisions === 1 ? "collision" : "collisions"}</span>
    </div>
    <div className="pa-days" role="group" aria-label="Choose a day">
      {days.map(d => { const date = new Date(`${d.key}T12:00:00`); return <button key={d.key} aria-pressed={d.key === key} className={d.crossAgent ? "is-collision" : d.overlap ? "is-overlap" : ""}
        aria-label={`${date.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}: ${d.claude} Claude, ${d.codex} Codex${d.unknown ? `, ${d.unknown} unknown` : ""} commits${d.crossAgent ? ", Claude and Codex in the same project at once" : ""}`}
        onClick={() => { setDay(d.key); setAll(false); }}>
        <span className="pa-day-bars" aria-hidden="true"><i className="is-codex" style={{ height: `${d.codex / peak * 100}%` }} /><i className="is-claude" style={{ height: `${d.claude / peak * 100}%` }} /><i className="is-unknown" style={{ height: `${d.unknown / peak * 100}%` }} /></span>
        <small>{date.toLocaleDateString(undefined, { weekday: "short" })}</small><b>{date.getDate()}</b>
        {d.overlap && <AlertTriangle className="pa-day-flag" size={11} aria-hidden="true" />}
      </button>; })}
    </div>
    {!view.rows.length ? <p className="pa-note">No commits on main and no agent sessions on this day.</p> : <>
      <div className="ab-board">
        <div className="ab-row ab-axis-row" aria-hidden="true"><span /><div className="pa-axis">
          {view.ticks.map((t, i) => <span key={i} style={{ left: `${t.left}%` }}>{t.label}</span>)}
          {view.breaks.map((b, i) => <i key={i} title={`${Math.round(b.minutes / 60)} quiet hours`} style={{ left: `${b.left + b.width / 2}%` }}>≈</i>)}
        </div></div>
        {view.rows.slice(0, all ? undefined : SHOWN).map(row => <div className={`ab-row ${row.crossAgent ? "is-collision" : ""}`} key={row.project.repo}>
          <button className="ab-name" title={`Open ${row.project.name}`} onClick={() => onOpenProject?.(row.project.repo, { end, day: key })} disabled={!onOpenProject}>
            <ProjectEmblem id={row.project.repo} name={row.project.name} size={26} /><span><b>{row.project.name}</b><small>{row.commits} {row.commits === 1 ? "commit" : "commits"}</small></span>
          </button>
          <div className="ab-tracks">
            {view.breaks.map((b, i) => <span key={`f${i}`} className="pa-fold" style={{ left: `${b.left}%`, width: `${b.width}%` }} aria-hidden="true" />)}
            {row.bands.map((b, i) => <span key={`b${i}`} className={`pa-band ${b.overlap.crossAgent ? "is-collision" : ""}`} style={{ left: `${b.left}%`, width: `${b.width}%` }} aria-hidden="true" />)}
            {row.lanes.map(lane => <div className={`ab-lane is-${lane.agent}`} key={lane.agent} aria-label={`${NAMES[lane.agent]} in ${row.project.name}`}>
              {lane.bars.map((b, i) => <button key={i} className={`pa-bar is-${lane.agent} is-pickable ${picked?.session === b.session && !picked?.sha ? "is-picked" : ""}`} style={{ left: `${b.left}%`, width: `${b.width}%` }}
                title={sessions.get(b.session)?.title || `${NAMES[lane.agent]} session`} aria-label={`Open the ${NAMES[lane.agent]} session ${sessions.get(b.session)?.title || ""} in ${row.project.name}`} onClick={() => onPick?.({ session: b.session })} />)}
              {lane.commits.map(({ commit, left }) => <button key={commit.sha} className={`pa-dot is-${lane.agent} ${commit.evidence === "printed" || commit.evidence === "seen" ? "" : "is-likely"}`}
                style={{ left: `${left}%` }} aria-pressed={picked?.sha === commit.sha} title={`${row.project.name} · ${commit.short} ${commit.subject}`}
                aria-label={`${row.project.name}, ${NAMES[lane.agent]} commit ${commit.short}: ${commit.subject}`}
                onClick={() => onPick?.({ session: commit.session, sha: commit.sha })} />)}
            </div>)}
          </div>
        </div>)}
        {view.rows.length > SHOWN && <button className="cw-text-button ab-more" onClick={() => setAll(v => !v)}>{all ? "Show fewer projects" : `Show ${view.rows.length - SHOWN} more ${view.rows.length - SHOWN === 1 ? "project" : "projects"}`}</button>}
      </div>
      {today.length > 0 && <div className="ab-cards">{today.map(({ project, overlap }, i) => <OverlapCard key={`${project.repo}-${i}`} overlap={overlap} name={project.name} repo={project.repo} sessions={sessions} commits={project.commits} onSession={onPick ? key => onPick({ session: key }) : undefined} />)}</div>}
      <p className="pa-note">{today.length ? "" : "No Claude and Codex collisions on this day. "}{sameAgent ? `${sameAgent} more ${sameAgent === 1 ? "overlap" : "overlaps"} between sessions of one agent (plain bands). ` : ""}Tap a dot or a bar to open that session.</p>
    </>}
  </section>;
}
