"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, ArrowRight, Check, ChevronRight, Cpu, Globe2, Laptop, Layers, Play, Plus, RefreshCw, Search, Server, Square, Terminal, X } from "lucide-react";
import { useTheme } from "./theme-provider";
import type { ConsoleTab } from "@/lib/labs";
import type { Peer } from "@/lib/fleet-policy";
import "./connected-workspace.css";

type Site = { role: string; branch?: string; dirty?: number; ahead?: number; behind?: number; rel: string };
type Repo = { id: string; name: string; family: string; description?: string; purpose?: string; sites: Site[]; meaning?: { purpose?: string; next?: string }; risks?: { id: string; text: string }[] };
type AtlasDoc = { generatedAt: string; repos: Repo[]; families: { id: string; name: string; repos: number }[]; apps: { id: string; name: string }[] };
type Session = { id: string; provider: string; model: string; updatedAt: string; state: string; summary: string; canResume: boolean; projects: { id: string; name: string; evidence: string; files: string[] }[] };
type Job = { id: string; repo: string; project: string; provider: string; prompt: string; state: string; startedAt: string; endedAt: string | null; exitCode: number | null; session?: string; output: { at: string; text: string }[] };
type Apps = { repo: string; running: { port: number; by: string }[]; apps: { label: string; targets: { id: string; label: string; ok: boolean; why: string }[] }[] };
type Model = { id: string; target: string; provider: string; mode: string; status: string; local: boolean; detail?: string; resident?: boolean };
type Machine = { id: string; name: string; port?: number; sshAlias?: string };
type MachineStatus = { machine: string; name: string; atlas: boolean; platform: string; observedAt: string; error?: string; memory?: { kind: string; vramTotalGb?: number; ramTotalGb?: number } };
type View = "world" | "projects" | "sessions" | "machines" | "models";
export const WORLD_TABS = new Set<string>(["world", "projects", "sessions", "machines", "models"]);
const running = (j: Job) => j.state === "running" || j.state === "stopping";
function since(value?: string) {
  if (!value) return "Not observed";
  const min = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60000));
  return min < 1 ? "just now" : min < 60 ? `${min}m ago` : min < 1440 ? `${Math.floor(min / 60)}h ago` : `${Math.floor(min / 1440)}d ago`;
}
async function json<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { method: body === undefined ? "GET" : "POST", signal, cache: "no-store",
    headers: body === undefined ? undefined : { "Content-Type": "application/json", "X-Hangar": "1" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : `Request failed (${response.status})`);
  return data;
}

