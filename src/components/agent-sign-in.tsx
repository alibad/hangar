"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, LogIn } from "lucide-react";
import "./agent-sign-in.css";

export type AgentStatus = { id: string; name: string; installed: boolean; signedIn: boolean | null; reason: string };

/** Each coding agent's sign-in on a machine, refreshed when the window regains focus and every few seconds while a
 *  sign-in is in progress, so the notice turns into "Signed in" without a reload. */
export function useAgents(machine: string) {
  const [agents, setAgents] = useState<AgentStatus[]>([]);
  const [waiting, setWaiting] = useState<string | null>(null);
  const [error, setError] = useState("");
  const base = `/api/world/${machine}/proxy`;
  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`${base}/agents`, { cache: "no-store" });
      if (response.ok) setAgents((await response.json()).agents || []);
    } catch { /* keep the last answer */ }
  }, [base]);
  useEffect(() => {
    void refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);
  useEffect(() => {
    if (!waiting) return;
    const started = Date.now();
    const timer = setInterval(() => { if (Date.now() - started > 5 * 60000) setWaiting(null); else void refresh(); }, 4000);
    return () => clearInterval(timer);
  }, [waiting, refresh]);
  useEffect(() => { if (waiting && agents.find(a => a.id === waiting)?.signedIn) setWaiting(null); }, [agents, waiting]);
  const signIn = useCallback(async (id: string) => {
    setError("");
    try {
      const response = await fetch(`${base}/agents/login`, { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json", "X-Hangar": "1" }, body: JSON.stringify({ agent: id }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not open the sign-in.");
      setWaiting(id);
    } catch (e) { setError((e as Error).message); }
  }, [base]);
  return { agents, waiting, error, signIn, refresh };
}

/** The notice itself, for a caller that already keeps the agents' state (to also block a Run button, say). */
export function SignInNoticeView({ status, waiting, error, onSignIn, machineName, local, compact, done }: {
  status?: AgentStatus; waiting: string | null; error: string; onSignIn: (id: string) => void; machineName: string; local: boolean; compact?: boolean; done?: boolean;
}) {
  if (done && status) return <div className={`asi is-done ${compact ? "is-compact" : ""}`} role="status"><Check size={15} />{status.name} is signed in. You can run it now.</div>;
  if (!status || !status.installed || status.signedIn !== false) return null;
  return <div className={`asi ${compact ? "is-compact" : ""}`} role="alert">
    <span className="asi-text"><b>{status.name} needs you to sign in on {machineName}.</b><small>{status.reason} Hangar runs agents on your own account, never an API key.</small></span>
    {local ? waiting === status.id
      ? <span className="asi-wait">A terminal opened: finish signing in in your browser. This updates by itself.</span>
      : <button className="asi-go" onClick={() => onSignIn(status.id)}><LogIn size={14} />Sign in to {status.name}</button>
      : <code className="asi-cmd">{status.id === "claude" ? "claude auth login" : "codex login"}</code>}
    {error && <small className="asi-error">{error}</small>}
  </div>;
}

/** Remembers that an agent went from signed out to signed in, to say so once. */
export function useSignedInAgain(status?: AgentStatus) {
  const [done, setDone] = useState(false);
  const was = useRef<boolean | null>(null);
  useEffect(() => {
    if (status?.signedIn === true && was.current === false) setDone(true);
    if (status) was.current = status.signedIn;
  }, [status]);
  return done;
}

/** A notice for one agent that cannot run on its own sign-in, with the way to sign in. Renders nothing when it can. */
export function SignInNotice({ machine, machineName, agent, compact }: { machine: string; machineName: string; agent: string; compact?: boolean }) {
  const { agents, waiting, error, signIn } = useAgents(machine);
  const status = agents.find(a => a.id === agent);
  const done = useSignedInAgain(status);
  return <SignInNoticeView status={status} waiting={waiting} error={error} onSignIn={id => void signIn(id)} machineName={machineName} local={machine === "local"} compact={compact} done={done} />;
}
