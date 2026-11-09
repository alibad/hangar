"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Archive, ArrowRight, Check, ChevronDown, ExternalLink, HelpCircle, Hourglass, ListChecks, Loader2, MapPin, Route, Target, Undo2 } from "lucide-react";
import AgentMark from "./agent-mark";
import type { PlanSummary } from "@/lib/planquest";
import "./step-back.css";

type Said = { own: number; accepted: number; typed: number; buttons: number; acks: number; started: number; stopped: number; proposedByIt: number; briefed: boolean };
type SbSession = { ref: string; key: string; id: string; provider: string; title: string; activityAt: string; idleDays: number | null; projects: { id: string; name: string }[];
  parent: string | null; family: string; status: string | null; needs: string; unread: boolean; working: boolean; verdict: string | null; unpushed: number; said: Said };
type WaitKind = "answer" | "signin" | "review" | "unread" | "push";
type Waiting = { kind: WaitKind; what: string; session?: string; title?: string; project?: string; repo?: string };
type Family = { root: string; sessions: string[]; own: number; accepted: number; itsIdeas: number };
type Totals = { open: number; recent: number; stale: number; waiting: number; waitingKinds: Partial<Record<WaitKind, number>>; staleVerdicts: Record<string, number>; unread: number; own: number; accepted: number; itsIdeas: number };
type Finished = { key: string; activityAt: string; title: string; idleDays: number | null; verdict: string };
type Facts = { days: number; at: string; sessions: Record<string, SbSession>; waiting: Waiting[]; totals: Totals; finished: Finished[]; families: Family[] };
type Goal = { id: string; title: string; why: string; quote: string; sessions: string[]; state: "moving" | "stalled" | "waiting" | "done"; done: string[]; left: string[]; plan: string; share: number };
type Drift = { session: string; started: string; wandered: string[]; by: "you" | "session" | "both"; note: string; goal: string };
type Step = { do: string; why: string; session: string; goal: string };
type Question = { id: string; ask: string; why: string; goal: string; options: string[] };
type Read = { headline: string; goals: Goal[]; drift: Drift[]; next: Step[]; questions: Question[]; archive: { session: string; why: string }[]; sidequests: string[] };
type Decision = "keep" | "adjust" | "pause" | "stop";
type Result = { id: string; at: string; days: number; reader: string; job: string; facts: { totals: Totals; waiting: Waiting[]; finished: Finished[] }; sessions: Record<string, SbSession>; families: Family[]; read: Read;
  plans: Record<string, { title: string; url: string }>; answers: Record<string, { text: string; at: string }>; decisions: Record<string, { decision: Decision; note: string; at: string }>; recorded: Record<string, { url: string; at: string }> };
type Run = { id: string; state: "reading" | "asking" | "done" | "failed"; startedAt: string; days: number; reader: string; sessions: number; message: string };
type View = { run: Run | null; latest: Result | null; history: { id: string; at: string }[]; memory: { vision: string }; readers: { id: string; name: string; signedIn: boolean | null }[]; windows: number[] };
type TrailRecord = { key: string; plan_id: string | null; type: string; title: string; summary: string; saved?: { url: string } | null };
type PqStatus = { connected: boolean; canRecord?: boolean };

const WAIT: Record<WaitKind, { label: string; one: string }> = {
  signin: { label: "Sign-ins", one: "Sign in" }, answer: { label: "Questions for you", one: "Answer" }, push: { label: "Not pushed", one: "Push" },
  review: { label: "To review", one: "Review" }, unread: { label: "Unread replies", one: "Read" } };
const ORDER: WaitKind[] = ["signin", "answer", "push", "review", "unread"];
const STATE: Record<Goal["state"], string> = { moving: "Moving", stalled: "Stalled", waiting: "Waiting on you", done: "Done" };
const CALLS: [Decision, string][] = [["keep", "Keep"], ["adjust", "Adjust"], ["pause", "Pause"], ["stop", "Stop"]];
const BY: Record<Drift["by"], string> = { you: "Your call", session: "Its idea, you said yes", both: "Half yours, half its" };
const CONSENT = "hangar-stepback-reader-ok";

