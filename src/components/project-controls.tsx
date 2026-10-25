"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { mapPalette } from "@/lib/map-palette";
import { Eye, EyeOff, FolderOpen, PanelRightOpen, Star, Pause, X } from "lucide-react";
import { useTheme } from "./theme-provider";
import "./project-controls.css";

export type ProjectChoice = { id: string; name: string; hidden?: boolean; hiddenByIsland?: string; attention?: string | null; sites: unknown[] };
export type ProjectMenuTarget = { project: ProjectChoice; x: number; y: number; inPane?: boolean };
type Attention = "focus" | "parked" | "hidden" | null;
export function ProjectContextMenu({ target, local, onClose, onOpen, onAttention, onFolder }: {
  target: ProjectMenuTarget; local: boolean; onClose: () => void;
  onOpen: (repo: string, tab: "work" | "repository") => void;
  onAttention: (project: ProjectChoice, attention: Attention) => void;
  onFolder: (repo: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    dialog.showModal();
    const box = dialog.getBoundingClientRect();
    dialog.style.left = `${Math.max(8, Math.min(target.x, window.innerWidth - box.width - 8))}px`;
    dialog.style.top = `${Math.max(8, Math.min(target.y, window.innerHeight - box.height - 8))}px`;
    dialog.querySelector<HTMLButtonElement>("button")?.focus();
    return () => dialog.close();
  }, [target]);
  const run = (action: () => void) => { onClose(); action(); };
  const project = target.project;
  return <dialog ref={ref} className="project-menu" aria-label={`Actions for ${project.name}`} onCancel={onClose} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div role="menu" aria-label={`Project actions: ${project.name}`} onKeyDown={e => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
      e.preventDefault();
      const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      items[e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (index + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
    }}>
      <p>{project.name}</p>
      {!target.inPane && <><button role="menuitem" onClick={() => run(() => onOpen(project.id, "work"))}><PanelRightOpen size={16} />Open work pane</button>
      <button role="menuitem" onClick={() => run(() => onOpen(project.id, "repository"))}><FolderOpen size={16} />Repository tools &amp; notes</button>
      <hr /></>}
      <button role="menuitemcheckbox" aria-checked={project.attention === "focus" && !project.hidden} onClick={() => run(() => onAttention(project, project.attention === "focus" ? null : "focus"))}><Star size={16} />{project.attention === "focus" ? "Remove from Focus" : "Focus · important now"}</button>
      <button role="menuitemcheckbox" aria-checked={project.attention === "parked" && !project.hidden} onClick={() => run(() => onAttention(project, project.attention === "parked" ? null : "parked"))}><Pause size={16} />{project.attention === "parked" ? "Unpark · keep category" : "Park · relevant, but later"}</button>
      <button role="menuitem" onClick={() => run(() => onAttention(project, project.hidden ? null : "hidden"))}>{project.hidden ? <Eye size={16} /> : <EyeOff size={16} />}{project.hidden ? "Bring back onto map" : "Off the map · not relevant…"}</button>
      {local && project.sites.length > 0 && <><hr /><button role="menuitem" onClick={() => run(() => onFolder(project.id))}><FolderOpen size={16} />Open project folder</button></>}
    </div>
  </dialog>;
}

export function RepositoryPane({ machine, repo, view, onClose, onSelect, onChanged }: {
  machine: string; repo?: string; view?: string; onClose: () => void; onSelect: (repo: string) => void; onChanged: () => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const { theme, palette } = useTheme();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setReady(false); setError(""); }, [machine, repo, view]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== frame.current?.contentWindow || event.data?.source !== "atlas") return;
      if (event.data.type === "pane-ready") { setReady(true); frame.current?.contentWindow?.postMessage({ source: "hangar", type: "theme", night: theme === "dark", palette: mapPalette() }, window.location.origin); }
      if (event.data.type === "pane-select" && typeof event.data.repo === "string") onSelect(event.data.repo);
      if (event.data.type === "pane-changed") onChanged();
      if (event.data.type === "pane-close") onClose();
      if (event.data.type === "error") setError(String(event.data.message || "Repository tools are unavailable."));
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [theme, onSelect, onChanged, onClose]);
  useEffect(() => {
    if (!ready) return;
    // After the theme provider has applied the new palette to the document.
    const next = requestAnimationFrame(() => frame.current?.contentWindow?.postMessage({ source: "hangar", type: "theme", night: theme === "dark", palette: mapPalette() }, window.location.origin));
    return () => cancelAnimationFrame(next);
  }, [ready, theme, palette]);
  useEffect(() => { if (ready) return; const timer = setTimeout(() => setError("Repository tools did not load. Refresh Hangar and retry."), 20000); return () => clearTimeout(timer); }, [ready, machine, repo, view]);
  const query = new URLSearchParams({ embed: "hangar", pane: repo ? "repo" : "tools", ...(repo ? { repo } : { view: view || "changes" }), ...(machine !== "local" ? { remote: "1" } : {}) });
  return <div className="repository-pane">
    {!repo && <div className="repository-toolbar"><span>Changes · apps · folders · notes</span><button disabled={!ready} onClick={() => frame.current?.contentWindow?.postMessage({ source: "hangar", type: "rescan" }, window.location.origin)}>Rescan projects</button></div>}
    {!ready && <div className="repository-loading" role="status">{error || "Opening repository tools…"}{error && <button onClick={() => { setError(""); if (frame.current) frame.current.src = frame.current.src; }}>Retry</button>}</div>}
    <iframe ref={frame} title={repo ? "Repository tools and notes" : "Hangar project tools"} src={`/api/world/${machine}/view/index.html?${query}`} allow="clipboard-write" />
  </div>;
}

export function RemoveProjectDialog({ project, busy, error, onClose, onConfirm }: { project: ProjectChoice; busy: boolean; error: string; onClose: () => void; onConfirm: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const el = ref.current; el?.showModal(); return () => el?.close(); }, []);
  return <dialog ref={ref} className="remove-project-dialog" aria-labelledby="remove-project-title" onCancel={e => { if (busy) e.preventDefault(); else onClose(); }}>
    <button className="project-dialog-close" aria-label="Cancel removal" disabled={busy} onClick={onClose}><X size={18} /></button>
    <EyeOff size={30} /><h2 id="remove-project-title">Move {project.name} off the map?</h2>
    <p>It will leave the map and the normal project list. Its files, GitHub repository, plans and sessions stay intact.</p>
    <p>You can bring it back from <strong>Off the map</strong>. Its category and work status are preserved.</p>
    {error && <p role="alert">{error}</p>}
    <div><button disabled={busy} onClick={onClose}>Keep project</button><button className="cw-primary" disabled={busy} onClick={onConfirm}>{busy ? "Removing…" : "Remove from world"}</button></div>
  </dialog>;
}
