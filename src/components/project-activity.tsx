"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowUpRight } from "lucide-react";
import { workspaceResponse } from "@/lib/workspace-response";
import { dayView, defaultDay, windowDays, type ActivityCommit, type ActivityData, type ActivityOverlap, type ActivitySession, type Agent } from "@/lib/project-activity";
import "./project-activity.css";
import { ProjectEmblem } from "./project-identity";

export const NAMES: Record<Agent, string> = { claude: "Claude", codex: "Codex", unknown: "Unknown" };
const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const commitUrl = (repoUrl: string | undefined, sha: string) => /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/.test(repoUrl || "") && /^[a-f\d]{40}$/i.test(sha) ? `${repoUrl!.replace(/\/$/, "")}/commit/${sha}` : undefined;

/** Who changed this project, day by day: one lane per agent, a bar per session, a dot per commit on main, and a warm
 *  band where two sessions worked on it within two hours. */
export default function ProjectActivity({ machine, repo, repoUrl }: { machine: string; repo: string; repoUrl?: string }) {
  const [data, setData] = useState<ActivityData | null>(null), [error, setError] = useState("");
  const [day, setDay] = useState(""), [picked, setPicked] = useState("");
  useEffect(() => {
    const controller = new AbortController(); setData(null); setError(""); setDay(""); setPicked("");
    fetch(`/api/world/${machine}/proxy/activity?repo=${encodeURIComponent(repo)}&days=7`, { signal: controller.signal, cache: "no-store" })
      .then(r => {
        // An engine started before this view existed has no such route until it restarts.
        if (r.status === 404) throw new Error("Hangar’s engine on this machine predates this view. Restart Hangar to see who changed what.");
        return workspaceResponse<ActivityData>(r);
      }).then(d => { if (!controller.signal.aborted) setData(d); })
      .catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [machine, repo]);
  const days = useMemo(() => data?.available ? windowDays(data) : [], [data]);
  const key = day || defaultDay(days);
  const view = useMemo(() => data?.available && key ? dayView(data, key) : null, [data, key]);
  if (error) return <section className="pa"><h3>Who changed what</h3><p className="pa-note">{error}</p></section>;
  if (!data) return <section className="pa" aria-busy="true"><h3>Who changed what</h3><div className="pa-skeleton" aria-label="Reading commits and sessions" /></section>;
  if (!data.available || !view) return null;
  const sessions = new Map(data.sessions.map(s => [s.key, s]));
  const peak = Math.max(1, ...days.map(d => d.claude + d.codex + d.unknown));
  const commit = data.commits.find(c => c.sha === picked);
  const bandsToday = view.bands.map(b => b.overlap);
  const quiet = days.every(d => !d.claude && !d.codex && !d.unknown && !d.sessions);
  return <section className="pa" aria-label={`Who changed ${data.name} in the last ${data.days} days`}>
    <div className="pa-head"><h3>Who changed what</h3><span>{data.days} days · {data.branch}</span></div>
    <div className="pa-days" role="group" aria-label="Choose a day">
      {days.map(d => { const date = new Date(`${d.key}T12:00:00`); return <button key={d.key} aria-pressed={d.key === key} className={d.crossAgent ? "is-collision" : d.overlap ? "is-overlap" : ""}
        aria-label={`${date.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}: ${d.claude} Claude, ${d.codex} Codex${d.unknown ? `, ${d.unknown} unknown` : ""} commits${d.crossAgent ? ", both agents at once" : d.overlap ? ", two sessions at once" : ""}`}
        onClick={() => { setDay(d.key); setPicked(""); }}>
        <span className="pa-day-bars" aria-hidden="true"><i className="is-codex" style={{ height: `${d.codex / peak * 100}%` }} /><i className="is-claude" style={{ height: `${d.claude / peak * 100}%` }} /><i className="is-unknown" style={{ height: `${d.unknown / peak * 100}%` }} /></span>
        <small>{date.toLocaleDateString(undefined, { weekday: "short" })}</small><b>{date.getDate()}</b>
        {d.overlap && <AlertTriangle className="pa-day-flag" size={11} aria-hidden="true" />}
      </button>; })}
    </div>
    {quiet ? <p className="pa-note">No commits on {data.branch} and no agent sessions this week.</p> : <>
      <div className="pa-plot">
        <div className="pa-bands" aria-hidden="true">
          {view.breaks.map((b, i) => <span key={i} className="pa-fold" style={{ left: `${b.left}%`, width: `${b.width}%` }} />)}
          {view.bands.map((b, i) => <span key={i} className={`pa-band ${b.overlap.crossAgent ? "is-collision" : ""}`} style={{ left: `${b.left}%`, width: `${b.width}%` }} />)}
        </div>
        {view.lanes.map(lane => <Lane key={lane.agent} lane={lane} names={NAMES} picked={picked} onPick={setPicked} />)}
        <div className="pa-axis-label" aria-hidden="true" />
        <div className="pa-axis" aria-hidden="true">
          {view.ticks.map((t, i) => <span key={i} style={{ left: `${t.left}%` }}>{t.label}</span>)}
          {view.breaks.map((b, i) => <i key={i} title={`${Math.round(b.minutes / 60)} quiet hours`} style={{ left: `${b.left + b.width / 2}%` }}>≈</i>)}
        </div>
      </div>
      {commit ? <CommitCard commit={commit} session={commit.session ? sessions.get(commit.session) : undefined} repoUrl={repoUrl} />
        : bandsToday.length ? bandsToday.map((o, i) => <OverlapCard key={i} overlap={o} name={data.name} sessions={sessions} commits={data.commits} />)
        : <p className="pa-note">Tap a dot to see the commit and the session that made it.</p>}
    </>}
  </section>;
}

function Lane({ lane, names, picked, onPick }: { lane: ReturnType<typeof dayView>["lanes"][number]; names: Record<Agent, string>; picked: string; onPick: (sha: string) => void }) {
  return <>
    <div className={`pa-lane-name is-${lane.agent}`}><i className={`pa-swatch is-${lane.agent}`} />{names[lane.agent]}</div>
    <div className={`pa-lane-rule is-${lane.agent}`} />
    {lane.rows.length ? lane.rows.map((row, i) => <Row key={row.session?.key || `none-${i}`} row={row} name={row.session ? row.session.title || `${names[lane.agent]} session` : "No session found"} picked={picked} onPick={onPick} />)
      : <><div className="pa-row-label is-empty">—</div><div className="pa-track is-empty" /></>}
  </>;
}

function Row({ row, name, picked, onPick }: { row: ReturnType<typeof dayView>["lanes"][number]["rows"][number]; name: string; picked: string; onPick: (sha: string) => void }) {
  return <>
    <div className={`pa-row-label ${row.session ? "" : "is-orphan"}`} title={name}>{name}</div>
    <div className="pa-track">
      {row.bars.map((b, i) => <span key={i} className={`pa-bar is-${row.agent}`} style={{ left: `${b.left}%`, width: `${b.width}%` }} />)}
      {row.commits.map(({ commit, left }) => <button key={commit.sha} className={`pa-dot is-${row.agent} ${commit.evidence === "printed" || commit.evidence === "seen" ? "" : "is-likely"}`}
        style={{ left: `${left}%` }} aria-pressed={picked === commit.sha} title={`${clock(commit.at)} ${commit.short} ${commit.subject}`}
        aria-label={`${clock(commit.at)}, ${row.agent === "unknown" ? "unknown agent" : row.agent} commit ${commit.short}: ${commit.subject}`}
        onClick={() => onPick(picked === commit.sha ? "" : commit.sha)} />)}
    </div>
  </>;
}

export function CommitCard({ commit, session, repoUrl, project, projectId }: { commit: ActivityCommit; session?: ActivitySession; repoUrl?: string; project?: string; projectId?: string }) {
  const url = commitUrl(repoUrl, commit.sha);
  return <div className={`pa-card is-${commit.agent}`} role="status">
    <div className="pa-card-top"><i className={`pa-swatch is-${commit.agent}`} />{project && <span className="pa-card-project"><ProjectEmblem id={projectId} name={project} size={16} /><b>{project}</b></span>}<time dateTime={commit.at}>{clock(commit.at)}</time>
      {url ? <a href={url} target="_blank" rel="noopener noreferrer">{commit.short}<ArrowUpRight size={12} /></a> : <code>{commit.short}</code>}</div>
    <b>{commit.subject}</b>
    <small>{session ? session.title || `${NAMES[session.provider]} session` : commit.agent === "unknown" ? "No agent session found" : `${NAMES[commit.agent]} · no session found`} · {commit.why}</small>
  </div>;
}

export function OverlapCard({ overlap, name, repo, sessions, commits }: { overlap: ActivityOverlap; name: string; repo?: string; sessions: Map<string, ActivitySession>; commits: ActivityCommit[] }) {
  const from = Date.parse(overlap.from), to = Date.parse(overlap.to);
  return <div className={`pa-card pa-overlap ${overlap.crossAgent ? "is-collision" : ""}`} role="status">
    <div className="pa-card-top"><AlertTriangle size={14} />{repo && <ProjectEmblem id={repo} name={name} size={20} />}<b>{overlap.crossAgent ? "Claude and Codex both changed" : `${overlap.sessions.length} sessions changed`} {name}</b><time>{clock(overlap.from)}–{clock(overlap.to)}</time></div>
    <ul>{overlap.sessions.map(k => { const s = sessions.get(k); const made = commits.filter(c => c.session === k && Date.parse(c.at) >= from - 60_000 && Date.parse(c.at) <= to + 60_000).length; return s && <li key={k}><i className={`pa-swatch is-${s.provider}`} /><span>{s.title || `${NAMES[s.provider]} session`}</span><small>{made} {made === 1 ? "commit" : "commits"}</small></li>; })}</ul>
    {overlap.sharedFiles.length > 0 ? <small>Both touched {overlap.sharedFiles.slice(0, 3).join(", ")}{overlap.sharedFiles.length > 3 ? ` and ${overlap.sharedFiles.length - 3} more` : ""}.</small> : <small>Different files, same project.</small>}
  </div>;
}
