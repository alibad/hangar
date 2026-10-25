"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { workspaceResponse } from "@/lib/workspace-response";
import "./project-architecture.css";

type Agent = "claude" | "codex";
type Drawing = { state: "drawing" | "checking" | "ready" | "failed"; round?: number; job?: string | null; provider?: Agent; message?: string | null; problems?: string | null };
type Status = {
  archify: boolean; install: string; checkout: boolean; agents: Agent[]; signedOut?: Agent[]; behind: number | null; drawing: Drawing | null;
  diagram: { title?: string; drawnAt: string; provider: Agent; revision?: string | null; components: number } | null;
};
const NAMES: Record<Agent, string> = { claude: "Claude", codex: "Codex" };

function ago(iso: string) {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

/** An Archify drawing of the project, drawn by an agent that only reads the code. */
export default function ProjectArchitecture({ machine, repo, onJob }: { machine: string; repo: string; onJob: (id: string) => void }) {
  const base = `/api/world/${machine}/proxy/architecture`;
  const [status, setStatus] = useState<Status | null>(null), [error, setError] = useState(""), [agent, setAgent] = useState<Agent | null>(null);
  const [starting, setStarting] = useState(false), [frame, setFrame] = useState(0);
  const lastState = useRef<string | undefined>(undefined);
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await workspaceResponse<Status>(await fetch(`${base}?repo=${encodeURIComponent(repo)}`, { cache: "no-store", signal }));
      if (signal?.aborted) return;
      // A finished drawing replaces the frame's page; reload it once, not on every poll.
      if (lastState.current && lastState.current !== "ready" && next.drawing?.state === "ready") setFrame(n => n + 1);
      lastState.current = next.drawing?.state;
      setStatus(next); setError("");
    } catch (e) { if (!signal?.aborted) setError(e instanceof Error ? e.message : String(e)); }
  }, [base, repo]);
  useEffect(() => {
    const controller = new AbortController();
    setStatus(null); setError(""); lastState.current = undefined;
    load(controller.signal);
    return () => controller.abort();
  }, [load]);
  const busy = status?.drawing?.state === "drawing" || status?.drawing?.state === "checking";
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => load(), 3000);
    return () => clearInterval(timer);
  }, [busy, load]);
  // Claude first: its drawing run gets reading tools only. An agent whose sign-in just failed is not the default.
  const ready = status?.agents.filter(a => !status.signedOut?.includes(a)) ?? [];
  const chosen = agent ?? (ready.includes("claude") ? "claude" : ready[0] ?? status?.agents[0]) ?? null;
  const draw = async () => {
    if (!chosen) return;
    setStarting(true); setError("");
    try {
      await workspaceResponse(await fetch(base, { method: "POST", headers: { "Content-Type": "application/json", "X-Hangar": "1" }, body: JSON.stringify({ repo, provider: chosen }) }));
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setStarting(false); }
  };
  const view = `${base}/view?repo=${encodeURIComponent(repo)}&v=${frame}`;
  const d = status?.diagram, drawing = status?.drawing;
  const agents = status && status.agents.length > 1 && <span className="pa-agents" role="group" aria-label="Agent that draws">
    {status.agents.map(a => <button key={a} aria-pressed={chosen === a} onClick={() => setAgent(a)} title={status.signedOut?.includes(a) ? `${NAMES[a]} needs you to sign in again on this machine` : undefined}>
      {NAMES[a]}{status.signedOut?.includes(a) && <small> · sign in</small>}</button>)}
  </span>;
  const drawButton = (label: string) => <button className="pa-draw" disabled={!chosen || starting || busy} onClick={draw}><RefreshCw size={14} />{starting ? "Starting…" : label}</button>;
  return <section className="project-architecture" aria-label="Project architecture">
    {!status && !error && <p role="status" className="pa-quiet">Looking for this project’s drawing…</p>}
    {error && <p role="alert" className="pa-alert">{error}</p>}
    {status && !status.archify && <div className="pa-empty">
      <h3>Archify is not installed on this machine</h3>
      <p>Hangar draws architecture with the Archify agent skill. Install it once, then come back:</p>
      <code>{status.install}</code>
    </div>}
    {status?.archify && !status.checkout && !d && <p className="pa-quiet">Clone this project on this machine to draw its architecture.</p>}
    {status?.archify && status.checkout && !status.agents.length && <p className="pa-quiet">Install Claude Code or Codex on this machine to draw the architecture.</p>}
    {status?.archify && <>
      {busy && <div className="pa-progress" role="status">
        <span className="pa-pulse" aria-hidden="true" />
        <div><b>{drawing?.state === "checking" ? "Archify is checking the drawing" : `${NAMES[drawing?.provider || "codex"]} is reading the code`}</b>
          <small>{drawing?.round && drawing.round > 1 ? `Fixing what Archify found · round ${drawing.round} of 3` : "Read-only. This usually takes a few minutes."}</small></div>
        {drawing?.job && <button onClick={() => onJob(drawing.job!)}>Watch</button>}
      </div>}
      {busy && drawing?.problems && <details className="pa-found"><summary>What Archify found</summary><pre>{drawing.problems}</pre></details>}
      {drawing?.state === "failed" && <div className="pa-alert" role="alert"><b>The drawing did not finish.</b><pre>{drawing.message}</pre></div>}
      {d && <>
        <div className="pa-bar">
          <span>Drawn {ago(d.drawnAt)} by {NAMES[d.provider]}{d.revision ? <> at <code>{d.revision.slice(0, 7)}</code></> : null}
            {status.behind ? <em> · {status.behind} commit{status.behind === 1 ? "" : "s"} since</em> : null}</span>
          {status.checkout && status.agents.length > 0 && <span className="pa-actions">{agents}{drawButton("Redraw")}</span>}
          <a href={view} target="_blank" rel="noreferrer" aria-label="Open the drawing in a new tab"><ExternalLink size={14} /></a>
        </div>
        <iframe key={frame} className="pa-frame" src={view} title={d.title || "Architecture drawing"} sandbox="allow-scripts allow-downloads allow-popups allow-popups-to-escape-sandbox" allowFullScreen referrerPolicy="no-referrer" />
      </>}
      {!d && !busy && status.checkout && status.agents.length > 0 && <div className="pa-empty">
        <h3>No architecture drawing yet</h3>
        <p>Claude or Codex reads this project with your own account, without changing anything. Archify then checks the drawing and links every part to its source.</p>
        <span className="pa-actions">{agents}{drawButton("Draw architecture")}</span>
      </div>}
    </>}
  </section>;
}
