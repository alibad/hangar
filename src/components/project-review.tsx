"use client";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, Search, X } from "lucide-react";
import { workspaceResponse } from "@/lib/workspace-response";
import type { Island } from "./workspace-operations";
import "./project-review.css";
type Project = { id: string; name: string; description?: string; meaning?: { purpose?: string }; family: string; hidden?: boolean; organizationReviewed?: boolean; sites: unknown[] };
export default function ProjectReview({ projects, islands, machine, onClose, onChanged, onInspect }: { projects: Project[]; islands: Island[]; machine: string; onClose: () => void; onChanged: () => Promise<void>; onInspect: (id: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState(""), [scope, setScope] = useState("all"), [target, setTarget] = useState(""), [name, setName] = useState(""), [selected, setSelected] = useState<string[]>([]), [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  useEffect(() => { const d = dialog.current; d?.showModal(); return () => d?.close(); }, []);
  const pending = projects.filter(p => !p.organizationReviewed).length;
  const visible = projects.filter(p => (scope !== "unreviewed" || !p.organizationReviewed) && (scope !== "hidden" || p.hidden) && `${p.name} ${p.description || ""} ${p.meaning?.purpose || ""}`.toLowerCase().includes(query.toLowerCase()));
  const chosen = projects.filter(p => selected.includes(p.id));
  const destination = islands.find(i => i.id === target);
  async function save(body: Record<string, unknown>) {
    setBusy(true); setMessage("");
    try {
      const result = await workspaceResponse<{ island?: string }>(await fetch(`/api/world/${machine}/proxy/islands`, { method: "POST", headers: { "Content-Type": "application/json", "X-Hangar": "1" }, body: JSON.stringify(body) }));
      await onChanged();
      if (body.action === "create-island") { setTarget(result.island || ""); setName(""); setMessage("Category created. Choose projects, then Apply category."); }
      else { setSelected([]); setMessage(body.action === "review-projects" ? "Marked reviewed. Categories unchanged." : "Category applied. Individually hidden projects remain hidden."); }
    } catch (e) { setMessage((e as Error).message); }
    finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="project-review" aria-labelledby="project-review-title" onCancel={e => { if (busy) e.preventDefault(); else onClose(); }}>
    <header><div><span className="cw-eyebrow">YOUR PROJECTS · YOUR ORGANIZATION</span><h2 id="project-review-title">Give every project a place.</h2><p>{projects.length} projects · {pending} left to review</p></div><button disabled={busy} aria-label="Close category review" onClick={onClose}><X size={22} /></button></header>
    <div className="pr-layout"><section className="pr-catalog"><div className="pr-tools"><label><Search size={17} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search names or purpose" aria-label="Search projects for categorization" /></label><div className="pr-scopes">{[["all","All projects"],["unreviewed","Needs review"],["hidden","Hidden"]].map(([id,label]) => <button key={id} aria-pressed={scope===id} onClick={() => setScope(id)}>{label}</button>)}</div></div>
      <div className="pr-selection"><span>{selected.length} selected · {visible.length} shown</span><button disabled={busy} onClick={() => setSelected(visible.slice(0,300).map(p => p.id))}>Select shown{visible.length>300?" (first 300)":""}</button><button disabled={busy} onClick={() => setSelected([])}>Clear</button></div>
      <div className="pr-table"><table><thead><tr><th>Choose</th><th>Project & purpose</th><th>Current island</th><th>Review</th></tr></thead><tbody>{visible.map(p => <tr key={p.id} className={selected.includes(p.id)?"is-selected":""}><td><input type="checkbox" disabled={busy} aria-label={`Select ${p.name}`} checked={selected.includes(p.id)} onChange={() => setSelected(ids => ids.includes(p.id) ? ids.filter(id => id !== p.id) : [...ids,p.id].slice(0,300))} /></td><td><button className="pr-project-name" onClick={() => { onClose(); onInspect(p.id); }}>{p.name}<ArrowRight size={13} /></button><p>{p.meaning?.purpose || p.description || "No purpose recorded yet"}</p><small>{p.hidden?"Hidden · ":""}{p.sites.length?"On this machine":"Not cloned here"}</small></td><td>{islands.find(f => f.id === p.family)?.name || p.family}</td><td>{p.organizationReviewed?<span className="pr-reviewed"><Check size={14}/>Reviewed</span>:"To review"}</td></tr>)}</tbody></table>{!visible.length&&<p>No matching projects.</p>}</div>
    </section><aside className="pr-destination"><h3>Choose their island</h3><p>Existing groupings are a starting point. Nothing moves until you apply a category.</p><div className="pr-islands">{islands.filter(i => !i.hidden).map(i => <button disabled={busy} key={i.id} aria-pressed={target===i.id} onClick={() => setTarget(i.id)}><span>{i.name}</span><small>{i.repos}</small></button>)}</div>
      <form onSubmit={e => {e.preventDefault();void save({action:"create-island",name});}}><label>New category<input value={name} onChange={e => setName(e.target.value)} maxLength={60} placeholder="A product, purpose or workstream" /></label><button disabled={busy||!name.trim()}>Create category</button></form>
      {chosen.length>0&&<div className="pr-preview"><h3>{chosen.length} projects {destination?`→ ${destination.name}`:"selected"}</h3><ul>{chosen.slice(0,8).map(p=><li key={p.id}>{p.name}</li>)}</ul>{chosen.length>8&&<small>and {chosen.length-8} more</small>}</div>}
      <button className="cw-primary" disabled={busy||!selected.length||!destination||destination.hidden} onClick={() => void save({action:"assign-island",island:target,repos:selected})}>Apply category</button><button disabled={busy||!selected.length} onClick={() => void save({action:"review-projects",repos:selected})}>Keep categories · mark reviewed</button>
      {message&&<p role="status">{message}</p>}
    </aside></div>
  </dialog>;
}
