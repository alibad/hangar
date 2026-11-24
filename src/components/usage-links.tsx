"use client";

// AI usage joined to the rest of Hangar: each task is a session (its title, agent and projects) and each project shows
// its logo. Links open them where Hangar keeps them: a session in Sessions, a project in its pane.

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Combobox } from "@base-ui/react/combobox";
import { ArrowUpRight, Check, ChevronsUpDown, Folder, Layers, Search } from "lucide-react";
import AgentMark from "./agent-mark";
import { ProjectBadge, ProjectEmblem, projectDirectory, useProject, type ProjectInfo } from "./project-identity";
import type { LibrarySession, SessionLibraryData } from "./session-library";
import { openProject, openSessionInHangar } from "@/lib/project-nav";
import "./project-category.css";
import "./usage-view.css";

type Links = { projects: Map<string, ProjectInfo>; sessions: Map<string, LibrarySession> | null; sessionsError: string };
// Kept between visits to the page: the session list takes seconds to read.
let kept: { links: Links; at: number } | null = null;
const KEEP = 5 * 60_000;

/** The project map (logos, names) and the session list (titles, projects), read once per visit. */
export function useUsageLinks(): Links {
  const [links, setLinks] = useState<Links>(() => kept?.links ?? { projects: new Map(), sessions: null, sessionsError: "" });
  useEffect(() => {
    if (kept && Date.now() - kept.at < KEEP && kept.links.sessions) return;
    const controller = new AbortController();
    const read = async <T,>(path: string) => {
      const response = await fetch(`/api/world/local/proxy/${path}`, { cache: "no-store", signal: controller.signal });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : `HTTP ${response.status}`);
      return body as T;
    };
    read<Parameters<typeof projectDirectory>[0]>("atlas")
      .then(doc => setLinks(prev => ({ ...prev, projects: projectDirectory(doc, "local") })))
      .catch(() => { /* projects show as folders */ });
    read<SessionLibraryData>("sessions/library")
      .then(data => setLinks(prev => ({ ...prev, sessions: new Map(data.sessions.map(s => [s.key, s])), sessionsError: "" })))
      .catch(error => { if (!controller.signal.aborted) setLinks(prev => ({ ...prev, sessionsError: (error as Error).message })); });
    return () => controller.abort();
  }, []);
  useEffect(() => { if (links.sessions) kept = { links, at: Date.now() }; }, [links]);
  return links;
}

