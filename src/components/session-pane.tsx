"use client";

import { useMemo } from "react";
import { AlertTriangle, ArrowRight, ArrowUpRight, GitCommitHorizontal } from "lucide-react";
import type { ActivityCommit, BoardData, ProjectActivity } from "@/lib/project-activity";
import type { LibrarySession } from "./session-library";
import { ProjectBadge, ProjectEmblem } from "./project-identity";
import "./project-activity.css";

export type SessionPick = { session?: string | null; sha?: string | null };
const NAME = { claude: "Claude", codex: "Codex", unknown: "Unknown" } as const;
const agentOf = (key: string) => key.startsWith("codex:") ? "codex" : "claude";
const when = (iso: string) => `${new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}`;
const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const commitUrl = (repoUrl: string | undefined, sha: string) => /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/.test(repoUrl || "") && /^[a-f\d]{40}$/i.test(sha) ? `${repoUrl!.replace(/\/$/, "")}/commit/${sha}` : undefined;

/** The pane's title row: the agent's chip and what this is. */
export function SessionPaneTop({ pick }: { pick: SessionPick }) {
  const agent = pick.session ? agentOf(pick.session) : null;
  return <span className="sp-top">{agent ? <><span className={`cw-session-provider is-${agent}`}>{agent === "codex" ? "CX" : "CL"}</span><span>{agent === "codex" ? "Codex session" : "Claude Code session"}</span></> : <><GitCommitHorizontal size={16} /><span>Commit</span></>}</span>;
}

/** What a session did this week, as a picture first: where it worked and when, the commits it made, who else was in
 *  the same project at the same time, then the files. Opens beside the who-changed-what board. */
