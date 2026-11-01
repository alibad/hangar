"use client";

import { createContext, useContext, useState, type CSSProperties, type ReactNode } from "react";
import "./project-identity.css";

/** One way to show a project wherever Hangar mentions it: its logo, its name and, where there is room, one line on what
 *  it is for. The workspace fills the directory from the world document; views only pass an id and the name they have. */
export type ProjectInfo = { id: string; name: string; logo?: string; purpose?: string; island?: string };
type Directory = { projects: Map<string, ProjectInfo>; open?: (id: string) => void };
const ProjectDirectory = createContext<Directory>({ projects: new Map() });

export function ProjectDirectoryProvider({ projects, open, children }: { projects: Map<string, ProjectInfo>; open?: (id: string) => void; children: ReactNode }) {
  return <ProjectDirectory.Provider value={{ projects, open }}>{children}</ProjectDirectory.Provider>;
}
export const useProject = (id?: string | null) => useContext(ProjectDirectory).projects.get(id || "");
export const useOpenProject = () => useContext(ProjectDirectory).open;

/** The project's own logo when it has one, otherwise its first letters on a tile. */
export function ProjectEmblem({ id, name, logo, size = 32 }: { id?: string | null; name: string; logo?: string; size?: number }) {
  const known = useProject(id);
  const source = logo ?? known?.logo ?? "";
  const [failed, setFailed] = useState("");
  return <span className="project-emblem" style={{ "--pe-size": `${size}px` } as CSSProperties} aria-hidden="true">
    {source && failed !== source ? <img src={source} alt="" loading="lazy" width={size} height={size} onError={() => setFailed(source)} /> : (known?.name || name).slice(0, 2).toUpperCase()}
  </span>;
}

/** Logo and name, with one line on what the project is for when `detail` is set. A link to the project only when
 *  asked (`link`) and the workspace can open it; inside another button it stays plain. */
export function ProjectBadge({ id, name, detail = false, size = "sm", link = false, children }: { id?: string | null; name: string; detail?: boolean; size?: "xs" | "sm" | "md"; link?: boolean; children?: ReactNode }) {
  const known = useProject(id), open = useOpenProject();
  const label = known?.name || name;
  const line = detail ? known?.purpose || known?.island || "" : "";
  const body = <><ProjectEmblem id={id} name={label} size={{ xs: 16, sm: 22, md: 30 }[size]} /><span className="pb-text"><b>{label}</b>{line && <small title={line}>{line}</small>}</span>{children}</>;
  if (link && open && known) return <button type="button" className={`project-badge is-${size} is-link`} title={`Open ${label}`} onClick={event => { event.stopPropagation(); open(known.id); }}>{body}</button>;
  return <span className={`project-badge is-${size}`} title={detail ? undefined : known?.purpose || undefined}>{body}</span>;
}

/** Several projects in a line of small text: the first few with their marks, then how many more. */
export function ProjectList({ projects, max = 2, empty = "No project" }: { projects: { id: string; name: string }[]; max?: number; empty?: string }) {
  if (!projects.length) return <span className="project-list is-empty">{empty}</span>;
  return <span className="project-list">{projects.slice(0, max).map(p => <ProjectBadge key={p.id} id={p.id} name={p.name} size="xs" />)}{projects.length > max && <span className="pl-more">+{projects.length - max}</span>}</span>;
}
