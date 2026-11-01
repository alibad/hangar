"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowRight } from "lucide-react";
import { workspaceResponse } from "@/lib/workspace-response";
import { boardDay, boardTotals, defaultDay, windowDays, type ActivitySession, type BoardData } from "@/lib/project-activity";
import { CommitCard, NAMES, OverlapCard } from "./project-activity";
import "./project-activity.css";

const SHOWN = 8; // collisions and the busiest projects first; the quiet tail on request

/** Every project's week at once: which agent changed what, and where Claude and Codex worked on the same project at
 *  the same time. One row per project, a Claude lane over a Codex lane, all on one clock. */
export default function ActivityBoard({ machine, repoUrls = {}, onOpenProject }: { machine: string; repoUrls?: Record<string, string | undefined>; onOpenProject?: (repo: string) => void }) {
  const [data, setData] = useState<BoardData | null>(null), [error, setError] = useState("");
  const [day, setDay] = useState(""), [picked, setPicked] = useState(""), [all, setAll] = useState(false);
  useEffect(() => {
    const controller = new AbortController(); setData(null); setError(""); setDay(""); setPicked("");
    fetch(`/api/world/${machine}/proxy/activity/all?days=7`, { signal: controller.signal, cache: "no-store" })
      .then(r => {
        if (r.status === 404) throw new Error("Hangar’s engine on this machine predates this view. Restart Hangar to see who changed what.");
        return workspaceResponse<BoardData>(r);
      }).then(d => { if (!controller.signal.aborted) setData(d); })
      .catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [machine]);
  const totals = useMemo(() => data?.available ? boardTotals(data) : null, [data]);
  const days = useMemo(() => totals ? windowDays(totals) : [], [totals]);
  const key = day || defaultDay(days);
  const view = useMemo(() => data?.available && key ? boardDay(data, key) : null, [data, key]);
  const sessions = useMemo(() => new Map<string, ActivitySession>((data?.projects || []).flatMap(p => p.sessions.map(s => [s.key, s] as const))), [data]);
  // The Sessions tab already names the view; the board only says what it covers.
  const head = <p className="ab-scope">All projects · last {data?.days || 7} days · main</p>;
  if (error) return <section className="pa ab">{head}<p className="pa-note">{error}</p></section>;
  if (!data || !totals || !view) return <section className="pa ab" aria-busy="true">{head}<div className="pa-skeleton" aria-label="Reading every project's commits and sessions" /></section>;
  const peak = Math.max(1, ...days.map(d => d.claude + d.codex + d.unknown));
  const collisions = totals.overlaps.filter(o => o.crossAgent).length;
  const picked_ = picked ? data.projects.flatMap(p => p.commits.map(c => ({ project: p, commit: c }))).find(x => x.commit.sha === picked) : undefined;
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
        onClick={() => { setDay(d.key); setPicked(""); setAll(false); }}>
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
          <button className="ab-name" title={`Open ${row.project.name}`} onClick={() => onOpenProject?.(row.project.repo)} disabled={!onOpenProject}>
            <b>{row.project.name}</b><small>{row.commits} {row.commits === 1 ? "commit" : "commits"}</small>
          </button>
          <div className="ab-tracks">
            {view.breaks.map((b, i) => <span key={`f${i}`} className="pa-fold" style={{ left: `${b.left}%`, width: `${b.width}%` }} aria-hidden="true" />)}
            {row.bands.map((b, i) => <span key={`b${i}`} className={`pa-band ${b.overlap.crossAgent ? "is-collision" : ""}`} style={{ left: `${b.left}%`, width: `${b.width}%` }} aria-hidden="true" />)}
            {row.lanes.map(lane => <div className={`ab-lane is-${lane.agent}`} key={lane.agent} aria-label={`${NAMES[lane.agent]} in ${row.project.name}`}>
              {lane.bars.map((b, i) => <span key={i} className={`pa-bar is-${lane.agent}`} style={{ left: `${b.left}%`, width: `${b.width}%` }} />)}
              {lane.commits.map(({ commit, left }) => <button key={commit.sha} className={`pa-dot is-${lane.agent} ${commit.evidence === "printed" || commit.evidence === "seen" ? "" : "is-likely"}`}
                style={{ left: `${left}%` }} aria-pressed={picked === commit.sha} title={`${row.project.name} · ${commit.short} ${commit.subject}`}
                aria-label={`${row.project.name}, ${NAMES[lane.agent]} commit ${commit.short}: ${commit.subject}`}
                onClick={() => setPicked(picked === commit.sha ? "" : commit.sha)} />)}
            </div>)}
          </div>
        </div>)}
        {view.rows.length > SHOWN && <button className="cw-text-button ab-more" onClick={() => setAll(v => !v)}>{all ? "Show fewer projects" : `Show ${view.rows.length - SHOWN} more ${view.rows.length - SHOWN === 1 ? "project" : "projects"}`}</button>}
      </div>
      {picked_ ? <div className="ab-detail"><CommitCard commit={picked_.commit} project={picked_.project.name} session={picked_.commit.session ? sessions.get(picked_.commit.session) : undefined} repoUrl={repoUrls[picked_.project.repo]} />
          {onOpenProject && <button className="cw-text-button" onClick={() => onOpenProject(picked_.project.repo)}>Open {picked_.project.name} <ArrowRight size={14} /></button>}</div>
        : <>{today.length > 0 && <div className="ab-cards">{today.map(({ project, overlap }, i) => <OverlapCard key={`${project.repo}-${i}`} overlap={overlap} name={project.name} sessions={sessions} commits={project.commits} />)}</div>}
          <p className="pa-note">{today.length ? "" : "No Claude and Codex collisions on this day. "}{sameAgent ? `${sameAgent} more ${sameAgent === 1 ? "overlap" : "overlaps"} between sessions of one agent (plain bands). ` : ""}Tap a dot to see the commit and the session that made it.</p></>}
    </>}
  </section>;
}
