"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Bot, MessageSquareReply, Network, Play, RotateCcw, Send, Square, Terminal, TriangleAlert } from "lucide-react";
import AgentMark from "./agent-mark";
import HangarLoading from "./hangar-loading";
import { SignInNotice } from "./agent-sign-in";
import { ProjectEmblem } from "./project-identity";

export type HangarJob = { id: string; repo: string; project: string; provider: string; prompt: string; state: string; kind?: string; opensIn?: "app" | "terminal"; startedAt: string; endedAt: string | null; exitCode: number | null; session?: string; output: { at: string; text: string }[] };

export const jobRunning = (j: HangarJob) => j.state === "running" || j.state === "stopping";
/** Still on the agent's side: running, stopping, or last seen running and not checked since. */
const open = (j: HangarJob) => jobRunning(j) || j.state === "unobserved";
const agentOf = (j: HangarJob) => j.provider === "codex" ? "codex" : "claude";
const agentName = (j: HangarJob) => j.provider === "codex" ? "Codex" : "Claude Code";
const kindName = (j: HangarJob) => j.kind === "architecture" ? "Architecture drawing" : "Coding task";
/** What was asked: a task started from the composer carries the project's context first (see taskPrompt), then the ask. */
const asked = (j: HangarJob) => j.prompt.split("User task (authoritative):\n").at(-1)!.trim();

/** A job's state in words. */
export function jobState(job: HangarJob) {
  return { running: "Running", stopping: "Stopping", completed: "Finished", failed: "Failed", stopped: "Stopped", unobserved: "Not seen", acknowledged: "Closed" }[job.state] || job.state;
}
/** How long the job ran, or has been running. */
function took(job: HangarJob) {
  const min = Math.max(0, Math.round(((job.endedAt ? Date.parse(job.endedAt) : Date.now()) - Date.parse(job.startedAt)) / 60000));
  return min < 1 ? "under a minute" : min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}
/** Why a failed job stopped: its last line that is not the start line ("You've hit your session limit"). */
function reason(job: HangarJob) {
  if (job.state !== "failed") return "";
  const line = [...job.output].reverse().find(l => l.text.trim() && !/^Started\b/.test(l.text));
  const text = line?.text.trim().split("\n")[0] || (job.exitCode ? `The agent stopped with exit code ${job.exitCode}.` : "");
  return text.length > 140 ? `${text.slice(0, 137)}…` : text;
}
function dayOf(value: string) {
  const date = new Date(value), today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.round((today.getTime() - new Date(date).setHours(0, 0, 0, 0)) / 86400000);
  return days <= 0 ? "Today" : days === 1 ? "Yesterday" : date.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
}

type Filter = "all" | "open" | "failed" | "done";

/** Every job Hangar started, laid out in full: how a job works, then the running ones, then each day's jobs. A job
 *  opens beside the list (`onPick`) to read and to carry on. */