export default function ConnectedWorkspace({ view, active, onSelect }: { view: View; active: boolean; onSelect: (tab: ConsoleTab) => void }) {
  const { theme } = useTheme();
  const [machines, setMachines] = useState<Machine[]>([]);
  const [machine, setMachine] = useState("local");
  const [statuses, setStatuses] = useState<Record<string, MachineStatus>>({});
  const [doc, setDoc] = useState<AtlasDoc | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionsError, setSessionsError] = useState("");
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [apps, setApps] = useState<Apps[]>([]);
  const [liveError, setLiveError] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [family, setFamily] = useState("");
  const [lens, setLens] = useState("map");
  const [ready, setReady] = useState(false);
  const [revision, setRevision] = useState(0);
  const [composer, setComposer] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [provider, setProvider] = useState("codex");
  const [resume, setResume] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [inspectJob, setInspectJob] = useState<string | null>(null);
  const iframe = useRef<HTMLIFrameElement>(null);
  const prefix = `/api/atlas/${machine}/proxy`;
  const machineName = machines.find(m => m.id === machine)?.name || "This machine";
  const project = doc?.repos.find(r => r.id === selected);
  const projectSessions = sessions.filter(s => s.projects.some(p => p.id === selected));
  const liveJobs = jobs.filter(running);
  const appCount = apps.reduce((n, app) => n + app.running.length, 0);
  const send = useCallback((type: string, data: Record<string, unknown> = {}) => iframe.current?.contentWindow?.postMessage({ source: "hangar", type, ...data }, window.location.origin), []);
  const reload = () => setRevision(v => v + 1);

  useEffect(() => {
    const controller = new AbortController();
    json<{ local: Machine; peers: Peer[] }>("/api/fleet", undefined, controller.signal).then(data => setMachines([data.local, ...data.peers])).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [revision]);
  useEffect(() => {
    if (!active || !machines.length) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (document.hidden) { timer = setTimeout(poll, 15000); return; }
      await Promise.all(machines.map(async node => {
        try {
          const data = await json<MachineStatus>(`/api/fleet/${node.id}/status`, undefined, controller.signal);
          if (!controller.signal.aborted) setStatuses(s => ({ ...s, [node.id]: data }));
        } catch (e) { if (!controller.signal.aborted) setStatuses(s => ({ ...s, [node.id]: { ...s[node.id], error: (e as Error).message } })); }
      }));
      if (!controller.signal.aborted) timer = setTimeout(poll, 15000);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [active, machines, revision]);
  useEffect(() => {
    const controller = new AbortController();
    setDoc(null); setError(""); setReady(false); setJobs([]); setApps([]); setSessions([]); setSessionsLoaded(false); setSessionsError("");
    json<AtlasDoc>(`${prefix}/atlas`, undefined, controller.signal).then(setDoc).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    json<{ sessions: Session[] }>(`${prefix}/sessions`, undefined, controller.signal).then(data => { setSessions(data.sessions); setSessionsLoaded(true); }).catch(e => { if (!controller.signal.aborted) setSessionsError(e.message); });
    return () => controller.abort();
  }, [prefix, revision]);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (document.hidden) { timer = setTimeout(poll, 5000); return; }
      try {
        const [work, appData] = await Promise.all([json<{ jobs: Job[] }>(`${prefix}/work`, undefined, controller.signal), json<{ apps: Apps[] }>(`${prefix}/apps`, undefined, controller.signal)]);
        if (!controller.signal.aborted) { setJobs(work.jobs); setApps(appData.apps); setLiveError(""); }
      } catch (e) { if (!controller.signal.aborted) setLiveError((e as Error).message); }
      if (!controller.signal.aborted) timer = setTimeout(poll, 5000);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [prefix, active, revision]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== iframe.current?.contentWindow || event.data?.source !== "atlas") return;
      if (event.data.type === "ready") setReady(true);
      if (event.data.type === "job") setInspectJob(event.data.id);
      if (event.data.type === "select") { setSelected(event.data.repo); setComposer(false); setResume(null); }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);
  useEffect(() => { if (ready) { send("theme", { night: theme === "dark" }); send("lens", { lens }); } }, [ready, theme, lens, send]);
  useEffect(() => { if (ready) send("visibility", { visible: active && view === "world" }); }, [active, view, ready, send]);
  useEffect(() => { if (ready) send("work", { jobs: liveError ? [] : jobs.filter(running).map(j => ({ id: j.id, repo: j.repo, provider: j.provider, state: j.state })) }); }, [ready, jobs, liveError, send]);
  useEffect(() => { setComposer(false); setResume(null); setMessage(""); setInspectJob(null); }, [machine]);

  const repos = useMemo(() => (doc?.repos ?? []).filter(r => (!family || r.family === family) && `${r.name} ${r.description ?? ""}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => {
    const score = (r: Repo) => jobs.some(j => j.repo === r.id && running(j)) ? 3 : apps.some(a => a.repo === r.id && a.running.length) ? 2 : r.sites.some(s => s.dirty) ? 1 : 0;
    return score(b) - score(a) || a.name.localeCompare(b.name);
  }), [doc, query, family, jobs, apps]);
  const choose = (repo: Repo) => { setSelected(repo.id); setComposer(false); setResume(null); send("select", { repo: repo.id }); };
  async function act(path: string, body: unknown) {
    setBusy(true); setMessage("");
    try { await json(`${prefix}/${path}`, body); setMessage("Request accepted."); return true; }
    catch (e) { setMessage((e as Error).message); return false; }
    finally { setBusy(false); }
  }
  const continueSession = (session: Session) => {
    const repo = session.projects.find(p => p.id === selected) || session.projects.find(p => doc?.repos.some(r => r.id === p.id));
    if (!repo) return;
    setSelected(repo.id); setProvider(session.provider); setResume(session.id); setComposer(true); setPrompt("");
  };

  return <section className="connected-workspace" aria-label="Connected workspace" hidden={!active}>
    <div className="cw-heading"><div><span className="cw-eyebrow">YOUR CONNECTED WORKSPACE</span><h1>{view === "world" ? "A world of work." : { projects: "Your projects.", sessions: "Work in motion.", machines: "One workspace. More power.", models: "Intelligence, wherever it runs." }[view]}</h1></div><button className="cw-icon" onClick={reload} aria-label="Refresh connected workspace"><RefreshCw size={18} /></button></div>
    <div className="cw-machine-rail" aria-label="Machine scope">
      {machines.map(node => { const status = statuses[node.id]; const online = status && !status.error; return <button key={node.id} className={`cw-machine ${machine === node.id ? "is-selected" : ""}`} aria-pressed={machine === node.id} onClick={() => setMachine(node.id)}><span className={`cw-led ${online ? "is-live" : status?.error ? "is-offline" : ""}`} />{node.id === "local" ? <Server size={18} /> : <Laptop size={18} />}<span><b>{node.name}</b><small>{status?.error ? "Connection lost" : online ? node.id === "local" ? "Hangar host" : "SSH connected" : "Checking connection"}</small></span><ChevronRight size={14} /></button>; })}
      <button className="cw-connect" onClick={() => onSelect("machines")}><Plus size={16} /><span>Connect a machine</span></button>
    </div>
    {liveError && doc && !["models", "machines"].includes(view) && <p className="cw-error" role="status">Live updates unavailable. App and job state below is the last observation.</p>}
    {message && <div className="cw-message" role="status">{message}<button aria-label="Dismiss message" onClick={() => setMessage("")}><X size={15} /></button></div>}
    <>
      {view === "machines" && <Machines machines={machines} statuses={statuses} onSaved={reload} onSelect={onSelect} />}
      {view === "models" && <FleetModels machine={machine} name={machineName} onSelect={onSelect} />}
      {error && !["models", "machines"].includes(view) && <div className="cw-empty" role="alert"><Globe2 size={34} /><h2>The world is waiting for Atlas.</h2><p>{error}</p><button className="cw-primary" onClick={() => onSelect("machines")}>Open Machines <ArrowRight size={16} /></button></div>}
      <div className="cw-world-layout" hidden={view !== "world" || !!error}>
        <div className="cw-world">
          <div className="cw-world-caption"><span className="cw-eyebrow">{machineName} / PROJECT ATLAS</span><p>{doc ? `${doc.families.length} islands · ${doc.repos.length} projects` : "Connecting to your world…"}</p></div>
          <div className="cw-lenses" aria-label="World lens">{[["map", "World"], ["changes", "Needs attention"], ["activity", "Activity"]].map(([id, name]) => <button key={id} aria-pressed={lens === id} onClick={() => setLens(id)}>{name}</button>)}</div>
          {doc && <iframe ref={iframe} title={`Atlas project world on ${machineName}`} src={`/api/atlas/${machine}/view/index.html?embed=hangar&lens=map`} allow="clipboard-write" />}
          {!ready && <div className="cw-world-loading"><Globe2 size={40} /><span>{doc ? "Drawing your islands…" : "Reading Atlas…"}</span></div>}
          <div className="cw-live-strip"><span className={`cw-led ${!liveError ? "is-live" : "is-offline"}`} /><b>{liveError ? "Live connection lost" : `${liveJobs.length} coding ${liveJobs.length === 1 ? "job" : "jobs"} · ${appCount} running apps`}</b><button onClick={() => onSelect("sessions")}>Inspect work <ArrowRight size={14} /></button></div>
        </div>
        <aside className="cw-inspector" aria-label={project ? `${project.name} details` : "Explore projects"}>
          {project ? <ProjectDetail project={project} machine={machine} machineName={machineName} sessions={projectSessions} jobs={jobs.filter(j => j.repo === project.id)} app={apps.find(a => a.repo === project.id)} busy={busy} onClose={() => { setSelected(null); send("select", { repo: null }); }} onStart={() => { setComposer(true); setResume(null); setPrompt(""); }} onContinue={continueSession} onAction={act} onJob={setInspectJob} onSelect={onSelect} /> : <><span className="cw-eyebrow">EXPLORE THE ISLANDS</span><h2>Pick up where<br />you left off.</h2><p className="cw-muted">Every building is a real project. Select one to see its work, sessions and running apps.</p><ProjectSearch query={query} setQuery={setQuery} />{repos.slice(0, 9).map(r => <ProjectRow key={r.id} repo={r} jobs={jobs} apps={apps} onClick={() => choose(r)} />)}<button className="cw-text-button" onClick={() => onSelect("projects")}>Explore all projects <ArrowRight size={15} /></button></>}
        </aside>
      </div>
      {view === "projects" && <div className="cw-project-browser"><div className="cw-browser-toolbar"><ProjectSearch query={query} setQuery={setQuery} /><span className="cw-muted">{repos.length} projects on this map</span></div><div className="cw-family-tabs"><button aria-pressed={!family} onClick={() => setFamily("")}>All islands</button>{doc?.families.map(f => <button key={f.id} aria-pressed={family === f.id} onClick={() => setFamily(f.id)}>{f.name}<small>{f.repos}</small></button>)}</div><div className="cw-project-grid">{repos.map(repo => <button className={`cw-project-tile ${repo.id === selected ? "is-selected" : ""}`} key={repo.id} onClick={() => { choose(repo); onSelect("world"); }}><span className="cw-eyebrow">{doc?.families.find(f => f.id === repo.family)?.name || repo.family}</span><Layers size={27} /><h2>{repo.name}</h2><p>{repo.meaning?.purpose || repo.description || "Open the project to explore its work."}</p><footer><span>{repo.sites.length ? `${repo.sites.length} local ${repo.sites.length === 1 ? "checkout" : "checkouts"}` : "Not on this machine"}</span><ArrowRight size={16} /></footer></button>)}</div>{doc && !repos.length && <p className="cw-empty">No projects match that search.</p>}</div>}
      {view === "sessions" && <div className="cw-sessions"><div className="cw-section-title"><h2><Activity size={20} /> Live coding jobs</h2><span>{machineName}</span></div>{liveError && <p role="alert" className="cw-error">{liveError}. Last observed work may be stale.</p>}{jobs.length ? jobs.map(job => <button className="cw-job-row" key={job.id} onClick={() => setInspectJob(job.id)}><span className={`cw-led ${running(job) && !liveError ? "is-live" : ""}`} /><div><b>{job.project}</b><p>{job.prompt}</p></div><span>{job.provider}</span><span className="cw-status">{job.state}</span><ChevronRight size={16} /></button>) : <div className="cw-empty-inline"><Terminal size={24} /><div><b>No Hangar coding jobs observed.</b><p>Start a task from a project to see its output and control it here. Other apps’ sessions appear in history below.</p></div><button onClick={() => onSelect("projects")}>Choose project</button></div>}<div className="cw-section-title"><h2>Session history</h2><button onClick={reload}>Refresh history</button></div><p className="cw-muted">Matched by successful edit tools where possible. A history entry does not mean the agent is running.</p>{sessionsError ? <p className="cw-error" role="alert">{sessionsError}</p> : !sessionsLoaded ? <p className="cw-muted">Indexing local Claude and Codex history… The first scan can take a moment.</p> : sessions.length === 0 ? <p className="cw-muted">No Claude or Codex transcripts found on this machine.</p> : sessions.map(session => <SessionRow key={`${session.provider}-${session.id}`} session={session} onContinue={() => continueSession(session)} />)}</div>}
    </>
    {composer && project && <div className="cw-dialog-backdrop" onClick={e => { if (e.target === e.currentTarget && !busy) setComposer(false); }}><section className="cw-dialog" role="dialog" aria-modal="true" aria-labelledby="cw-compose-title"><DialogFocus onClose={() => !busy && setComposer(false)} /><button className="cw-dialog-close" aria-label="Close task composer" disabled={busy} onClick={() => setComposer(false)}><X size={20} /></button><span className="cw-eyebrow">{machineName} / {project.name}</span><h2 id="cw-compose-title">{resume ? "Continue the work." : "Give this project a task."}</h2><div className="cw-segment" aria-label="Coding agent">{["codex", "claude"].map(p => <button key={p} aria-pressed={provider === p} disabled={!!resume} onClick={() => setProvider(p)}>{p === "codex" ? "Codex" : "Claude Code"}</button>)}</div><label className="cw-input-label">{resume ? "What should happen next?" : "What do you want done?"}<textarea autoFocus value={prompt} onChange={e => setPrompt(e.target.value)} maxLength={8000} placeholder="Describe the outcome, constraints and checks…" rows={6} /></label><p className="cw-muted">Runs in this project’s main checkout on {machineName}, using that machine’s agent login and permission settings. Changes remain in the checkout.</p><button className="cw-primary" disabled={busy || !prompt.trim() || jobs.some(j => j.repo === project.id && (running(j) || j.state === "unobserved"))} onClick={async () => { if (await act("work", { action: "start", repo: project.id, provider, prompt, session: resume })) { setComposer(false); onSelect("sessions"); } }}>{busy ? "Starting…" : resume ? "Continue session" : `Run on ${machineName}`}<Play size={15} /></button>{message && <p role="status">{message}</p>}</section></div>}
    {inspectJob && (() => { const job = jobs.find(j => j.id === inspectJob); if (!job) return null; return <div className="cw-dialog-backdrop"><section className="cw-dialog cw-output-dialog" role="dialog" aria-modal="true" aria-labelledby="cw-job-title"><DialogFocus onClose={() => setInspectJob(null)} /><button className="cw-dialog-close" aria-label="Close job output" onClick={() => setInspectJob(null)}><X size={20} /></button><span className="cw-eyebrow">{machineName} / {job.provider} / {job.state}</span><h2 id="cw-job-title">{job.project}</h2><p>{job.prompt}</p><div className="cw-output" role="log" aria-label="Coding job output">{job.output.length ? job.output.map((line, i) => <p key={`${i}-${line.at}`}><time>{new Date(line.at).toLocaleTimeString()}</time>{line.text}</p>) : <p>Waiting for the agent’s first output…</p>}</div>{job.state === "unobserved" ? <button disabled={busy} onClick={() => act("work", { action: "acknowledge", id: job.id })}>I verified this job is no longer running</button> : running(job) ? <button disabled={busy || job.state === "stopping"} onClick={() => act("work", { action: "stop", id: job.id })}><Square size={14} />{job.state === "stopping" ? "Stopping…" : "Stop this job"}</button> : <p className="cw-muted">Ended {since(job.endedAt || undefined)} · exit {job.exitCode}</p>}{message && <p role="status">{message}</p>}</section></div>; })()}
  </section>;
}

function DialogFocus({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLSpanElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current?.parentElement;
    const elements = () => [...(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled),textarea,input,a[href],[tabindex="0"]') ?? [])];
    (dialog?.querySelector<HTMLElement>("textarea,input") || elements()[0])?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); close.current(); }
      if (e.key === "Tab") { const list = elements(); const first = list[0], last = list.at(-1); if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); } }
    };
    dialog?.addEventListener("keydown", key);
    return () => { dialog?.removeEventListener("keydown", key); previous?.focus(); };
  }, []);
  return <span ref={ref} hidden />;
}
function ProjectSearch({ query, setQuery }: { query: string; setQuery: (value: string) => void }) {
  return <label className="cw-search"><Search size={16} /><input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Find a project…" aria-label="Find a project" /></label>;
}
function ProjectRow({ repo, jobs, apps, onClick }: { repo: Repo; jobs: Job[]; apps: Apps[]; onClick: () => void }) {
  const job = jobs.find(j => j.repo === repo.id && running(j));
  const app = apps.find(a => a.repo === repo.id && a.running.length);
  return <button className="cw-project-row" onClick={onClick}><span className={`cw-project-dot ${job || app ? "is-live" : ""}`} /><span><b>{repo.name}</b><small>{job ? `${job.provider} working` : app ? `App on :${app.running[0].port}` : repo.sites.some(s => s.dirty) ? "Uncommitted work" : repo.sites.length ? "On this machine" : "GitHub only"}</small></span><ChevronRight size={14} /></button>;
}
function SessionRow({ session, onContinue }: { session: Session; onContinue: () => void }) {
  return <article className="cw-session-row"><div className="cw-session-provider">{session.provider === "codex" ? "CX" : "CL"}</div><div><b>{session.projects.map(p => p.name).join(" · ") || "Unmatched session"}</b><p>{session.summary}</p><small>{session.model || session.provider} · {since(session.updatedAt)} · {session.state === "unknown" ? "Live state unknown" : `Last turn ${session.state}`}</small><details><summary>File evidence & session ID</summary><code>{session.id}</code>{session.projects.map(p => <div key={p.id}><b>{p.name}</b>{p.evidence === "working-directory" ? <p>Working-directory match; no confirmed edit-tool evidence.</p> : <ul>{p.files.slice(0, 30).map(f => <li key={f}>{f}</li>)}{p.files.length > 30 && <li>{p.files.length - 30} more files</li>}</ul>}</div>)}</details></div><button disabled={!session.canResume || !session.projects.length} onClick={onContinue}>Continue <ArrowRight size={14} /></button></article>;
}
function ProjectDetail({ project, machine, machineName, sessions, jobs, app, busy, onClose, onStart, onContinue, onAction, onJob, onSelect }: { project: Repo; machine: string; machineName: string; sessions: Session[]; jobs: Job[]; app?: Apps; busy: boolean; onClose: () => void; onStart: () => void; onContinue: (s: Session) => void; onAction: (p: string, b: unknown) => Promise<boolean>; onJob: (id: string) => void; onSelect: (tab: ConsoleTab) => void }) {
  const local = project.sites.some(s => ["canonical", "orphan"].includes(s.role));
  return <><div className="cw-inspector-top"><span className="cw-eyebrow">PROJECT / {machineName}</span><button aria-label="Close project" onClick={onClose}><X size={17} /></button></div><h2>{project.name}</h2><p className="cw-muted">{project.meaning?.purpose || project.description || "Your project, its code and its recent work."}</p><button className="cw-primary" disabled={!local || busy || jobs.some(j => running(j) || j.state === "unobserved")} onClick={onStart}>Start a coding task <ArrowRight size={16} /></button>{!local && <p className="cw-muted">No main checkout on this machine. Choose the machine that has this project.</p>}<div className="cw-facts">{project.sites.map((s, i) => <div key={i}><b>{s.branch || "No branch"}<small>{s.role}</small></b><span>{s.dirty || 0} changed · {s.ahead || 0} ahead</span></div>)}</div>{project.sites.some(s => s.ahead) && <p className="cw-tiny">Ahead counts are relative to the last fetch.</p>}{jobs.filter(running).map(j => <button key={j.id} className="cw-project-row" onClick={() => onJob(j.id)}><Activity size={16} /><span><b>{j.provider} working</b><small>Inspect output</small></span><ArrowRight size={14} /></button>)}<h3>Running apps</h3>{app?.running.length ? app.running.map(a => <div className="cw-app-line" key={a.port}><span className="cw-led is-live" /><b>:{a.port}</b><small>{a.by === "atlas" ? "Atlas managed" : "Started elsewhere"}</small>{machine === "local" && <button disabled={busy} onClick={() => onAction("apps", { action: "open", repo: project.id, port: a.port, how: "window" })}>Open</button>}</div>) : <p className="cw-muted">No listening app observed.</p>}<PlanLink key={`${machine}-${project.id}`} machine={machine} repo={project.id} evidenceCount={sessions.length} /><h3>Recent sessions</h3>{sessions.slice(0, 3).map(s => <button className="cw-project-row" key={`${s.provider}-${s.id}`} onClick={() => onContinue(s)}><Terminal size={15} /><span><b>{s.provider} · {since(s.updatedAt)}</b><small>{s.summary}</small></span><ArrowRight size={14} /></button>)}{!sessions.length && <p className="cw-muted">No indexed session evidence for this project yet.</p>}<button className="cw-text-button" onClick={() => onSelect("sessions")}>All session history <ArrowRight size={14} /></button>{machine === "local" && local && <button className="cw-text-button" disabled={busy} onClick={() => onAction("open", { repo: project.id, with: "folder" })}>Open project folder <ArrowRight size={14} /></button>}</>;
}

function Machines({ machines, statuses, onSaved, onSelect }: { machines: Machine[]; statuses: Record<string, MachineStatus>; onSaved: () => void; onSelect: (t: ConsoleTab) => void }) {
  const [name, setName] = useState(""); const [alias, setAlias] = useState(""); const [port, setPort] = useState("18003");
  const [feedback, setFeedback] = useState(""); const [saving, setSaving] = useState(false);
  return <div className="cw-machines"><div className="cw-topology"><div className="cw-topology-center"><Globe2 size={35} /><strong>Your world</strong><small>Projects stay where they live</small></div>{machines.map(node => { const status = statuses[node.id]; return <article className={`cw-machine-node ${status?.error ? "is-offline" : ""}`} key={node.id}><div className="cw-node-line" /><Server size={32} /><h2>{node.name}</h2><span className="cw-status">{status?.error ? "Disconnected" : status ? "Connected" : "Checking"}</span><p>{status?.platform || "Platform not observed"} · {node.id === "local" ? "Local" : "SSH tunnel"}</p><div className="cw-node-facts"><span>Atlas world<b>{status?.error ? "Unknown" : status?.atlas ? "Online" : "Not responding"}</b></span><span>Last observed<b>{since(status?.observedAt)}</b></span></div>{node.id === "local" ? <button onClick={() => onSelect("services")}>Manage services <ArrowRight size={15} /></button> : <button onClick={async () => { try { await json("/api/fleet", { action: "remove", id: node.id }); onSaved(); } catch (e) { setFeedback((e as Error).message); } }}>Disconnect this entry</button>}</article>; })}</div><div className="cw-connect-form"><div><span className="cw-eyebrow">BRING ANOTHER MACHINE INTO YOUR WORLD</span><h2>Connect through SSH.</h2><p>Run Hangar and Atlas on the other machine. Open an SSH tunnel using an existing, trusted SSH host alias, then add the forwarded port here.</p><code>ssh -N -L {Number(port) || 18003}:127.0.0.1:8003 {alias.replace(/[^a-zA-Z0-9._-]/g, "") || "your-host"}</code><p className="cw-tiny">The SSH client verifies the remote host key. This form does not install software, open firewall ports, or change SSH settings.</p></div><form onSubmit={async e => { e.preventDefault(); setSaving(true); setFeedback(""); try { await json("/api/fleet", { id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), name, port: Number(port), ...(alias ? { sshAlias: alias } : {}) }); setFeedback("Machine connected."); onSaved(); } catch (error) { setFeedback((error as Error).message); } finally { setSaving(false); } }}><label>Machine name<input required value={name} onChange={e => setName(e.target.value)} placeholder="My laptop" maxLength={60} /></label><label>SSH host alias<input value={alias} onChange={e => setAlias(e.target.value)} placeholder="laptop" maxLength={64} /></label><label>Forwarded local port<input type="number" min={1024} max={65535} required value={port} onChange={e => setPort(e.target.value)} /></label><button className="cw-primary" disabled={saving}>{saving ? "Checking connection…" : "Verify & connect"}<ArrowRight size={16} /></button>{feedback && <p role="status">{feedback}</p>}</form></div></div>;
}

function PlanLink({ machine, repo, evidenceCount }: { machine: string; repo: string; evidenceCount: number }) {
  const [link, setLink] = useState<{ title: string; url: string } | null>(null);
  const [title, setTitle] = useState(""); const [url, setUrl] = useState(""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  useEffect(() => { const c = new AbortController(); json<{ links: Record<string, { title: string; url: string }> }>(`/api/atlas/${machine}/proxy/plans`, undefined, c.signal).then(data => { const item = data.links[repo]; setLink(item || null); setTitle(item?.title || ""); setUrl(item?.url || ""); }).catch(e => { if (!c.signal.aborted) setError(e.message); }); return () => c.abort(); }, [machine, repo]);
  return <section className="cw-plan-link"><h3>PlanQuest</h3>{link ? <><a href={link.url} rel="noreferrer">{link.title}<ArrowRight size={14} /></a><p>{evidenceCount} indexed sessions are work evidence. Milestones remain in your plan.</p></> : <p>Connect this project to its plan. Session activity never completes a milestone automatically.</p>}<details><summary>{link ? "Edit plan link" : "Link a plan"}</summary><form onSubmit={async e => { e.preventDefault(); setBusy(true); setError(""); try { const data = await json<{ link: { title: string; url: string } | null }>(`/api/atlas/${machine}/proxy/plans`, { repo, title, url }); setLink(data.link); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}><label>Plan title<input value={title} onChange={e => setTitle(e.target.value)} maxLength={120} /></label><label>Plan URL<input type="url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://…" maxLength={2000} /></label><button disabled={busy}>{busy ? "Saving…" : url ? "Save link" : "Remove link"}</button></form></details>{error && <p role="status">{error}</p>}</section>;
}

function FleetModels({ machine, name, onSelect }: { machine: string; name: string; onSelect: (t: ConsoleTab) => void }) {
  const [models, setModels] = useState<Model[]>([]); const [error, setError] = useState(""); const [loading, setLoading] = useState(true);
  const [routerUp, setRouterUp] = useState(false);
  const [filter, setFilter] = useState("all"); const [model, setModel] = useState<Model | null>(null); const [prompt, setPrompt] = useState(""); const [answer, setAnswer] = useState(""); const [busy, setBusy] = useState(false);
  useEffect(() => { const c = new AbortController(); setLoading(true); setModels([]); setModel(null); setAnswer(""); setError(""); json<{ models: Model[]; routerUp: boolean }>(`/api/fleet/${machine}/models`, undefined, c.signal).then(d => { setModels(d.models); setRouterUp(d.routerUp); }).catch(e => { if (!c.signal.aborted) setError(e.message); }).finally(() => { if (!c.signal.aborted) setLoading(false); }); return () => c.abort(); }, [machine]);
  return <div className="cw-models"><div className="cw-model-route"><Laptop size={26} /><span>This workspace</span><i /><ArrowRight size={18} /><i /><Server size={26} /><span>{name}<small>Execution machine</small></span><button onClick={() => onSelect("model-settings")}>Local model settings</button></div><div className="cw-family-tabs">{["all", "chat", "image_generation", "audio_speech", "audio_transcription"].map(f => <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>{{ all: "All models", chat: "Text & code", image_generation: "Images", audio_speech: "Speech", audio_transcription: "Transcription" }[f]}</button>)}</div>{error && <p className="cw-error" role="alert">{error}</p>}{loading && <p className="cw-muted">Reading {name}’s model catalogue…</p>}<div className="cw-model-grid">{models.filter(m => filter === "all" || m.mode === filter).map(m => <article className="cw-model-tile" key={m.id}><Cpu size={23} /><span className={`cw-status ${m.status === "ready" ? "is-live" : ""}`}>{m.status.replaceAll("-", " ")}</span><h2>{m.id}</h2><p>{m.target}</p><small>{m.local ? `Local on ${name}` : `Cloud via ${name}`} · {m.mode}</small>{m.detail && <p className="cw-muted">{m.detail}</p>}{!m.local && !routerUp && <p className="cw-muted">AI Router is offline on this machine.</p>}{m.mode === "chat" && <button disabled={m.status !== "ready" || (!m.local && !routerUp)} onClick={() => { setModel(m); setAnswer(""); }}>Use this model <ArrowRight size={15} /></button>}</article>)}</div>{model && <div className="cw-dialog-backdrop"><section className="cw-dialog" role="dialog" aria-modal="true" aria-labelledby="cw-model-title"><DialogFocus onClose={() => !busy && setModel(null)} /><button className="cw-dialog-close" aria-label="Close model prompt" disabled={busy} onClick={() => setModel(null)}><X size={20} /></button><span className="cw-eyebrow">RUN ON {name}</span><h2 id="cw-model-title">{model.id}</h2><label className="cw-input-label">Prompt<textarea autoFocus value={prompt} onChange={e => setPrompt(e.target.value)} maxLength={12000} rows={4} /></label><button className="cw-primary" disabled={busy || !prompt.trim()} onClick={async () => { setBusy(true); setAnswer(""); try { const result = await json<{ content: string }>(`/api/fleet/${machine}/inference`, { model: model.id, prompt }); setAnswer(result.content); } catch (e) { setAnswer((e as Error).message); } finally { setBusy(false); } }}>{busy ? "Model working…" : "Send to model"}<ArrowRight size={15} /></button>{answer && <div className="cw-model-answer" role="status">{answer}</div>}</section></div>}</div>;
}
