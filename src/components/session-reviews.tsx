"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Copy, Wrench } from "lucide-react";
import AgentMark from "./agent-mark";
import type { LibrarySession } from "./session-library";
import "./session-reviews.css";

type Finding = { severity: "high" | "medium" | "low"; file: string; line: number | null; title: string; detail: string; fix: string };
export type Review = {
  id: string; session: string; sessionTitle: string; author: string; reviewer: string; repo: string; project: string;
  commits: string[]; uncommitted: boolean; files: number; state: "running" | "done" | "failed"; startedAt: string; endedAt: string | null;
  job: string | null; message?: string; verdict?: "ship" | "fix" | "rethink"; summary?: string; findings?: Finding[]; checked?: string[]; notChecked?: string;
};

const NAME: Record<string, string> = { claude: "Claude", codex: "Codex" };
const VERDICT: Record<string, string> = { ship: "Good to ship", fix: "Fix first", rethink: "Rethink" };
const other = (provider: string) => provider === "codex" ? "claude" : "codex";
/** A conversation touched this recently may still be open in its app: continuing it from Hangar would fork it. */
const ACTIVE_MS = 15 * 60_000;
const ago = (iso: string) => { const min = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60000)); return min < 1 ? "just now" : min < 60 ? `${min}m ago` : min < 1440 ? `${Math.floor(min / 60)}h ago` : `${Math.floor(min / 1440)}d ago`; };

async function call<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, { method: body ? "POST" : "GET", cache: "no-store",
    headers: body ? { "Content-Type": "application/json", "X-Hangar": "1" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : `Request failed (${response.status})`);
  return data;
}

/** Reviews of one session by the other agent: one click sends it, and each review's verdict and findings show here. */
export default function SessionReviews({ machine, session }: { machine: string; session: LibrarySession }) {
  const base = `/api/world/${machine}/proxy`;
  const [reviews, setReviews] = useState<Review[] | null>(null), [skill, setSkill] = useState(true);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { const data = await call<{ reviews: Review[]; skill: boolean }>(`${base}/reviews?session=${encodeURIComponent(session.key)}`); setReviews(data.reviews); setSkill(data.skill); }
    catch (e) { setError((e as Error).message); }
  }, [base, session.key]);
  useEffect(() => { setReviews(null); setError(""); void load(); }, [load]);
  const running = !!reviews?.some(r => r.state === "running");
  useEffect(() => { if (!running) return; const timer = setInterval(() => void load(), 4000); return () => clearInterval(timer); }, [running, load]);
  const to = other(session.provider);
  const send = async () => {
    setBusy(true); setError("");
    try { await call(`${base}/reviews`, { session: session.key, reviewer: to }); await load(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <section className="sr" aria-label="Reviews of this session">
    <div className="sr-head">
      <h4>Reviews{!!reviews?.length && <small>{reviews.length}</small>}</h4>
      <button className="sr-send" disabled={busy || running || !skill || !session.projects.length} onClick={() => void send()}
        title={`${NAME[to]} reads what this session committed and reports what could break. It changes nothing.`}>
        <span className={`sr-agent is-${to}`}><AgentMark agent={to} /></span>{busy ? "Sending…" : running ? `${NAME[to]} is reviewing…` : `Review with ${NAME[to]}`}
      </button>
    </div>
    {!skill && <p className="sr-note">Install the cross-review skill (claude-config) to send reviews.</p>}
    {error && <p className="sr-error" role="alert">{error}</p>}
    {reviews?.length === 0 && skill && <p className="sr-note">No reviews yet. {NAME[to]} reads what this session committed (or the project’s uncommitted changes) and says what could break. It changes nothing.</p>}
    {reviews?.map(r => <ReviewCard key={r.id} review={r} machine={machine} canFix={session.canResume} active={Date.now() - Date.parse(session.activityAt || session.updatedAt) < ACTIVE_MS} />)}
  </section>;
}

/** A review on its own, by id: the Hangar jobs pane shows the findings of a review job. */
export function JobReview({ machine, id }: { machine: string; id: string }) {
  const [review, setReview] = useState<Review | null>(null);
  useEffect(() => {
    let live = true, timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const data = await call<{ reviews: Review[] }>(`/api/world/${machine}/proxy/reviews?id=${encodeURIComponent(id)}`);
        if (!live) return;
        setReview(data.reviews[0] || null);
        if (data.reviews[0]?.state === "running") timer = setTimeout(load, 4000);
      } catch { /* the job's own log still shows */ }
    };
    void load();
    return () => { live = false; clearTimeout(timer); };
  }, [machine, id]);
  return review ? <div className="sr sr-in-job"><ReviewCard review={review} machine={machine} canFix={false} showSession /></div> : null;
}

