"use client";

import { useEffect, useState } from "react";
import { ArrowRight, ChevronDown, MapPin } from "lucide-react";
import AgentMark from "./agent-mark";
import { ProjectEmblem } from "./project-identity";
import type { IslandSuggestion, SignalSession, TurnKind, YourTurn as Turn } from "@/lib/project-signals";
import "./your-turn.css";

const KINDS: { id: TurnKind; label: string; hint: string }[] = [
  { id: "ask", label: "Asks you", hint: "Sessions that stopped to ask you something" },
  { id: "review", label: "To review", hint: "Sessions with work ready for your review" },
  { id: "push", label: "Not on GitHub", hint: "Projects with commits only on this machine" },
  { id: "unread", label: "Unread", hint: "Replies you haven't opened" },
];
const SHOWN = 4;
const KEY = "hangar-your-turn";

export function ago(value: string) {
  const t = Date.parse(value);
  if (!t) return "";
  const min = Math.max(0, Math.floor((Date.now() - t) / 60000));
  return min < 60 ? `${Math.max(1, min)}m` : min < 1440 ? `${Math.floor(min / 60)}h` : `${Math.floor(min / 1440)}d`;
}

/** One list of everything waiting on you, across every session and project, each with its ask in a line and a way in. */
export default function YourTurn({ turn, onSession, onProject }: {
  turn: Turn; onSession?: (s: SignalSession) => void; onProject: (id: string, tab?: "work" | "repository") => void;
}) {
  const [open, setOpen] = useState(true), [kind, setKind] = useState<TurnKind | null>(null), [all, setAll] = useState(false);
  useEffect(() => {
    try { const saved = JSON.parse(localStorage.getItem(KEY) || "null"); if (saved) { setOpen(saved.open !== false); if (KINDS.some(k => k.id === saved.kind)) setKind(saved.kind); } } catch { /* defaults */ }
  }, []);
  const remember = (next: { open?: boolean; kind?: TurnKind }) => { try { localStorage.setItem(KEY, JSON.stringify({ open, kind, ...next })); } catch { /* kept for this visit */ } };
  const total = KINDS.reduce((n, k) => n + turn[k.id].length, 0);
  if (!total) return null;
  // The kind you picked, while it has anything; otherwise the most pressing kind that does.
  const current = kind && turn[kind].length ? kind : KINDS.find(k => turn[k.id].length)!.id;
  const items = turn[current], rows = all ? items : items.slice(0, SHOWN);
  return <section className="yt" aria-label="Your turn">
    <div className="yt-head">
      <button className="yt-toggle" aria-expanded={open} onClick={() => { setOpen(!open); remember({ open: !open }); }}><b>Your turn</b><small>{total}</small><ChevronDown size={15} aria-hidden="true" /></button>
      {open && <div className="yt-kinds" role="group" aria-label="What is waiting">{KINDS.filter(k => turn[k.id].length).map(k => <button key={k.id} title={k.hint} aria-pressed={current === k.id} className={`is-${k.id}`} onClick={() => { setKind(k.id); setAll(false); remember({ kind: k.id }); }}><i aria-hidden="true" />{k.label}<small>{turn[k.id].length}</small></button>)}</div>}
    </div>
    {open && <ul className="yt-list">{rows.map(item => {
      const project = item.project;
      const go = item.kind === "push" ? () => onProject(project!.id, "repository") : item.session && onSession ? () => onSession(item.session!) : project ? () => onProject(project.id) : undefined;
      return <li key={item.key} className={`is-${item.kind}`}>
        {project ? <button className="yt-project" title={`Open ${project.name}`} onClick={() => onProject(project.id)}><ProjectEmblem id={project.id} name={project.name} size={22} /><span>{project.name}</span></button>
          : <span className="yt-project is-none"><AgentMark agent={item.session?.provider || "claude"} /><span>No project</span></span>}
        <span className="yt-text" title={item.text}>{item.text}</span>
        {item.at && <small className="yt-age" title={new Date(item.at).toLocaleString()}>{ago(item.at)}</small>}
        {go && <button className="cw-pill yt-open" onClick={go} title={item.kind === "push" ? "Open its changes" : item.session ? `Open in ${item.session.provider === "codex" ? "Codex" : "Claude"}` : "Open the project"}>Open<ArrowRight size={13} /></button>}
      </li>;
    })}</ul>}
    {open && items.length > SHOWN && <button className="cw-text-button yt-more" onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${items.length}`}</button>}
  </section>;
}

/** Unsorted projects, grouped by the island their folder suggests: untick one to leave it, then move the rest at once. */
export function IslandSuggestions({ groups, names, busy, onMove }: {
  groups: IslandSuggestion[]; names: Map<string, string>; busy: boolean; onMove: (island: string, repos: string[]) => void;
}) {
  const [skip, setSkip] = useState<Set<string>>(new Set());
  if (!groups.length) return null;
  const count = groups.reduce((n, g) => n + g.repos.length, 0);
  const toggle = (id: string) => setSkip(current => { const next = new Set(current); if (!next.delete(id)) next.add(id); return next; });
  return <section className="isg" aria-label="Suggested islands">
    <p className="isg-head"><MapPin size={15} aria-hidden="true" /><b>Hangar can place {count} of these</b><small>from the folder each one sits in</small></p>
    {groups.map(g => {
      const chosen = g.repos.filter(id => !skip.has(id));
      return <div className="isg-group" key={`${g.island}|${g.root}|${g.folder}`}>
        <span className="isg-island"><b>{g.name}</b><small>{g.agree} of {g.sorted} sorted projects in {g.folder || "the top folder"}</small></span>
        <span className="isg-chips">{g.repos.map(id => <button key={id} aria-pressed={!skip.has(id)} title={skip.has(id) ? "Leave it unsorted" : `Moves to ${g.name}`} onClick={() => toggle(id)}><ProjectEmblem id={id} name={names.get(id) || id} size={16} />{names.get(id) || id}</button>)}</span>
        <button className="cw-pill isg-move" disabled={busy || !chosen.length} onClick={() => onMove(g.island, chosen)}>Move {chosen.length}<ArrowRight size={13} /></button>
      </div>;
    })}
  </section>;
}