async function call<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, { method: body === undefined ? "GET" : "POST", cache: "no-store",
    headers: body === undefined ? undefined : { "Content-Type": "application/json", "X-Hangar": "1" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : `Request failed (${response.status})`);
  return data;
}
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** How a thread was steered: your own words against what you accepted from it. */
function Steer({ own, accepted, its, small }: { own: number; accepted: number; its: number; small?: boolean }) {
  const total = own + accepted;
  if (!total) return null;
  const share = Math.round((own / total) * 100);
  return <div className={`sb-steer ${small ? "is-small" : ""}`}>
    <div className="sb-steer-bar" role="img" aria-label={`${own} turns in your own words, ${accepted} where you accepted what the session offered`}><i style={{ width: `${share}%` }} /><b style={{ width: `${100 - share}%` }} /></div>
    <small><span className="is-own">{plural(own, "turn")} in your own words</span><span className="is-took">{accepted} where you took what it offered</span>{its > 0 && <span className="is-its">{plural(its, "side session")} were its idea</span>}</small>
  </div>;
}

/**
 * Sessions → Step back. One click reads what you said across your recent sessions and shows what you are really after,
 * where each thread drifted and whose move that was, what waits on you, and the next few moves. It asks a few questions
 * back; your answers are kept for the next read and can be saved to the plan each goal belongs to in PlanQuest.
 */
