"use client";

import { useRef, useEffect, useState } from "react";
import { Play, X } from "lucide-react";
import { taskContext, taskDraft, taskPrompt, type TaskProject, type TaskSession } from "@/lib/task-context";

export default function TaskComposer({ project, machineName, sessions, initialSession, initialProvider, blocked, onClose, onSubmit }: {
  project: TaskProject; machineName: string; sessions: TaskSession[]; initialSession: string | null; initialProvider: string; blocked: boolean;
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
  useEffect(() => { const d = dialog.current; d?.showModal(); return () => d?.close(); }, []);
  function choose(s?: TaskSession) { setSession(s); if (s) setProvider(s.provider); setDraft(taskDraft(project, s)); }
  return <dialog ref={dialog} className="workspace-operations cw-task-composer" aria-labelledby="cw-compose-title" onCancel={e => { if (busy) e.preventDefault(); else onClose(); }}>
    <header><div><span className="cw-eyebrow">{machineName} / {project.name}</span><h2 id="cw-compose-title">{session ? "Continue the work." : "Pick up with context."}</h2></div><button aria-label="Close task composer" disabled={busy} onClick={onClose}><X size={20} /></button></header>
    {!!candidates.length && <><h3>Continue an existing conversation</h3><div className="cw-context-sessions">{candidates.map(s => <button key={`${s.provider}-${s.id}`} disabled={busy} aria-pressed={session?.id === s.id && session.provider === s.provider} onClick={() => choose(s)}><b>{s.title || s.summary || "Untitled session"}</b><small>{s.provider} · {new Date(s.updatedAt).toLocaleString()} · resume conversation</small></button>)}</div></>}
    <button disabled={busy} aria-pressed={!session} onClick={() => choose()}>New task with project context</button>
    <details className="cw-context-card"><summary>Context sent with this task</summary><p>{context}</p></details>
    {session && <p>Resuming the selected {session.provider} conversation, including its history. This is not a new session.</p>}
    <div className="cw-segment" aria-label="Coding agent">{["codex", "claude"].map(p => <button key={p} aria-pressed={provider === p} disabled={!!session || busy} onClick={() => setProvider(p)}>{p === "codex" ? "Codex" : "Claude Code"}</button>)}</div>
    <label className="cw-input-label">Review what should happen next<textarea value={draft} onChange={e => setDraft(e.target.value)} maxLength={4500} rows={5} disabled={busy} /></label>
    <p>Runs in this project’s main checkout on {machineName}, using its agent login and permission settings. Nothing starts until you press Run or Continue.</p>
    {blocked && <p role="alert">An active or unobserved Hangar job already uses this checkout. Inspect it before starting another.</p>}
    {error && <p role="alert">{error}</p>}
    <button className="cw-primary" disabled={busy || blocked || !draft.trim() || fullPrompt.length > 8000} onClick={async () => { setBusy(true); setError(""); try { if (!await onSubmit({ provider, session: session?.id || null, prompt: fullPrompt })) setError("The task could not start. Check the workspace message and try again."); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}><Play size={16} />{busy ? "Starting…" : session ? "Continue selected session" : `Run on ${machineName}`}</button>
  </dialog>;
}