export function JobsList({ jobs, machine, machineName, liveError, picked, onPick, onStart }: {
  jobs: HangarJob[]; machine: string; machineName: string; liveError: string; picked: string | null; onPick: (id: string) => void; onStart: () => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const counts = { all: jobs.length, open: jobs.filter(open).length, failed: jobs.filter(j => j.state === "failed").length, done: jobs.filter(j => !open(j) && j.state !== "failed").length };
  const shown = jobs.filter(j => filter === "all" || (filter === "open" ? open(j) : filter === "failed" ? j.state === "failed" : !open(j) && j.state !== "failed"));
  const groups = useMemo(() => {
    const list: { label: string; jobs: HangarJob[] }[] = [];
    const live = shown.filter(open);
    if (live.length) list.push({ label: "Running now", jobs: live });
    for (const job of shown.filter(j => !open(j))) {
      const label = dayOf(job.startedAt), last = list.at(-1);
      if (last && last.label === label) last.jobs.push(job); else list.push({ label, jobs: [job] });
    }
    return list;
  }, [shown]);
  const row = (job: HangarJob) => { const why = reason(job); return <button key={job.id} className="jb-row" aria-pressed={picked === job.id} onClick={() => onPick(job.id)} title="Open this job">
    <span className={`jv-agent is-${agentOf(job)}`}><AgentMark agent={job.provider} /></span>
    <span className="jb-text">
      <b><ProjectEmblem id={job.repo} name={job.project} size={18} />{job.project}<em>{kindName(job)}</em></b>
      <small>{asked(job)}</small>
      {why && <small className="jb-why"><TriangleAlert size={12} aria-hidden="true" />{why}</small>}
    </span>
    <span className={`jv-state is-${jobRunning(job) && !liveError ? "running" : job.state}`}>{jobState(job)}</span>
    <span className="jb-when"><b>{new Date(job.startedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</b><small>{took(job)}</small></span>
  </button>; };
  return <div className="jb">
    <div className="cw-section-title"><h2>Jobs Hangar ran</h2><button className="cw-primary jb-start" onClick={onStart}><Play size={14} />Start a task</button></div>
    <ol className="jb-how" aria-label="How a Hangar job works">
      <li><Play size={18} aria-hidden="true" /><span><b>You start it</b><small>From a project: Start a task, or draw its architecture</small></span></li>
      <li><Bot size={18} aria-hidden="true" /><span><b>An agent works on its own</b><small>Claude Code or Codex, in the project’s folder on {machineName}</small></span></li>
      <li><MessageSquareReply size={18} aria-hidden="true" /><span><b>You check and carry on</b><small>Open a job to see what it did, reply, or open it in the app</small></span></li>
    </ol>
    <SignInNotice machine={machine} machineName={machineName} agent="claude" compact /><SignInNotice machine={machine} machineName={machineName} agent="codex" compact />
    {liveError && <p role="alert" className="cw-error">{liveError}. Last observed work may be stale.</p>}
    {jobs.length ? <>
      <nav className="cw-family-tabs jb-filters" aria-label="Show jobs">
        {([["all", "All"], ["open", "Running"], ["failed", "Failed"], ["done", "Finished"]] as const).map(([id, label]) =>
          <button key={id} aria-pressed={filter === id} disabled={!counts[id] && id !== "all"} onClick={() => setFilter(id)} className={id === "failed" && counts.failed ? "is-failed" : id === "open" && counts.open ? "is-live" : ""}>{label}<small>{counts[id]}</small></button>)}
      </nav>
      {groups.map(group => <section className="jb-day" key={group.label} aria-label={group.label}><h3>{group.label}<small>{group.jobs.length}</small></h3>{group.jobs.map(row)}</section>)}
    </> : <div className="cw-empty-inline"><Terminal size={24} /><div><b>No jobs yet.</b><p>Start a task from a project and it shows up here while it runs.</p></div><button onClick={onStart}>Choose a project</button></div>}
  </div>;
}

/** The pane's top line: which agent ran it and what kind of job it is. */
export function JobTop({ job }: { job: HangarJob }) {
  return <span className="sp-top"><span className={`cw-session-provider is-${agentOf(job)}`}><AgentMark agent={job.provider} /></span><span>{agentName(job)} · {kindName(job)}</span></span>;
}

/** One job: what was asked, how it went, what the agent did step by step, and the ways on from here — reply to keep
 *  the conversation going, run it again, open it in the app, see the drawing, or stop it. */
export function JobDetail({ job, machine, machineName, local, busy, message, live, blocked, onStop, onAcknowledge, onOpen, onRun, onDrawing }: {
  job: HangarJob; machine: string; machineName: string; local: boolean; busy: boolean; message: string; live: boolean; blocked: boolean;
  onStop: () => void; onAcknowledge: () => void; onOpen: () => void; onRun: (prompt: string, session: string | null) => Promise<boolean>; onDrawing: () => void;
}) {
  const log = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [reply, setReply] = useState("");
  // Older jobs logged bare event names; they carry nothing to read.
  const lines = job.output.filter(l => !/^(system|user|assistant|result|rate_limit_event|stream_event|Agent activity)( · .*)?$/.test(l.text.trim()));
  useEffect(() => { const el = log.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [lines.length]);
  const action = (t: string) => /^(Ran|Read|Edited|Wrote|Searched|Looked for|Changed|Used|Updated its plan|Asked a helper|Started)\b/.test(t);
  // Drawing jobs run read-only and ephemeral: there is no conversation to reopen even when one was recorded.
  const drawing = job.kind === "architecture";
  const openable = !!job.session && !drawing;
  const why = reason(job);
  // Long structured replies (a drawing's JSON) fold away instead of filling the view.
  const bulky = (t: string) => t.length > 600 && /^\s*(\{|\[|```)/.test(t);
  const send = async () => { if (await onRun(reply.trim(), job.session || null)) setReply(""); };
  return <div className="jd">
    <h2 className="jd-prompt">{asked(job)}</h2>
    <div className="jv-facts"><span><ProjectEmblem id={job.repo} name={job.project} size={18} />{job.project}</span><span className={`jv-state is-${live ? "running" : job.state}`}>{jobState(job)}</span><span>{dayOf(job.startedAt)}, {new Date(job.startedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })} · {live ? "running for " : "took "}{took(job)}</span></div>
    {why && <p className="jd-why"><TriangleAlert size={15} aria-hidden="true" />{why}</p>}
    <div className="jv-actions">
      {drawing && !live && <button className="cw-primary" onClick={onDrawing}><Network size={15} />See the drawing</button>}
      {openable && local && !live && <button className={drawing ? "" : "cw-primary"} disabled={busy} title={job.opensIn === "app" ? "Opens in the desktop app" : "The desktop app does not have this conversation, so it resumes in a terminal"} onClick={onOpen}>{job.opensIn === "app" ? `Open in ${job.provider === "codex" ? "Codex" : "Claude"}` : "Resume in a terminal"}<ArrowRight size={15} /></button>}
      {!drawing && !live && job.state !== "unobserved" && <button disabled={busy || blocked} title={blocked ? "Another job is running in this project" : "Start the same task again, in a fresh conversation"} onClick={() => void onRun(job.prompt, null)}><RotateCcw size={14} />Run again</button>}
      {job.state === "unobserved" ? <button disabled={busy} onClick={onAcknowledge}>I checked: this job is no longer running</button>
        : live && <button disabled={busy || job.state === "stopping"} onClick={onStop}><Square size={14} />{job.state === "stopping" ? "Stopping…" : "Stop this job"}</button>}
    </div>
    {openable && !live && job.state !== "unobserved" && <form className="jd-reply" onSubmit={e => { e.preventDefault(); if (reply.trim()) void send(); }}>
      <label htmlFor={`jd-reply-${job.id}`}>Reply to keep it going</label>
      <textarea id={`jd-reply-${job.id}`} rows={3} value={reply} placeholder={`Tell ${agentName(job)} what to do next…`} onChange={e => setReply(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && reply.trim()) { e.preventDefault(); void send(); } }} />
      <div><small>{blocked ? "Another job is running in this project. Reply when it finishes." : `Runs as a new job that continues this conversation on ${machineName}.`}</small><button type="submit" className="cw-primary" disabled={busy || blocked || !reply.trim()}><Send size={14} />Send</button></div>
    </form>}
    {!openable && !live && <p className="cw-muted jd-note">{drawing ? "A drawing job is read-only: it keeps no conversation to reply to. Redraw it from the project’s Architecture tab." : "No conversation was recorded for this job, so it can only run again."}</p>}
    {!live && job.state === "failed" && <SignInNotice machine={machine} machineName={machineName} agent={agentOf(job)} compact />}
    {message && <p role="status" className="jv-message">{message}</p>}
    <h3 className="jd-heading">What the agent did</h3>
    <div className="jv-log" ref={log} role="log" aria-label="What the agent did" onScroll={e => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
      {lines.length ? lines.map((line, i) => action(line.text)
        ? <p key={`${i}-${line.at}`} className="jv-step"><time>{new Date(line.at).toLocaleTimeString()}</time><span>{line.text}</span></p>
        : bulky(line.text) ? <details key={`${i}-${line.at}`} className="jv-bulky"><summary><time>{new Date(line.at).toLocaleTimeString()}</time>Structured reply · {line.text.split("\n").length} lines</summary><pre>{line.text}</pre></details>
        : <div key={`${i}-${line.at}`} className="jv-say"><time>{new Date(line.at).toLocaleTimeString()}</time><p>{line.text}</p></div>)
        : live ? <HangarLoading compact label="Waiting for the agent’s first step" steps={["Starting the agent", "Reading the project", "Planning the first step"]} /> : <p className="cw-muted">This job left no readable output.</p>}
    </div>
  </div>;
}