export default function SessionPane({ pick, board, library, repoUrls = {}, busy, onOpen, onContinue, onPick }: {
  pick: SessionPick; board: BoardData | null; library?: LibrarySession; repoUrls?: Record<string, string | undefined>; busy?: boolean;
  onOpen?: (session: LibrarySession) => void; onContinue?: (session: LibrarySession) => void; onPick: (pick: SessionPick) => void;
}) {
  const key = pick.session || "";
  const view = useMemo(() => {
    const projects = (board?.projects || []).filter(p => key && (p.sessions.some(s => s.key === key) || p.commits.some(c => c.session === key)));
    const own = projects.map(p => ({ project: p, session: p.sessions.find(s => s.key === key) }));
    const commits = projects.flatMap(p => p.commits.filter(c => c.session === key).map(commit => ({ project: p, commit }))).sort((a, b) => Date.parse(b.commit.at) - Date.parse(a.commit.at));
    const overlaps = projects.flatMap(p => p.overlaps.filter(o => o.sessions.includes(key)).map(o => ({ project: p, overlap: o }))).sort((a, b) => Date.parse(b.overlap.from) - Date.parse(a.overlap.from));
    const others = new Map((board?.projects || []).flatMap(p => p.sessions.map(s => [s.key, s] as const)));
    return { projects, own, commits, overlaps, others };
  }, [board, key]);
  const lone = !key && pick.sha ? (board?.projects || []).flatMap(p => p.commits.map(commit => ({ project: p, commit }))).find(x => x.commit.sha === pick.sha) : undefined;
  if (lone) return <LoneCommit project={lone.project} commit={lone.commit} repoUrl={repoUrls[lone.project.repo]} />;

  const agent = agentOf(key);
  const first = view.own.find(o => o.session)?.session;
  const title = library?.title || first?.title || `${NAME[agent]} session`;
  const projects = library?.projects.length ? library.projects : view.projects.map(p => ({ id: p.repo, name: p.name }));
  const edits = view.own.reduce((n, o) => n + (o.session?.edits || 0), 0);
  const older = (library?.changed || []).filter(c => !view.commits.some(x => x.commit.sha.startsWith(c.sha)));
  const span = board ? [Date.parse(board.from), Date.parse(board.to)] : [0, 1];
  const xOf = (iso: string) => Math.max(0, Math.min(100, (Date.parse(iso) - span[0]) / Math.max(1, span[1] - span[0]) * 100));
  const days = board ? Array.from({ length: board.days + 1 }, (_, i) => { const d = new Date(span[0]); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + i + 1); return d; }).filter(d => d.getTime() < span[1]) : [];

  return <div className="pa sp">
    <h2 className="sp-title">{title}</h2>
    <div className="sp-projects">{projects.map(p => <ProjectBadge key={p.id} id={p.id} name={p.name} link />)}{!projects.length && <span className="sp-muted">No project evidence</span>}</div>
    {library && <div className="sp-actions">
      {onOpen && <button className="cw-primary" disabled={busy} onClick={() => onOpen(library)} title={library.opensIn === "app" ? `Opens in the ${NAME[agent]} app` : "The desktop app does not have this conversation, so it resumes in a terminal"}>{library.opensIn === "app" ? `Open in ${NAME[agent]}` : "Resume in a terminal"}<ArrowUpRight size={15} /></button>}
      {onContinue && library.canResume && library.projects.length > 0 && <button disabled={busy} onClick={() => onContinue(library)} title="Give it a new task from Hangar, with its history">Continue from Hangar</button>}
    </div>}
    <div className="sp-stats">
      <span><b>{view.commits.length}</b>{view.commits.length === 1 ? "commit" : "commits"}</span>
      <span><b>{edits}</b>{edits === 1 ? "edit" : "edits"}</span>
      <span><b>{projects.length}</b>{projects.length === 1 ? "project" : "projects"}</span>
      {view.overlaps.some(o => o.overlap.crossAgent) && <span className="is-collision"><AlertTriangle size={13} /><b>{view.overlaps.filter(o => o.overlap.crossAgent).length}</b>{view.overlaps.filter(o => o.overlap.crossAgent).length === 1 ? "collision" : "collisions"}</span>}
    </div>

    {view.own.length > 0 && board && <section className="sp-section" aria-label="Where and when it worked this week">
      <h4>This week</h4>
      <div className="sp-week">
        <div className="sp-week-row sp-week-days" aria-hidden="true"><span />{<div className="sp-week-track">{days.map(d => <i key={d.getTime()} style={{ left: `${xOf(d.toISOString())}%` }}><small>{d.toLocaleDateString(undefined, { weekday: "short" })}</small></i>)}</div>}</div>
        {view.own.map(({ project, session }) => <div className="sp-week-row" key={project.repo}>
          <ProjectEmblem id={project.repo} name={project.name} size={20} />
          <div className="sp-week-track">
            {days.map(d => <i key={d.getTime()} style={{ left: `${xOf(d.toISOString())}%` }} aria-hidden="true" />)}
            {project.overlaps.filter(o => o.sessions.includes(key)).map((o, i) => <span key={`o${i}`} className={`pa-band ${o.crossAgent ? "is-collision" : ""}`} style={{ left: `${xOf(o.from)}%`, width: `${Math.max(1.2, xOf(o.to) - xOf(o.from))}%` }} aria-hidden="true" />)}
            {(session?.spans || []).map((s, i) => <span key={i} className={`pa-bar is-${agent}`} style={{ left: `${xOf(s.from)}%`, width: `${Math.max(1, xOf(s.to) - xOf(s.from))}%` }} />)}
            {project.commits.filter(c => c.session === key).map(c => <button key={c.sha} className={`pa-dot is-${agent}`} style={{ left: `${xOf(c.at)}%` }} aria-pressed={pick.sha === c.sha} title={`${when(c.at)} ${c.short} ${c.subject}`} aria-label={`${project.name} commit ${c.short}: ${c.subject}`} onClick={() => onPick({ session: key, sha: c.sha })} />)}
          </div>
        </div>)}
      </div>
    </section>}

    {view.overlaps.length > 0 && <section className="sp-section" aria-label="Who else worked on the same project at the same time">
      <h4>At the same time</h4>
      <ul className="sp-overlaps">{view.overlaps.map(({ project, overlap }, i) => <li key={i} className={overlap.crossAgent ? "is-collision" : ""}>
        <div className="sp-overlap-head"><ProjectEmblem id={project.repo} name={project.name} size={18} /><b>{project.name}</b><time>{when(overlap.from)}–{clock(overlap.to)}</time></div>
        <div className="sp-others">{overlap.sessions.filter(k => k !== key).map(k => { const other = view.others.get(k); return <button key={k} onClick={() => onPick({ session: k })} title="Open this session"><i className={`pa-swatch is-${agentOf(k)}`} />{other?.title || `${NAME[agentOf(k)]} session`}<ArrowRight size={12} /></button>; })}</div>
        {overlap.sharedFiles.length > 0 && <small className="sp-shared">Both touched {overlap.sharedFiles.slice(0, 3).join(", ")}{overlap.sharedFiles.length > 3 ? ` and ${overlap.sharedFiles.length - 3} more` : ""}</small>}
      </li>)}</ul>
    </section>}

    <section className="sp-section" aria-label="What it changed">
      <h4>What it changed<small>{view.commits.length + older.length}</small></h4>
      {!view.commits.length && !older.length && <p className="sp-muted">No commits on main tied to this session.</p>}
      <ol className="sp-commits">
        {view.commits.map(({ project, commit }) => <CommitLine key={commit.sha} project={project} commit={commit} repoUrl={repoUrls[project.repo]} active={pick.sha === commit.sha} onPick={() => onPick({ session: key, sha: commit.sha })} />)}
        {older.slice(0, 20).map(c => <li key={`${c.repo}-${c.sha}`} className="sp-commit is-older"><GitCommitHorizontal size={14} aria-hidden="true" /><span><b>{c.subject}</b><small>{c.repo} · {when(c.at)} · <code>{c.sha}</code></small></span></li>)}
      </ol>
    </section>

    {view.own.some(o => o.session?.files.length) && <details className="sp-files"><summary>Files it touched</summary>{view.own.filter(o => o.session?.files.length).map(({ project, session }) => <div key={project.repo}><ProjectBadge id={project.repo} name={project.name} size="xs" /><ul>{session!.files.slice(0, 40).map(f => <li key={f}>{f}</li>)}</ul>{session!.files.length > 40 && <small>{session!.files.length - 40} more</small>}</div>)}</details>}
    <p className="sp-id"><code>{library?.id || key.split(":")[1]}</code>{library?.model && <span>{library.model}</span>}</p>
  </div>;
}

