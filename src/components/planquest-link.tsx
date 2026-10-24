"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowRight, Check, Compass, ExternalLink, Flag, Link2, Search, Unplug, X } from "lucide-react";
import type { PlanDetail, PlanSummary } from "@/lib/planquest";
import "./planquest-link.css";

type Link = { title: string; url: string };
type Status = { connected: boolean; endpoint: string; scope: string };
async function api<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { method: body === undefined ? "GET" : "POST", cache: "no-store", signal,
    headers: body === undefined ? undefined : { "Content-Type": "application/json", "X-Hangar": "1" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "The request failed. Try again.");
  return result;
}

export default function PlanQuestLink({ machine, repo, projectName }: { machine: string; repo: string; projectName: string }) {
  const [link, setLink] = useState<Link | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [plans, setPlans] = useState<PlanSummary[] | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<PlanDetail | null>(null);
  const [revision, setRevision] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const prefix = `/api/world/${machine}/proxy/plans`;
  const reload = useCallback(() => setRevision(v => v + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void Promise.allSettled([
      api<Status>("/api/planquest/status", undefined, controller.signal),
      api<{ links: Record<string, Link> }>(prefix, undefined, controller.signal),
    ]).then(([connection, links]) => {
      if (controller.signal.aborted) return;
      if (connection.status === "fulfilled") setStatus(connection.value);
      if (links.status === "fulfilled") setLink(links.value.links[repo] || null);
      const failed = [connection, links].find(r => r.status === "rejected");
      if (failed?.status === "rejected") setError(failed.reason.message);
      setLoading(false);
    });
    return () => controller.abort();
  }, [prefix, repo, revision]);

  useEffect(() => {
    const url = new URL(window.location.href);
    const result = url.searchParams.get("planquest");
    if (!result) return;
    setOpen(true);
    if (result === "failed") setError("Connection wasn’t completed. Try again and allow read access in PlanQuest.");
    else setNotice("PlanQuest connected. Choose the plan for this project.");
    url.searchParams.delete("planquest");
    window.history.replaceState(window.history.state, "", url);
  }, []);
  useEffect(() => {
    const element = dialog.current;
    if (open && element && !element.open) element.showModal();
    else if (!open && element?.open) element.close();
  }, [open]);
  useEffect(() => {
    if (!open || !status?.connected) return;
    const controller = new AbortController();
    setPlans(null);
    api<{ plans: PlanSummary[] }>("/api/planquest/plans", undefined, controller.signal).then(data => {
      if (!controller.signal.aborted) setPlans(data.plans);
    }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [open, status?.connected, revision]);
  useEffect(() => {
    setDetail(null);
    if (!selected || !open || !status?.connected) return;
    const controller = new AbortController();
    api<{ plan: PlanDetail }>(`/api/planquest/plans/${encodeURIComponent(selected)}`, undefined, controller.signal)
      .then(data => { if (!controller.signal.aborted) setDetail(data.plan); })
      .catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [selected, open, status?.connected, revision]);

  const filtered = useMemo(() => {
    const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    return (plans || []).filter(plan => words.every(word => `${plan.title} ${plan.description} ${plan.folders.join(" ")}`.toLowerCase().includes(word)));
  }, [plans, query]);

  async function connect() {
    setBusy(true); setError("");
    try {
      const result = await api<{ url: string }>("/api/planquest/connect", {});
      sessionStorage.setItem("hangar-planquest-return", JSON.stringify({ machine, repo }));
      window.location.assign(result.url);
    } catch (e) { setError((e as Error).message); setBusy(false); }
  }
  async function save() {
    if (!detail || busy) return;
    setBusy(true); setError("");
    try {
      const result = await api<{ link: Link }>("/api/planquest/link", { machine, repo, plan_id: detail.id });
      setLink(result.link); setNotice(`Linked to ${result.link.title}.`); setOpen(false);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function unlink() {
    setBusy(true); setError("");
    try { await api(prefix, { repo, title: "", url: "" }); setLink(null); setNotice("Project unlinked. The plan is unchanged."); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function disconnect() {
    setBusy(true); setError("");
    try {
      const result = await api<{ revoked: boolean }>("/api/planquest/disconnect", {});
      setStatus(s => s ? { ...s, connected: false } : null); setPlans(null); setDetail(null); setSelected(null);
      setNotice(result.revoked ? "Disconnected. Existing project links are kept." : "Disconnected locally. PlanQuest couldn’t revoke access; remove Hangar in PlanQuest’s connected apps too.");
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  const feedback = <>{error && <div className="pq-error" role="alert"><span>{error}</span><button disabled={busy} onClick={() => { setError(""); reload(); }}>Retry</button></div>}{notice && <p className="pq-notice" role="status">{notice}</p>}</>;

  return <section className="pq-card" aria-label="PlanQuest project connection">
    <div className="pq-card-heading"><Compass size={18} /><strong>PlanQuest</strong><span className={`pq-status ${status?.connected ? "is-connected" : ""}`}>{loading ? "Checking…" : status?.connected ? "Connected" : "Not connected"}</span></div>
    {link ? <a className="pq-linked" href={link.url} rel="noreferrer"><Flag size={18} /><span>{link.title}</span><ExternalLink size={14} /></a> : <p>Give this project a destination.<br />Find its plan and bring the milestones into view.</p>}
    <button className="pq-primary" disabled={loading || busy} onClick={() => { setOpen(true); setError(""); setNotice(""); }}>{link ? "View or change plan" : status?.connected ? "Find a plan" : "Connect PlanQuest"}<ArrowRight size={15} /></button>
    {!open && feedback}
    <dialog ref={dialog} className="pq-dialog" aria-labelledby={titleId} onCancel={e => { if (busy) e.preventDefault(); else setOpen(false); }} onClose={() => setOpen(false)}>
      <header className="pq-dialog-head"><div><span className="pq-eyebrow">PROJECT → PLAN</span><h2 id={titleId}>{projectName}</h2></div><button className="pq-icon-button" aria-label="Close PlanQuest" disabled={busy} onClick={() => setOpen(false)}><X size={20} /></button></header>
      {status?.connected ? <>
        <div className="pq-toolbar"><label className="pq-search"><Search size={18} /><input autoFocus aria-label="Search PlanQuest plans" placeholder="Search plans, goals or folders…" value={query} onChange={e => setQuery(e.target.value)} /></label><button disabled={busy} onClick={() => { setError(""); reload(); }}>Refresh</button></div>
        <div className="pq-picker">
          <div className="pq-results" aria-label="Available plans"><div className="pq-result-count" role="status">{plans ? `${filtered.length} plans · your PlanQuest access` : error ? "Plans unavailable" : "Reading your plans…"}</div>
            {plans && !filtered.length && <div className="pq-empty"><Compass size={28} /><strong>{plans.length ? "No matching plans" : "No active plans yet"}</strong><p>{plans.length ? "Try a goal, title or folder name." : "Create a plan in PlanQuest, then refresh here."}</p></div>}
            {filtered.map(plan => <button className="pq-result" key={plan.id} aria-pressed={selected === plan.id} onClick={() => { setSelected(plan.id); setError(""); }}><span className="pq-plan-icon"><Flag size={17} /></span><span><strong>{plan.title}</strong><small>{plan.folders.join(" / ") || "Plans"} · {plan.access}</small><p>{plan.description || "Open to preview milestones."}</p></span>{link?.url === plan.url && <Check size={16} aria-label="Currently linked" />}</button>)}
          </div>
          <div className="pq-preview" aria-busy={!!selected && !detail && !error}>
            {detail ? <><div className="pq-preview-label"><span className="pq-eyebrow">PLAN PREVIEW</span><a href={detail.url} rel="noreferrer" aria-label="Open plan in PlanQuest"><ExternalLink size={16} /></a></div><h3>{detail.title}</h3><p className="pq-description">{detail.description || "No description added."}</p><div className="pq-progress-heading"><span>Plan progress</span><strong>{Math.round(detail.progress)}%</strong></div><progress value={detail.progress} max={100} aria-label="Plan progress" /><h4>{detail.milestones.length} active milestones</h4><div className="pq-milestones">{detail.milestones.length ? detail.milestones.map(m => <article key={m.id}><div><Flag size={14} /><strong>{m.title}</strong><span>{Math.round(m.progress)}%</span></div>{m.endDate && <small>Due {m.endDate.slice(0, 10)}</small>}{m.keyResults.length > 0 && <ul>{m.keyResults.map((k, i) => <li key={i}><span>{k.title}</span><small>{Math.round(k.progress)}%</small></li>)}</ul>}</article>) : <p>No active milestones in this plan.</p>}</div></> : <div className="pq-empty"><div className="pq-bridge"><Compass size={35} /><span /><Flag size={28} /></div><strong>{selected ? error ? "Preview unavailable" : "Reading milestones…" : "Which plan drives this work?"}</strong><p>{selected ? "The project link stays unchanged until you choose Link plan." : "Select a plan to preview its goals and milestones before linking it."}</p></div>}
          </div>
        </div>
        <div className="pq-feedback">{feedback}</div>
        <footer className="pq-footer"><div><span>{link ? `Currently: ${link.title}` : "No plan linked yet"}</span><small>Links don’t change milestone progress.</small></div><button className="pq-primary" disabled={!detail || busy} onClick={() => void save()}><Link2 size={16} />{busy ? "Working…" : "Link plan"}</button></footer>
      </> : <div className="pq-connect"><div className="pq-bridge"><img src="/brand/foundry.png" width="100" height="100" alt="Hangar" /><span /><Compass size={62} /></div><h3>Your work, connected to its purpose.</h3><p>Sign in to PlanQuest once. Browse your plans, preview milestones and choose what this project belongs to.</p><button className="pq-primary" disabled={busy} onClick={() => void connect()}>{busy ? "Opening PlanQuest…" : "Continue to PlanQuest"}<ArrowRight size={17} /></button><small>Read-only access to plans. You’ll approve access in PlanQuest and return here.</small>{feedback}</div>}
      <details className="pq-settings"><summary>Connection &amp; agent access</summary><p>Hangar uses PlanQuest’s MCP at <code>https://my.plans.quest/mcp</code>. Connect above to configure it automatically with read-only plan access.</p><p>Claude and Codex can use Hangar’s <code>planquest_plans</code>, <code>planquest_plan</code> and <code>planquest_link</code> tools. Reload your Hangar MCP connection after updating.</p><div>{status?.connected && <button disabled={busy} onClick={() => void disconnect()}><Unplug size={14} />Disconnect PlanQuest</button>}{link && <button disabled={busy} onClick={() => void unlink()}>Unlink this project</button>}</div>{status?.connected && <button className="pq-reconnect" disabled={busy} onClick={() => void connect()}>Reconnect or use another account</button>}</details>
    </dialog>
  </section>;
}