/** One review: who reviewed what, the verdict, every finding with its place in the code, and the way on: copy the
 *  findings into the conversation, or ask the session's own agent to fix them as a Hangar job in that conversation (not
 *  while it may still be open in its app: `active`). */
export function ReviewCard({ review: r, machine, canFix, active, showSession }: { review: Review; machine: string; canFix: boolean; active?: boolean; showSession?: boolean }) {
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const what = r.uncommitted ? "the uncommitted changes" : `${r.commits.length} ${r.commits.length === 1 ? "commit" : "commits"}`;
  const list = (r.findings || []).map((f, i) => `${i + 1}. [${f.severity}] ${f.title}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : ""}\n   ${f.detail}${f.fix ? `\n   Suggested fix: ${f.fix}` : ""}`).join("\n");
  const prompt = `${NAME[r.reviewer]} reviewed your work in this conversation and reported the findings below. A finding is the other agent's opinion: check each one against the code, fix the ones that hold up, and commit each fix. Then say which findings you did not fix and why.\n\nVerdict: ${VERDICT[r.verdict || "fix"]}. ${r.summary || ""}\n\n${list}`;
  const copy = async () => {
    try { await navigator.clipboard.writeText(prompt); setMessage(`Copied. Paste it into ${NAME[r.author]}’s conversation.`); }
    catch { setMessage("Your browser blocked the clipboard."); }
  };
  const fix = async () => {
    setBusy(true); setMessage("");
    try {
      await call(`/api/world/${machine}/proxy/work`, { action: "start", repo: r.repo, provider: r.author, session: r.session.split(":").slice(1).join(":"), prompt });
      setMessage(`${NAME[r.author]} is working on them. Follow it under Sessions › Hangar jobs.`);
    } catch (e) { setMessage((e as Error).message); }
    finally { setBusy(false); }
  };
  return <article className={`sr-card is-${r.state}`}>
    <header>
      <span className={`sr-agent is-${r.reviewer}`}><AgentMark agent={r.reviewer} /></span>
      <span className="sr-who"><b>{NAME[r.reviewer]} {r.state === "running" ? "is reviewing" : r.state === "failed" ? "could not review" : "reviewed"} {what}</b><small>{showSession && r.sessionTitle ? `${NAME[r.author]}’s session “${r.sessionTitle}” · ` : ""}{r.project} · {r.files} {r.files === 1 ? "file" : "files"} · {ago(r.startedAt)}</small></span>
      {r.state === "running" ? <span className="sr-verdict is-running">Reviewing…</span>
        : r.state === "failed" ? <span className="sr-verdict is-failed">Failed</span>
        : <span className={`sr-verdict is-${r.verdict}`}>{VERDICT[r.verdict || "fix"]}</span>}
    </header>
    {r.state === "failed" && r.message && <p className="sr-error">{r.message}</p>}
    {r.summary && <p className="sr-summary">{r.summary}</p>}
    {!!r.findings?.length && <ol className="sr-findings">{r.findings.map((f, i) => <li key={i} className={`is-${f.severity}`}>
      <span className="sr-sev">{f.severity}</span>
      <div><b>{f.title}</b>{f.file && <code>{f.file}{f.line ? `:${f.line}` : ""}</code>}<p>{f.detail}</p>{f.fix && <p className="sr-fix">Fix: {f.fix}</p>}</div>
    </li>)}</ol>}
    {r.state === "done" && !r.findings?.length && <p className="sr-clean"><CheckCircle2 size={15} aria-hidden="true" />No findings.</p>}
    {(!!r.checked?.length || !!r.notChecked) && <details className="sr-checked"><summary>What it checked</summary>
      {!!r.checked?.length && <ul>{r.checked.map((c, i) => <li key={i}>{c}</li>)}</ul>}{r.notChecked && <p>Not checked: {r.notChecked}</p>}</details>}
    {r.state === "done" && !!r.findings?.length && <div className="sr-actions">
      {canFix && <button className="cw-primary" disabled={busy || active} onClick={() => void fix()}
        title={active ? "This conversation was active in the last 15 minutes and may still be open. Copy the findings into it instead." : `Starts a Hangar job that continues ${NAME[r.author]}’s conversation with these findings`}><Wrench size={14} />Ask {NAME[r.author]} to fix these</button>}
      <button onClick={() => void copy()} title={`The findings as a message for ${NAME[r.author]}`}><Copy size={14} />Copy findings</button>
    </div>}
    {message && <p role="status" className="sr-note">{message}</p>}
  </article>;
}
