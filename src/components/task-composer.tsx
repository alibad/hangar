"use client";

import { useRef, useEffect, useState } from "react";
import { ChevronDown, History, Play, Sparkles, X } from "lucide-react";
import { taskContext, taskDraft, taskPrompt, type TaskProject, type TaskSession } from "@/lib/task-context";
import "./task-composer.css";
import { SignInNoticeView, useAgents, useSignedInAgain } from "./agent-sign-in";

const AGENTS = [{ id: "codex", name: "Codex" }, { id: "claude", name: "Claude Code" }];
/** Ready-made asks for a new task; the first is the project's own next step (or a review when none is recorded). */
const ASKS = [
  { label: "Fix what is broken", text: "Find what is failing or broken in this project (tests, build, lint or runtime errors) and fix it. Explain the cause before changing code, preserve existing changes and verify the fix." },
  { label: "Finish open work", text: "Look at the uncommitted changes and the most recent sessions, finish the work that was in progress, verify it, and summarise what changed." },
  { label: "Add tests", text: "Find the most important code paths without tests, add focused tests for them, run the suite and report the results." },
];
const ago = (iso: string) => { const d = Math.floor((Date.now() - Date.parse(iso)) / 86400000); return Number.isNaN(d) ? "" : d <= 0 ? "today" : d === 1 ? "yesterday" : `${d}d ago`; };

export default function TaskComposer({ project, machine, machineName, sessions, initialSession, initialProvider, blocked, onClose, onSubmit }: {
  project: TaskProject; machine: string; machineName: string; sessions: TaskSession[]; initialSession: string | null; initialProvider: string; blocked: boolean;
  onClose: () => void; onSubmit: (body: { provider: string; prompt: string; session: string | null }) => Promise<boolean>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const candidates = sessions.filter(s => s.canResume && !s.archived).slice(0, 6);
  const initial = candidates.find(s => s.id === initialSession && s.provider === initialProvider);
  const [session, setSession] = useState<TaskSession | undefined>(initial);
  const [provider, setProvider] = useState(initial?.provider || initialProvider);
  const [draft, setDraft] = useState(taskDraft(project, initial));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const context = taskContext(project, sessions);
  const fullPrompt = taskPrompt(context, draft);
  const own = taskDraft(project);
  const signs = useAgents(machine);
  const sign = signs.agents.find(a => a.id === provider);
  const signedAgain = useSignedInAgain(sign);
  const signedOut = sign?.signedIn === false;
  useEffect(() => { const d = dialog.current; d?.showModal(); return () => d?.close(); }, []);
  function choose(s?: TaskSession) { setSession(s); if (s) setProvider(s.provider); setDraft(taskDraft(project, s)); }
  const agentName = AGENTS.find(a => a.id === provider)?.name || provider;
  async function start() {
    setBusy(true); setError("");
    try { if (!await onSubmit({ provider, session: session?.id || null, prompt: fullPrompt })) setError("The task could not start. Check the workspace message and try again."); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="tc-dialog" aria-labelledby="tc-title" onCancel={e => { if (busy) e.preventDefault(); else onClose(); }}>
    <header className="tc-head">
      <div><span className="cw-eyebrow">{machineName} / {project.name}</span><h2 id="tc-title">{session ? "Continue the work" : "Start a coding task"}</h2></div>
      <button className="tc-close" aria-label="Close task composer" disabled={busy} onClick={onClose}><X size={18} /></button>
    </header>

    <div className="tc-choice" role="radiogroup" aria-label="New task or continue">
      <button role="radio" aria-checked={!session} disabled={busy} onClick={() => choose()}><Sparkles size={18} /><span><b>New task</b><small>A fresh session that knows this project</small></span></button>
      <button role="radio" aria-checked={!!session} disabled={busy || !candidates.length} onClick={() => choose(candidates[0])}><History size={18} /><span><b>Continue a conversation</b><small>{candidates.length ? `${candidates.length} you can resume, with their history` : "No resumable sessions yet"}</small></span></button>
    </div>

    {session ? <div className="tc-sessions" role="radiogroup" aria-label="Conversation to continue">{candidates.map(s => {
      const on = session.id === s.id && session.provider === s.provider;
      return <button key={`${s.provider}-${s.id}`} role="radio" aria-checked={on} disabled={busy} onClick={() => choose(s)}>
        <span className={`tc-agent is-${s.provider === "codex" ? "codex" : "claude"}`}>{s.provider === "codex" ? "CX" : "CL"}</span>
        <span className="tc-session-text"><b>{s.title || s.summary || "Untitled session"}</b><small>{s.provider === "codex" ? "Codex" : "Claude Code"} · {ago(s.updatedAt)}</small></span>
      </button>;
    })}</div> : <div className="tc-agents" role="radiogroup" aria-label="Coding agent">{AGENTS.map(a => <button key={a.id} role="radio" aria-checked={provider === a.id} disabled={busy} onClick={() => setProvider(a.id)}><i className={`tc-dot is-${a.id}`} aria-hidden="true" />{a.name}</button>)}</div>}

    <SignInNoticeView status={sign} waiting={signs.waiting} error={signs.error} onSignIn={id => void signs.signIn(id)} machineName={machineName} local={machine === "local"} compact done={signedAgain} />

    <label className="tc-label" htmlFor="tc-ask">{session ? "What should it pick up?" : "What should happen?"}</label>
    {!session && <div className="tc-asks" aria-label="Ready-made tasks">
      <button aria-pressed={draft === own} disabled={busy} onClick={() => setDraft(own)}>{project.meaning?.next ? "Recorded next step" : "Review and plan"}</button>
      {ASKS.map(a => <button key={a.label} aria-pressed={draft === a.text} disabled={busy} onClick={() => setDraft(a.text)}>{a.label}</button>)}
    </div>}
    <textarea id="tc-ask" className="tc-ask" value={draft} onChange={e => setDraft(e.target.value)} maxLength={4500} rows={4} disabled={busy} />

    <details className="tc-context"><summary><ChevronDown size={14} aria-hidden="true" />What the agent is told about the project</summary><pre>{context}</pre></details>

    {blocked && <p className="tc-alert" role="alert">A Hangar job is already running in this folder. Look at it before starting another.</p>}
    {error && <p className="tc-alert" role="alert">{error}</p>}
    <footer className="tc-foot">
      <small>{session ? `Resumes this ${session.provider === "codex" ? "Codex" : "Claude"} conversation with its history` : `New ${agentName} session`} in the project’s main folder on {machineName}, with that agent’s own sign-in and permissions.</small>
      <button className="tc-run" disabled={busy || blocked || signedOut || !draft.trim() || fullPrompt.length > 8000} onClick={() => void start()}><Play size={15} />{busy ? "Starting…" : session ? `Continue in ${session.provider === "codex" ? "Codex" : "Claude"}` : `Run ${agentName}`}</button>
    </footer>
  </dialog>;
}