export default function StepBack({ machine, onOpen, onSessionsChanged, onCleanUp }: {
  machine: string; onOpen?: (session: { provider: string; id: string }) => void; onSessionsChanged?: () => void; onCleanUp?: () => void;
}) {
  const api = `/api/world/${machine}/proxy/stepback`;
  const [view, setView] = useState<View | null>(null);
  const [facts, setFacts] = useState<Facts | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [days, setDays] = useState(30);
  const [reader, setReader] = useState("claude");
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pq, setPq] = useState<PqStatus | null>(null);
  const [plans, setPlans] = useState<PlanSummary[]>([]);
  const [trail, setTrail] = useState<TrailRecord[] | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [gathering, setGathering] = useState(false);
  const local = machine === "local";
  const running = view?.run?.state === "reading" || view?.run?.state === "asking";
  const result = view?.latest ?? null;

  const changed = useRef(onSessionsChanged); changed.current = onSessionsChanged;
  const load = useCallback(() => call<View>(api).then(v => { setView(v); return v; }).catch(e => { setError(e.message); return null; }), [api]);
  useEffect(() => { void load(); }, [load]);
  // Back from PlanQuest's approval page: say how it went, and take the marker out of the address.
  useEffect(() => {
    const url = new URL(window.location.href), back = url.searchParams.get("planquest");
    if (!back) return;
    if (back === "connected") setNotice("PlanQuest is connected. Hangar can save work records when you press Save."); else setError("PlanQuest was not connected. Nothing changed.");
    url.searchParams.delete("planquest");
    window.history.replaceState(null, "", url);
  }, []);
  // PlanQuest is read by the console you are looking at, so plans and the trail are offered on this machine only.
  useEffect(() => {
    if (!local) return;
    call<PqStatus>("/api/planquest/status").then(status => {
      setPq(status);
      if (status.connected) call<{ plans: PlanSummary[] }>("/api/planquest/plans").then(d => setPlans(d.plans)).catch(() => { /* goals stay unlinked */ });
    }).catch(() => setPq({ connected: false }));
  }, [local]);
  // While a read runs: poll it, and show the certain part (which needs no reader) as soon as it is gathered.
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void load().then(v => { if (v?.run?.state === "done") { setFacts(null); changed.current?.(); } }), 3000);
    return () => clearInterval(timer);
  }, [running, load]);
  // Before any read there is still the certain part (what waits on you, what is finished, how you steered), which
  // needs no reader: it is gathered on this machine as soon as the page opens.
  const needFacts = !!view && !result;
  useEffect(() => {
    if (!needFacts) return;
    let stale = false;
    setFacts(null); setGathering(true);
    call<Facts>(`${api}/facts?days=${days}`).then(found => { if (!stale) setFacts(found); }).catch(e => { if (!stale) setError(e.message); }).finally(() => { if (!stale) setGathering(false); });
    return () => { stale = true; };
  }, [needFacts, api, days]);

  const start = async () => {
    setError(""); setNotice(""); setConfirm(false); setTrail(null);
    try { localStorage.setItem(CONSENT, reader); } catch { /* asked again next time */ }
    try {
      await call(api, { action: "run", days, reader, plans: plans.slice(0, 120).map(p => ({ id: p.id, title: p.title, folders: p.folders, url: p.url })) });
      await load();
    } catch (e) { setError((e as Error).message); }
  };
  const begin = () => {
    let agreed = "";
    try { agreed = localStorage.getItem(CONSENT) || ""; } catch { /* ask */ }
    if (agreed === reader) void start(); else setConfirm(true);
  };
  const act = async (body: Record<string, unknown>) => {
    setError("");
    try { setView(await call<View>(api, body)); setTrail(null); return true; }
    catch (e) { setError((e as Error).message); return false; }
  };

  const sessions = result?.sessions ?? facts?.sessions ?? {};
  const totals = result?.facts.totals ?? facts?.totals;
  const waiting = result?.facts.waiting ?? facts?.waiting ?? [];
  const finished = result?.facts.finished ?? facts?.finished ?? [];
  const families = result?.families ?? facts?.families ?? [];
  const read = result?.read;
  const readerName = (id: string) => view?.readers.find(r => r.id === id)?.name || id;
  const chosen = view?.readers.find(r => r.id === reader);
  const open = (key: string) => { const s = sessions[key]; if (s && onOpen) onOpen({ provider: s.provider, id: s.id }); };
  const goalOf = useMemo(() => new Map((read?.goals ?? []).map(g => [g.id, g])), [read]);
  const unplaced = useMemo(() => {
    if (!read) return [];
    const placed = new Set([...read.goals.flatMap(g => g.sessions), ...read.sidequests, ...read.archive.map(a => a.session)]);
    return Object.values(sessions).filter(s => !placed.has(s.key)).map(s => ({ key: s.key, note: s.needs ? "waiting on you" : s.verdict === "done" ? "done" : s.said.own ? `${plural(s.said.own, "turn")} of yours` : "nothing you typed" }));
  }, [read, sessions]);

  const archive = async () => {
    setArchiving(true); setError("");
    const rows = finished.slice(0, 500);
    try {
      const out = await call<{ archived: number; codexArchived: number; claudeQueued: number; hangarOnly: number }>(`/api/world/${machine}/proxy/sessions/library`,
        { action: "archive", keys: rows.map(r => r.key), activity: Object.fromEntries(rows.map(r => [r.key, r.activityAt])) });
      setNotice(`Archived ${out.archived}.` + (out.claudeQueued ? ` ${out.claudeQueued} of them live in the Claude app, which only a Claude session can change: ask one there to run Hangar's clean-up.` : ""));
      setFacts(null); changed.current?.();
      if (result) await act({ action: "archived", run: result.id, keys: rows.map(r => r.key) });
    } catch (e) { setError((e as Error).message); }
    finally { setArchiving(false); }
  };

  const allow = async () => {
    setError("");
    try { window.location.assign((await call<{ url: string }>("/api/planquest/connect", { records: true, returnTo: "/#sessions" })).url); }
    catch (e) { setError((e as Error).message); }
  };
  const preview = async () => {
    setError("");
    try { setTrail((await call<{ records: TrailRecord[] }>("/api/planquest/trail", { run: result?.id, preview: true })).records); }
    catch (e) { setError((e as Error).message); }
  };
  const save = async () => {
    setBusy(true); setError("");
    try {
      const out = await call<{ saved: Record<string, string>; failed: { title: string; error: string }[] }>("/api/planquest/trail", { run: result?.id });
      const count = Object.keys(out.saved).length;
      setNotice(count ? `Saved ${plural(count, "record")} to PlanQuest.` : "");
      if (out.failed.length) setError(`${out.failed[0].error}${out.failed.length > 1 ? ` (${out.failed.length} records not saved)` : ""}`);
      await load(); await preview();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  if (!view) return <div className="sb"><p className="sb-quiet">{error || "Loading…"}</p></div>;
  const run = view.run;
  return <div className="sb">
    <header className="sb-top">
      <div className="sb-title"><h2>Step back</h2>
        <p>{result ? <>Read by {readerName(result.reader)} · {when(result.at)} · last {result.days} days</> : "One read across your sessions: what you are really after, where you drifted, what to do next."}</p></div>
      <div className="sb-controls">
        <label><span>Look back</span><select value={days} disabled={running} onChange={e => setDays(Number(e.target.value))}>{view.windows.map(d => <option key={d} value={d}>{d} days</option>)}</select></label>
        <label><span>Read by</span><select value={reader} disabled={running} onChange={e => setReader(e.target.value)}>{view.readers.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
        <button className="sb-go" disabled={running} onClick={begin}>{running ? <Loader2 size={16} className="sb-spin" /> : <Undo2 size={16} />}{running ? (run?.state === "reading" ? "Gathering…" : `Reading ${run?.sessions || ""} sessions…`) : result ? "Step back again" : "Step back"}</button>
      </div>
    </header>

    {confirm && <section className="sb-consent" role="dialog" aria-label="Before the first read">
      <b>{readerName(reader)} will read what you typed</b>
      <p>Hangar gives it your own messages from the last {days} days of sessions, each cut short: not the agents&apos; replies, not your files. It runs read-only under your own {readerName(reader)} sign-in, in a private folder that is deleted when it finishes. Nothing is archived, committed or sent anywhere else.</p>
      {chosen?.signedIn === false && <p className="sb-warn">{chosen.name} is signed out on this machine. Sign in first (Hangar jobs → Sign in).</p>}
      <div><button className="sb-go" onClick={() => void start()}>Read my sessions</button><button className="cw-text-button" onClick={() => setConfirm(false)}>Not now</button></div>
    </section>}
    {run?.state === "failed" && !running && <p className="sb-warn" role="status">{run.message || "The last read did not finish."}</p>}
    {error && <p className="sb-warn" role="status">{error}</p>}
    {notice && <p className="sb-ok" role="status"><Check size={14} />{notice}</p>}

    {gathering && !totals && <p className="sb-quiet"><Loader2 size={15} className="sb-spin" />Gathering what is certain: what waits on you, what is finished, how you steered each session…</p>}
    {!read && !running && totals && <div className="sb-empty"><Undo2 size={24} aria-hidden="true" /><b>This much is certain. The read comes next.</b><p>Below is what Hangar knows without asking anyone. Press Step back and {readerName(reader)} reads what you typed across these sessions, then says what you are really after, where you drifted, and the next few moves.</p></div>}

    {read?.headline && <p className={`sb-headline ${running ? "is-old" : ""}`}>{read.headline}</p>}
    {result && <label className="sb-vision"><span>What is all of this for?</span>
      <input key={view.memory.vision} defaultValue={view.memory.vision} maxLength={600} placeholder="One line, in your words. It guides the next read." onBlur={e => { if (e.target.value.trim() !== view.memory.vision) void act({ action: "vision", text: e.target.value }); }} onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }} /></label>}

    {totals && <>
      <div className="sb-tiles">
        <div><small>Open sessions</small><b>{totals.open}</b></div>
        <div><small>Active, last {result?.days ?? facts?.days ?? days} days</small><b>{totals.recent}</b></div>
        <div className="is-wait"><small>Waiting on you</small><b>{totals.waiting}</b></div>
        <div><small>Untouched longer</small><b>{totals.stale}</b></div>
      </div>
      <Steer own={totals.own} accepted={totals.accepted} its={totals.itsIdeas} />
    </>}

    {running && <p className="sb-quiet"><Loader2 size={15} className="sb-spin" />{run?.state === "reading" ? "Gathering what you said and what is waiting…" : `${readerName(run?.reader || reader)} is reading ${run?.sessions || "your"} sessions. This takes a minute or two; you can leave this page.`}</p>}

    {(read || waiting.length > 0) && <div className="sb-grid">
      {read && <section className="sb-card sb-goals" aria-label="What you are really after">
        <h3><Target size={15} aria-hidden="true" />What you are really after</h3>
        {read.goals.map(goal => <GoalCard key={goal.id} goal={goal} sessions={sessions} plans={plans} linked={result!.plans[goal.plan]} call={result!.decisions[goal.id]?.decision}
          onOpen={onOpen ? open : undefined} onDecide={decision => void act({ action: "decide", run: result!.id, goal: goal.id, decision })}
          onPlan={plan => void act({ action: "plan", run: result!.id, goal: goal.id, plan })} />)}
        {!read.goals.length && <p className="sb-quiet">The read found no clear goal. Answer its questions below, then step back again.</p>}
      </section>}
      <div className="sb-side">
        {read && read.next.length > 0 && <section className="sb-card" aria-label="Do next">
          <h3><ListChecks size={15} aria-hidden="true" />Do next</h3>
          <ol className="sb-next">{read.next.map((step, i) => <li key={i}><b>{step.do}</b><small>{step.why}{goalOf.get(step.goal) ? ` · ${goalOf.get(step.goal)!.title}` : ""}</small>
            {step.session && onOpen && sessions[step.session] && <button className="cw-pill" onClick={() => open(step.session)}>Open<ArrowRight size={13} /></button>}</li>)}</ol>
        </section>}
        {waiting.length > 0 && <WaitingCard waiting={waiting} onOpen={onOpen ? open : undefined} />}
      </div>
    </div>}

    {read && read.drift.length > 0 && <section className="sb-card sb-drift" aria-label="Where you drifted">
      <h3><Route size={15} aria-hidden="true" />Where you drifted</h3>
      {read.drift.map((d, i) => {
        const s = sessions[d.session], family = families.find(f => f.root === s?.family);
        const whole = !!family && family.root === d.session, root = family ? sessions[family.root] : undefined;
        return <article key={i} className={`is-${d.by}`}>
          <header><b>{s?.title || "A thread"}</b><span className="sb-by">{BY[d.by]}</span>
            {family && family.sessions.length > 1 && <small>{whole ? `${plural(family.sessions.length, "session")} in this thread` : root ? `part of “${root.title}”` : "started by another session"}</small>}
            {onOpen && s && <button className="cw-pill" onClick={() => open(d.session)}>Open<ArrowRight size={13} /></button>}</header>
          <p className="sb-path"><span>{d.started}</span>{d.wandered.map((w, j) => <span key={j}><ArrowRight size={12} aria-hidden="true" />{w}</span>)}</p>
          <p className="sb-note">{d.note}</p>
          {whole ? <Steer own={family!.own} accepted={family!.accepted} its={family!.itsIdeas} small /> : s && <Steer own={s.said.own} accepted={s.said.accepted} its={s.said.proposedByIt} small />}
        </article>;
      })}
    </section>}

    {read && read.questions.length > 0 && <section className="sb-card sb-questions" aria-label="Questions for you">
      <h3><HelpCircle size={15} aria-hidden="true" />It asks you</h3>
      {read.questions.map(q => <QuestionCard key={q.id} question={q} goal={goalOf.get(q.goal)?.title} answer={result!.answers[q.id]?.text} onAnswer={text => act({ action: "answer", run: result!.id, question: q.id, text })} />)}
    </section>}

    {(finished.length > 0 || (read && (read.archive.length > 0 || read.sidequests.length > 0))) && <section className="sb-card sb-archive" aria-label="Can go">
      <h3><Archive size={15} aria-hidden="true" />Can go</h3>
      {finished.length > 0 && <div className="sb-archive-row"><p><b>{plural(finished.length, "session")}</b> finished, read, and untouched for {result?.days ?? facts?.days ?? days}+ days. Their work is committed and pushed, or was finished by later sessions.</p>
        <span>{onCleanUp && <button className="cw-text-button" onClick={onCleanUp}>Look through them</button>}
          <button className="cw-pill" disabled={archiving} onClick={() => { if (window.confirm(`Archive ${Math.min(500, finished.length)} finished sessions? You can restore them from the Archived list.`)) void archive(); }}>{archiving ? "Archiving…" : `Archive ${Math.min(500, finished.length)}`}</button></span></div>}
      {read && read.archive.length > 0 && <SessionList title="Repeat or overtaken" rows={read.archive.map(a => ({ key: a.session, note: a.why }))} sessions={sessions} onOpen={onOpen ? open : undefined} />}
      {read && read.sidequests.length > 0 && <SessionList title="Side quests: they serve none of your goals" rows={read.sidequests.map(key => ({ key, note: "" }))} sessions={sessions} onOpen={onOpen ? open : undefined} />}
      {unplaced.length > 0 && <SessionList title="Not placed by the read" rows={unplaced} sessions={sessions} onOpen={onOpen ? open : undefined} folded />}
    </section>}

    {result && local && <section className="sb-card sb-trail" aria-label="Trail in PlanQuest">
      <h3><MapPin size={15} aria-hidden="true" />Trail in PlanQuest</h3>
      {!pq?.connected ? <p>Connect PlanQuest (a project → PlanQuest) and this read can leave a record on the plan each goal belongs to.</p>
        : !pq.canRecord ? <div className="sb-archive-row"><p>Hangar can read your plans but not write. Allow it to save work records and each goal, answer and decision here lands on its plan. It still cannot change a plan or tick a milestone.</p><button className="cw-pill" onClick={() => void allow()}>Allow work records<ExternalLink size={13} /></button></div>
        : <>
          <div className="sb-archive-row"><p>Each goal (where it stands, what is next), each answer and each decision becomes a short work record on its plan. Never a transcript.</p>
            <span><button className="cw-text-button" onClick={() => void preview()}>{trail ? "Refresh" : "Show the records"}</button>
              <button className="cw-pill" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save to PlanQuest"}</button></span></div>
          {trail && <ul className="sb-records">{trail.map(r => <li key={r.key} className={r.saved ? "is-saved" : ""}><span className="sb-type">{r.type.replace("_", " ")}</span><b>{r.title}</b>
            <small>{r.plan_id ? result.plans[r.plan_id]?.title || "a plan" : "no plan linked"}</small>{r.saved ? <a href={r.saved.url} target="_blank" rel="noreferrer">Saved<ExternalLink size={12} /></a> : <i>not saved</i>}</li>)}</ul>}
        </>}
    </section>}
  </div>;
}