export const ago = (at: number) => {
  const days = Math.floor((Date.now() - at) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : days < 30 ? `${days}d ago` : new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

/** A project or a folder, as the usage page names it. */
export type UsageProject = { key: string; label: string; repo?: string; folders: string[]; holds?: number; touched: { id: string; name: string }[] };

/** The project's logo, or a folder mark for a folder of projects. */
export function ProjectMark({ project, size = 22 }: { project: Pick<UsageProject, "repo" | "label">; size?: number }) {
  if (project.repo) return <ProjectEmblem id={project.repo} name={project.label} size={size} />;
  return <span className="uv-folder" style={{ "--uv-size": `${size}px` } as CSSProperties} aria-hidden="true"><Folder size={Math.round(size * 0.55)} /></span>;
}

/** A project row: logo, name, and what it gathers (its island, the tasks, the folders it was worked in). */
export function ProjectCell({ project, tasks, share, onFocus }: { project: UsageProject; tasks: number; share: number; onFocus: () => void }) {
  const known = useProject(project.repo);
  const name = known?.name || project.label;
  const where = project.repo ? known?.island : project.holds ? `Folder of ${project.holds} projects` : "Folder";
  return <div className="uv-cell">
    <ProjectMark project={{ ...project, label: name }} size={30} />
    <span className="uv-cell-text">
      <button type="button" className="uv-name" title={`Show only ${name}: its tasks, days and models`} onClick={onFocus}>{name}</button>
      <small>
        {where && <span>{where}</span>}
        <span>{tasks} {tasks === 1 ? "task" : "tasks"}</span>
        {project.folders.length > 1 && <span title={project.folders.join("\n")}>{project.folders.length} folders</span>}
        {!project.repo && project.touched.length > 0 && <span className="uv-touched" title="Projects the tasks started here worked on">{project.touched.slice(0, 4).map(p => <ProjectEmblem key={p.id} id={p.id} name={p.name} size={16} />)}{project.touched.length > 4 && <i>+{project.touched.length - 4}</i>}</span>}
      </small>
      <ShareBar share={share} />
    </span>
    {project.repo && known && <button type="button" className="uv-go" title={`Open ${name} in Projects`} aria-label={`Open ${name} in Projects`} onClick={() => openProject(project.repo!)}><ArrowUpRight size={15} /></button>}
  </div>;
}

/** A task row: its agent, its session's title, the projects it worked on and when. */
export function TaskCell({ taskKey, session, projects, last, share, loading, onFocus }: {
  taskKey: string; session?: LibrarySession; projects: { id: string; name: string }[]; last: number; share: number; loading: boolean; onFocus: () => void;
}) {
  const [source, id] = splitTask(taskKey);
  const title = session?.title || (loading ? `${id.slice(0, 8)}…` : `${id.slice(0, 8)}… · not in the session list`);
  return <div className="uv-cell">
    <span className={`uv-agent is-${source}`}><AgentMark agent={source} /></span>
    <span className="uv-cell-text">
      <button type="button" className="uv-name" title={`${session?.title || id}\nShow only this task: its days and models`} onClick={onFocus}>{title}</button>
      <small>
        {projects.slice(0, 2).map(p => <ProjectBadge key={p.id} id={p.id} name={p.name} size="xs" />)}
        {projects.length > 2 && <span title={projects.slice(2).map(p => p.name).join(", ")}>+{projects.length - 2}</span>}
        <span>{ago(last)}</span>
        {session?.archived && <span>archived</span>}
      </small>
      <ShareBar share={share} />
    </span>
    {session && <button type="button" className="uv-go" title="Open this session in Sessions" aria-label={`Open “${session.title}” in Sessions`} onClick={() => openSessionInHangar(session.key)}><ArrowUpRight size={15} /></button>}
  </div>;
}

export const splitTask = (key: string): ["claude" | "codex", string] => {
  const at = key.indexOf(":");
  return [key.slice(0, at) === "codex" ? "codex" : "claude", key.slice(at + 1)];
};

export function ShareBar({ share }: { share: number }) {
  return <span className="uv-share" aria-hidden="true"><i style={{ width: `${Math.max(share > 0 ? 1 : 0, Math.min(100, share * 100))}%` }} /></span>;
}

/** The biggest projects as tiles, logo first: where the tokens went, at a glance. */
export function ProjectTiles({ projects, total, format, cost, onFocus }: {
  projects: { project: UsageProject; tokens: number; costText: string }[]; total: number; format: (n: number) => string; cost?: boolean; onFocus: (key: string) => void;
}) {
  return <div className="uv-tiles" role="list" aria-label="Biggest projects">
    {projects.map(({ project, tokens, costText }) => <TileItem key={project.key} project={project} share={total ? tokens / total : 0} value={cost ? costText : format(tokens)} sub={cost ? format(tokens) + " tokens" : costText} onFocus={() => onFocus(project.key)} />)}
  </div>;
}
function TileItem({ project, share, value, sub, onFocus }: { project: UsageProject; share: number; value: string; sub: string; onFocus: () => void }) {
  const known = useProject(project.repo);
  const name = known?.name || project.label;
  return <button type="button" role="listitem" className="uv-tile" onClick={onFocus} title={`Show only ${name}`}>
    <span className="uv-tile-top"><ProjectMark project={{ ...project, label: name }} size={34} /><b>{(share * 100).toFixed(share < 0.1 ? 1 : 0)}%</b></span>
    <span className="uv-tile-name">{name}</span>
    <span className="uv-tile-value">{value}<small>{sub}</small></span>
    <ShareBar share={share} />
  </button>;
}

/** What the page is narrowed to, with the way back out and the way into the rest of Hangar. */
export function TaskFocus({ taskKey, session, projects, onClear }: { taskKey: string; session?: LibrarySession; projects: { id: string; name: string }[]; onClear: () => void }) {
  const [source, id] = splitTask(taskKey);
  const [state, setState] = useState("");
  async function openInApp() {
    setState("Opening…");
    try {
      const response = await fetch("/api/world/local/proxy/sessions/resume", { method: "POST", cache: "no-store",
        headers: { "Content-Type": "application/json", "X-Hangar": "1" }, body: JSON.stringify({ provider: source, id }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      setState(body.where === "app" ? `Opened in the ${source === "codex" ? "Codex" : "Claude"} app.` : `Opened in a terminal with ${source === "codex" ? "codex resume" : "claude --resume"}.`);
    } catch (error) { setState((error as Error).message); }
  }
  return <div className="uv-focus" aria-label="Task shown">
    <span className={`uv-agent is-${source} is-large`}><AgentMark agent={source} /></span>
    <div className="uv-focus-text">
      <small>Task · {source === "codex" ? "Codex" : "Claude Code"}{session?.archived ? " · archived" : ""}</small>
      <h3 title={id}>{session?.title || id}</h3>
      {projects.length > 0 && <p className="uv-focus-projects">{projects.slice(0, 6).map(p => <ProjectBadge key={p.id} id={p.id} name={p.name} size="xs" link />)}{projects.length > 6 && <span>+{projects.length - 6}</span>}</p>}
      {state && <p className="uv-focus-state" role="status">{state}</p>}
    </div>
    <div className="uv-focus-actions">
      {session && <button type="button" className="is-primary" onClick={() => openSessionInHangar(session.key)}>Open in Sessions<ArrowUpRight size={14} /></button>}
      {session?.canResume && <button type="button" onClick={() => void openInApp()}>Open in {source === "codex" ? "Codex" : "Claude"}</button>}
      <button type="button" onClick={onClear}>All tasks</button>
    </div>
  </div>;
}

export function ProjectFocus({ project, onClear }: { project: UsageProject; onClear: () => void }) {
  const known = useProject(project.repo);
  const name = known?.name || project.label;
  return <div className="uv-focus" aria-label="Project shown">
    <ProjectMark project={{ ...project, label: name }} size={44} />
    <div className="uv-focus-text">
      <small>{project.repo ? ["Project", known?.island].filter(Boolean).join(" · ") : project.holds ? `Folder of ${project.holds} projects` : "Folder"}</small>
      <h3 title={project.folders.join("\n")}>{name}</h3>
      {project.repo ? known?.purpose && <p>{known.purpose}</p> : <p className="uv-focus-projects">{project.touched.length ? <>Its tasks worked on {project.touched.slice(0, 6).map(p => <ProjectBadge key={p.id} id={p.id} name={p.name} size="xs" link />)}{project.touched.length > 6 && <span>+{project.touched.length - 6}</span>}</> : project.folders[0]}</p>}
      {project.folders.length > 1 && <p className="uv-focus-folders">Worked in {project.folders.length} folders: {project.folders.map(f => f.split("/").slice(-2).join("/")).join(", ")}</p>}
    </div>
    <div className="uv-focus-actions">
      {project.repo && known && <button type="button" className="is-primary" onClick={() => openProject(project.repo!)}>Open project<ArrowUpRight size={14} /></button>}
      <button type="button" onClick={onClear}>All projects</button>
    </div>
  </div>;
}

/** Searchable, with each project's logo, as every long list in Hangar is. */
export function ProjectPicker({ choices, value, format, onChange }: { choices: (UsageProject & { tokens: number })[]; value: string; format: (n: number) => string; onChange: (key: string) => void }) {
  type Choice = UsageProject & { tokens: number };
  const all = useMemo<Choice>(() => ({ key: "", label: "All projects", folders: [], touched: [], tokens: 0 }), []);
  const items = useMemo(() => [all, ...choices], [all, choices]);
  const current = items.find(c => c.key === value) ?? all;
  const [open, setOpen] = useState(false), [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  return <Combobox.Root<Choice> items={items} value={current} itemToStringLabel={c => c.label} isItemEqualToValue={(a, b) => a.key === b.key}
    open={open} onOpenChange={next => { setOpen(next); if (next) setQuery(""); }} inputValue={query} onInputValueChange={setQuery}
    onValueChange={c => { if (c) onChange(c.key); }}>
    <Combobox.Trigger className="uv-picker" aria-label={`Project filter: ${current.label}`}>
      {current.key ? <ProjectMark project={current} size={18} /> : <Layers size={15} aria-hidden="true" />}<span>{current.label}</span><ChevronsUpDown size={14} aria-hidden="true" />
    </Combobox.Trigger>
    <Combobox.Portal><Combobox.Positioner side="bottom" align="start" sideOffset={6} collisionPadding={12} className="pc-positioner"><Combobox.Popup className="pc-popup uv-picker-popup" initialFocus={search}>
      <div className="pc-search"><Search size={16} /><Combobox.Input ref={search} placeholder="Find a project or folder…" aria-label="Search projects" /></div>
      <Combobox.Empty className="pc-empty">No matching projects.</Combobox.Empty>
      <Combobox.List className="pc-list">{(c: Choice) => <Combobox.Item key={c.key || "all"} value={c} className="uv-option">
        {c.key ? <ProjectMark project={c} size={22} /> : <span className="uv-folder" style={{ "--uv-size": "22px" } as CSSProperties} aria-hidden="true"><Layers size={12} /></span>}
        <span className="uv-option-text">{c.label}{c.key && !c.repo && <small>{c.holds ? `Folder of ${c.holds} projects` : "Folder"}</small>}</span>
        {c.key && <small>{format(c.tokens)}</small>}
        <Combobox.ItemIndicator><Check size={15} /></Combobox.ItemIndicator>
      </Combobox.Item>}</Combobox.List>
    </Combobox.Popup></Combobox.Positioner></Combobox.Portal>
  </Combobox.Root>;
}