function CommitLine({ project, commit, repoUrl, active, onPick }: { project: ProjectActivity; commit: ActivityCommit; repoUrl?: string; active: boolean; onPick: () => void }) {
  const url = commitUrl(repoUrl, commit.sha);
  return <li className={`sp-commit ${active ? "is-active" : ""}`}>
    <ProjectEmblem id={project.repo} name={project.name} size={18} />
    <span><button className="sp-commit-subject" onClick={onPick}>{commit.subject}</button>
      <small>{project.name} · {when(commit.at)} · {url ? <a href={url} target="_blank" rel="noopener noreferrer">{commit.short}<ArrowUpRight size={11} /></a> : <code>{commit.short}</code>}</small>
      {active && <small className="sp-why">{commit.why}{commit.files.length ? ` · ${commit.fileCount} ${commit.fileCount === 1 ? "file" : "files"}: ${commit.files.slice(0, 4).join(", ")}${commit.fileCount > 4 ? "…" : ""}` : ""}</small>}
    </span>
  </li>;
}

/** A commit no session can be tied to: what it was, where, and why Hangar cannot say who made it. */
function LoneCommit({ project, commit, repoUrl }: { project: ProjectActivity; commit: ActivityCommit; repoUrl?: string }) {
  const url = commitUrl(repoUrl, commit.sha);
  return <div className="pa sp">
    <h2 className="sp-title">{commit.subject}</h2>
    <div className="sp-projects"><ProjectBadge id={project.repo} name={project.name} detail link /></div>
    <div className="sp-stats"><span><b>{when(commit.at)}</b></span><span><i className={`pa-swatch is-${commit.agent}`} /><b>{NAME[commit.agent]}</b></span>{url ? <a className="sp-link" href={url} target="_blank" rel="noopener noreferrer">{commit.short} on GitHub<ArrowUpRight size={13} /></a> : <code>{commit.short}</code>}</div>
    <p className="sp-muted">{commit.why}.</p>
    {commit.files.length > 0 && <section className="sp-section"><h4>Files<small>{commit.fileCount}</small></h4><ul className="sp-filelist">{commit.files.map(f => <li key={f}>{f}</li>)}</ul></section>}
  </div>;
}