function GoalCard({ goal, sessions, plans, linked, call: made, onOpen, onDecide, onPlan }: {
  goal: Goal; sessions: Record<string, SbSession>; plans: PlanSummary[]; linked?: { title: string; url: string }; call?: Decision;
  onOpen?: (key: string) => void; onDecide: (decision: Decision) => void; onPlan: (plan: { id: string; title: string; folders: string[]; url: string } | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const rows = goal.sessions.map(key => sessions[key]).filter(Boolean);
  const waiting = rows.filter(s => s.status === "blocked" || s.needs).length;
  return <article className={`sb-goal is-${goal.state}`}>
    <header><b>{goal.title}</b><span className="sb-state">{STATE[goal.state]}</span></header>
    <div className="sb-share" role="img" aria-label={`About ${goal.share}% of your recent attention`}><i style={{ width: `${Math.max(3, goal.share)}%` }} /></div>
    <p>{goal.why}{goal.quote && <q>{goal.quote}</q>}</p>
    <div className="sb-goal-meta">
      <button className="cw-text-button" aria-expanded={open} onClick={() => setOpen(!open)}>{plural(rows.length, "session")}{waiting ? ` · ${waiting} waiting on you` : ""}<ChevronDown size={13} /></button>
      {linked ? <a className="sb-plan" href={linked.url} target="_blank" rel="noreferrer" title="Open the plan in PlanQuest"><MapPin size={12} />{linked.title}</a>
        : plans.length > 0 && <select className="sb-plan-pick" aria-label={`Plan for ${goal.title}`} value="" onChange={e => { const p = plans.find(x => x.id === e.target.value); if (p) onPlan({ id: p.id, title: p.title, folders: p.folders, url: p.url }); }}>
          <option value="">Link a plan…</option>{plans.map(p => <option key={p.id} value={p.id}>{p.folders.length ? `${p.folders.join(" / ")} / ` : ""}{p.title}</option>)}</select>}
      {linked && <button className="cw-text-button" onClick={() => onPlan(null)}>Unlink</button>}
      <span className="sb-calls" role="group" aria-label={`Your call on ${goal.title}`}>{CALLS.map(([id, label]) => <button key={id} aria-pressed={made === id} onClick={() => onDecide(id)}>{label}</button>)}</span>
    </div>
    {open && <div className="sb-goal-more">
      {goal.done.length > 0 && <p><b>Done</b>{goal.done.join(" · ")}</p>}
      {goal.left.length > 0 && <p><b>Left</b>{goal.left.join(" · ")}</p>}
      <ul>{rows.map(s => <li key={s.key}><AgentMark agent={s.provider === "codex" ? "codex" : "claude"} /><span>{s.title}</span><small>{s.needs ? "waiting on you" : s.verdict === "done" ? "done" : s.working ? "working" : `${s.idleDays ?? 0}d ago`}</small>
        {onOpen && <button className="cw-text-button" onClick={() => onOpen(s.key)}>Open</button>}</li>)}</ul>
    </div>}
  </article>;
}

function WaitingCard({ waiting, onOpen }: { waiting: Waiting[]; onOpen?: (key: string) => void }) {
  const kinds = ORDER.filter(kind => waiting.some(w => w.kind === kind));
  const [kind, setKind] = useState<WaitKind | null>(null), [all, setAll] = useState(false);
  const current = kind && kinds.includes(kind) ? kind : kinds[0];
  const rows = waiting.filter(w => w.kind === current);
  return <section className="sb-card sb-waiting" aria-label="Waiting on you">
    <h3><Hourglass size={15} aria-hidden="true" />Waiting on you</h3>
    <div className="sb-kinds" role="group" aria-label="What kind">{kinds.map(k => <button key={k} className={`is-${k}`} aria-pressed={k === current} onClick={() => { setKind(k); setAll(false); }}><i aria-hidden="true" />{WAIT[k].label}<small>{waiting.filter(w => w.kind === k).length}</small></button>)}</div>
    <ul>{(all ? rows : rows.slice(0, 5)).map((w, i) => <li key={i} className={`is-${w.kind}`}><span><b>{w.title || w.project}</b><small>{w.what}</small></span>
      {w.session && onOpen && <button className="cw-pill" onClick={() => onOpen(w.session!)}>{WAIT[w.kind].one}<ArrowRight size={13} /></button>}</li>)}</ul>
    {rows.length > 5 && <button className="cw-text-button" onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${rows.length}`}</button>}
  </section>;
}

function QuestionCard({ question, goal, answer, onAnswer }: { question: Question; goal?: string; answer?: string; onAnswer: (text: string) => Promise<boolean> }) {
  const [draft, setDraft] = useState(""), [editing, setEditing] = useState(false), [missing, setMissing] = useState(false);
  const send = async (text: string) => { if (!text.trim()) { setMissing(true); return; } if (await onAnswer(text)) { setDraft(""); setEditing(false); } };
  return <article className={answer && !editing ? "is-answered" : ""}>
    <b>{question.ask}</b><small>{question.why}{goal ? ` · ${goal}` : ""}</small>
    {answer && !editing ? <p className="sb-answer"><Check size={14} />{answer}<button className="cw-text-button" onClick={() => setEditing(true)}>Change</button></p> : <>
      <div className="sb-options">{question.options.map(option => <button key={option} onClick={() => void send(option)}>{option}</button>)}</div>
      <form onSubmit={e => { e.preventDefault(); void send(draft); }}><input aria-label="Your own answer" aria-invalid={missing} value={draft} maxLength={600} placeholder="Or say it your way" onChange={e => { setDraft(e.target.value); setMissing(false); }} /><button type="submit" className="cw-pill">Save</button></form>
      {missing && <small className="sb-warn">Pick an answer or write one first.</small>}
    </>}
  </article>;
}

function SessionList({ title, rows, sessions, onOpen, folded }: { title: string; rows: { key: string; note: string }[]; sessions: Record<string, SbSession>; onOpen?: (key: string) => void; folded?: boolean }) {
  const known = rows.filter(r => sessions[r.key]);
  const [shown, setShown] = useState(!folded), [all, setAll] = useState(false);
  if (!known.length) return null;
  return <div className="sb-list"><b>{title}<small>{known.length}</small>{folded && <button className="cw-text-button" aria-expanded={shown} onClick={() => setShown(!shown)}>{shown ? "Hide" : "Show"}</button>}</b>
    {shown && <ul>{(all ? known : known.slice(0, 8)).map(r => <li key={r.key}><AgentMark agent={sessions[r.key].provider === "codex" ? "codex" : "claude"} /><span>{sessions[r.key].title}</span><small>{r.note}</small>
      {onOpen && <button className="cw-text-button" onClick={() => onOpen(r.key)}>Open</button>}</li>)}</ul>}
    {shown && known.length > 8 && <button className="cw-text-button" onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${known.length}`}</button>}</div>;
}
