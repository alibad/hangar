"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, FolderGit2, Layers, X } from "lucide-react";
import { workspaceResponse } from "@/lib/workspace-response";
import "./workspace-operations.css";

export type WorkspaceProject = { id: string; name: string; fullName?: string; hidden?: boolean; hiddenByIsland?: string; family: string; sites: { role: string; dirty?: number; branch?: string }[]; risks?: { id: string; text: string }[] };
export type Island = { id: string; name: string; repos: number; hidden?: boolean; custom?: boolean };
export type OperationPanel = { kind: "clone" | "islands" | "pull"; repo?: WorkspaceProject; island?: string };
type Job = { id: string; action: string; label: string; state: string; error?: string; results: { repo: string; name: string; status: string; message: string }[] };
type Snapshot = { roots: { id: string; path: string }[]; islands: Island[]; jobs: Job[] };
async function request<T>(url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const r = await fetch(url, { method: body ? "POST" : "GET", signal, cache: "no-store", headers: body ? { "Content-Type": "application/json", "X-Hangar": "1" } : undefined, body: body ? JSON.stringify(body) : undefined });
  return workspaceResponse<T>(r);
}

export function WorkspaceOperations({ panel, machine, machineName, projects, onClose, onChanged }: {
  panel: OperationPanel; machine: string; machineName: string; projects: WorkspaceProject[]; onClose: () => void; onChanged: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<Snapshot | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const [root, setRoot] = useState("");
  const [folder, setFolder] = useState(panel.repo?.name || "");
  const [island, setIsland] = useState(panel.island || "");
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [confirmHide, setConfirmHide] = useState(false);
  const [chosen, setChosen] = useState<string[]>(panel.kind === "pull" ? projects.filter(r => !r.hidden && r.sites.some(s => s.role === "canonical" && !s.dirty)).map(r => r.id) : []);
  const changed = useRef(onChanged); changed.current = onChanged;
  const observed = useRef(new Set<string>());
  const endpoint = `/api/world/${machine}/proxy/${panel.kind === "islands" ? "islands" : "workspace"}`;
  useEffect(() => { const d = dialog.current; d?.showModal(); return () => d?.close(); }, []);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await request<Snapshot>(endpoint, undefined, controller.signal);
        if (controller.signal.aborted) return;
        setData(result); setError(""); setRoot(r => r || result.roots[0]?.id || "");
        for (const job of result.jobs) if (job.state !== "running" && !observed.current.has(job.id)) { observed.current.add(job.id); changed.current(); }
      } catch (e) { if (!controller.signal.aborted) setError((e as Error).message); }
      if (!controller.signal.aborted && panel.kind !== "islands") timer = setTimeout(poll, 2500);
    };
    void poll(); return () => { controller.abort(); clearTimeout(timer); };
  }, [endpoint, panel.kind, retry]);
  async function act(body: Record<string, unknown>) {
    setBusy(true); setError("");
    try {
      const result = await request<{ island?: string }>(endpoint, body);
      setData(await request<Snapshot>(endpoint));
      if (result.island) { setIsland(result.island); setConfirmHide(false); setChosen([]); setName(""); changed.current(); }
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  const selected = data?.islands.find(f => f.id === island);
  const working = busy || !!data?.jobs.some(j => j.state === "running");
  const toggle = (id: string) => setChosen(ids => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]);
  const members = projects.filter(r => r.family === island || r.hiddenByIsland === island);
  const candidates = projects.filter(r => (panel.kind !== "pull" || r.sites.some(s => s.role === "canonical")) && r.name.toLowerCase().includes(query.toLowerCase()));
  return <dialog ref={dialog} className="workspace-operations" aria-labelledby="workspace-operation-title" onCancel={e => { if (busy) e.preventDefault(); else onClose(); }}>
    <header><div><span className="cw-eyebrow">{machineName}</span><h2 id="workspace-operation-title">{panel.kind === "clone" ? "Bring this project here." : panel.kind === "pull" ? "Review repository updates." : "Shape your islands."}</h2></div><button aria-label="Close workspace operation" disabled={busy} onClick={onClose}><X size={20} /></button></header>
    {error && <div><p role="alert" className="cw-error">{error}</p><button disabled={busy} onClick={() => { setError(""); setRetry(n => n + 1); }}>Retry connection</button></div>}
    {!data && !error && <p role="status">Reading this machine’s workspace…</p>}
    {data && panel.kind === "clone" && <><div className="wo-project"><FolderGit2 size={28} /><div><h3>{panel.repo?.name}</h3><p>{panel.repo?.fullName}</p></div></div><p>Clone onto {machineName}, then start or continue coding. Existing folders are never overwritten.</p><fieldset><legend>Code root on {machineName}</legend>{data.roots.map(r => <label key={r.id}><input type="radio" name="clone-root" value={r.id} checked={root === r.id} onChange={() => setRoot(r.id)} /><span><b>{r.id}</b><small>{r.path}</small></span></label>)}</fieldset>{!data.roots.length && <p>No main code root is configured. Configure a canonical scan root in Hangar local var/engine/roots.json on this machine first.</p>}<label className="cw-input-label">New folder name<input value={folder} maxLength={100} onChange={e => setFolder(e.target.value)} /></label><p className="wo-location">{data.roots.find(r => r.id === root)?.path} / {folder}</p><button className="cw-primary" disabled={working || !root || !folder.trim() || !!projects.find(r => r.id === panel.repo?.id)?.sites.length} onClick={() => void act({ action: "clone", repo: panel.repo?.id, root, folder })}>Clone on {machineName}</button></>}
    {data && panel.kind === "islands" && <><div className="wo-islands">{data.islands.map(f => <button key={f.id} aria-pressed={island === f.id} onClick={() => { setIsland(f.id); setConfirmHide(false); setChosen([]); }}><Layers size={16} /><span>{f.name}<small>{f.hidden ? "Hidden · " : ""}{f.repos} projects</small></span></button>)}</div><form className="wo-create" onSubmit={e => { e.preventDefault(); void act({ action: "create-island", name }); }}><label className="cw-input-label">New island name<input value={name} maxLength={60} onChange={e => setName(e.target.value)} placeholder="A product, purpose or workstream" /></label><button disabled={working || !name.trim()}>Create island</button></form>{selected && <section className="wo-island-detail"><h3>{selected.name}</h3><p>{selected.hidden ? "Hidden islands and their projects remain recoverable here." : selected.repos ? `${members.length} projects belong here.` : "Add projects below to make this island appear in the world."}</p>{confirmHide ? <div className="wo-confirm"><p>Hide this island and its {members.filter(r => !r.hidden).length} visible projects? Files, sessions and plan links stay intact. Restore the whole island here.</p><div className="wo-members">{members.map(r => <span key={r.id}>{r.name}</span>)}</div><button disabled={working} onClick={() => void act({ action: "hide-island", island })}>Hide island</button><button onClick={() => setConfirmHide(false)}>Keep island</button></div> : <button disabled={working} onClick={() => selected.hidden ? void act({ action: "restore-island", island }) : setConfirmHide(true)}>{selected.hidden ? "Restore island" : "Remove island from world…"}</button>}{!selected.hidden && !confirmHide && <><label className="cw-input-label">Find projects to move<input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search projects" /></label><div className="wo-project-picker">{candidates.filter(r => r.family !== island).map(r => <label key={r.id}><input type="checkbox" checked={chosen.includes(r.id)} onChange={() => toggle(r.id)} /><span>{r.name}<small>{r.hidden ? "Hidden" : data.islands.find(f => f.id === r.family)?.name || r.family}</small></span></label>)}</div><button className="cw-primary" disabled={working || !chosen.length} onClick={() => void act({ action: "assign-island", island, repos: chosen })}>Move {chosen.length || "selected"} projects here</button></>}</section>}</>}
    {data && panel.kind === "pull" && <><p>Fetch and fast-forward the selected main checkouts. Local changes, diverged branches and active Hangar jobs are skipped with a reason. No merge commits, rebases or forced updates.</p><div className="wo-pull-actions"><button onClick={() => setChosen(candidates.filter(r => !r.hidden && r.sites.some(s => s.role === "canonical" && !s.dirty)).map(r => r.id))}>Select clean visible projects</button><button onClick={() => setChosen([])}>Clear</button></div><label className="cw-input-label">Find a repository<input value={query} onChange={e => setQuery(e.target.value)} /></label><div className="wo-project-picker">{candidates.map(r => <label key={r.id}><input type="checkbox" checked={chosen.includes(r.id)} onChange={() => toggle(r.id)} /><span>{r.name}<small>{r.sites.some(s => s.role === "canonical" && s.dirty) ? "Local changes · will skip" : r.risks?.some(k => k.id === "pull") ? "Updates detected" : "Check remote for updates"}</small></span></label>)}</div><button className="cw-primary" disabled={working || !chosen.length} onClick={() => void act({ action: "pull", repos: chosen })}><ArrowDownToLine size={16} />Pull selected ({chosen.length})</button></>}
    {data?.jobs.filter(j => j.action === panel.kind).slice(-2).reverse().map(j => <section key={j.id} className="wo-results" aria-live="polite"><h3>{j.label} · {j.state}</h3>{j.state === "running" && <p>Working on {machineName}. You can close this panel and reopen it to see the result.</p>}{j.error && <p role="alert">{j.error}</p>}{j.results.map((r, i) => <p key={`${r.repo}-${i}`}><b>{r.name} · {r.status}</b><span>{r.message}</span></p>)}</section>)}
  </dialog>;
}
