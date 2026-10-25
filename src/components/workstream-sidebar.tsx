"use client";

import { useEffect, useState } from "react";
import { AudioLines, Mic, Music, ScanLine, Layers, ChevronDown, Globe2, Image, MessageSquare, Workflow, Server, Network, Gauge, Menu, X, Video, Clapperboard, Flame, Box, Scissors, Terminal, Swords, Scale, GitBranch, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { ENGINE_ROOM_LINKS, PRIMARY_LINKS, WORKSTREAMS, workstreamFor, type WorkstreamLink } from "@/lib/workstreams";
import { hostHasTab } from "@/lib/host";
import type { ConsoleTab } from "@/lib/labs";

const icons = { audio: AudioLines, visual: Image, text: MessageSquare, process: Workflow };
const primaryIcons = { projects: Layers, sessions: Terminal, models: Network, machines: Server };

export function useSidebarState() {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => { try { setCollapsed(localStorage.getItem("hangar-sidebar-collapsed") === "true"); } catch { /* Storage can be unavailable. */ } }, []);
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try { localStorage.setItem("hangar-sidebar-collapsed", String(next)); } catch { /* Keep navigation usable without storage. */ }
  };
  return { collapsed, toggle };
}

const toolIcons = { "lab-audio": AudioLines, voices: Mic, "speech-recognition": ScanLine, "lab-music": Music, qwen: Image, video: Video, "lab-video": Clapperboard, "lab-forge": Flame, sam3: Scissors, "lab-3d": Box, llm: Terminal, arena: Swords, "lab-decide": Scale, "lab-process": GitBranch };

export default function WorkstreamSidebar({ active, onSelect, speechMode, collapsed, onToggle }: { active: ConsoleTab; onSelect: (tab: ConsoleTab) => void; speechMode: "tts" | "stt"; collapsed: boolean; onToggle: () => void }) {
  const selected = active === "speech" ? speechMode === "tts" ? "voices" : "speech-recognition" : active;
  const currentGroup = workstreamFor(active)?.id;
  const [expanded, setExpanded] = useState<string[]>([]);
  const [mobileOpen, setMobileOpen] = useState(false);
  useEffect(() => { if (currentGroup) setExpanded(e => e.includes(currentGroup) ? e : [...e, currentGroup]); }, [currentGroup]);
  useEffect(() => { const close = (e: KeyboardEvent) => { if (e.key === "Escape") setMobileOpen(false); }; window.addEventListener("keydown", close); return () => window.removeEventListener("keydown", close); }, []);
  const go = (id: ConsoleTab) => { onSelect(id); setMobileOpen(false); };
  const link = (item: WorkstreamLink) => {
    const ChildIcon = toolIcons[item.id as keyof typeof toolIcons] ?? Layers;
    const available = item.id.startsWith("lab-") || hostHasTab(item.id);
    return <button key={item.id} type="button" onClick={() => go(item.id)} aria-label={`${item.label}${available ? "" : " · Not on this machine"}`} aria-current={selected === item.id ? "page" : undefined} className="hangar-nav-child" title={`${item.label} — ${item.hint}${available ? "" : " · Not on this machine"}`}>
      <ChildIcon size={16} /><span>{item.label}</span>{!available && <small>Not on this machine</small>}
    </button>;
  };
  return <>
    <button type="button" className="hangar-mobile-nav" aria-label={mobileOpen ? "Close navigation" : "Open navigation"} aria-expanded={mobileOpen} aria-controls="hangar-sidebar" onClick={() => setMobileOpen(v => !v)}>{mobileOpen ? <X size={20} /> : <Menu size={20} />}</button>
    {mobileOpen && <button type="button" className="hangar-nav-backdrop" aria-label="Close navigation" onClick={() => setMobileOpen(false)} />}
    <aside id="hangar-sidebar" className={`hangar-sidebar${mobileOpen ? " is-open" : ""}${collapsed ? " is-collapsed" : ""}`} aria-label="Workstreams">
      <nav aria-label="Primary navigation">
        <div className="hangar-nav-home">
          <button type="button" className="hangar-nav-group" aria-label="World" title="World" aria-current={active === "world" ? "page" : undefined} onClick={() => go("world")}><Globe2 size={19} /><span>World</span></button>
          <button type="button" className="hangar-sidebar-toggle" onClick={onToggle} aria-controls="hangar-sidebar" aria-expanded={!collapsed} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} title={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
            {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </button>
        </div>
        <button type="button" className="hangar-nav-group" aria-label="Engine room" title="Engine room — your local AI: services, models, requests and usage" aria-current={ENGINE_ROOM_LINKS.some(item => item.id === active) ? "page" : undefined} onClick={() => go("stack")}><Gauge size={19} /><span>Engine room</span></button>
        {PRIMARY_LINKS.filter(item => item.id !== "world").map(({ id, label }) => { const Icon = primaryIcons[id as keyof typeof primaryIcons]; return <button key={id} className="hangar-nav-group" title={label} aria-label={label} aria-current={active === id ? "page" : undefined} onClick={() => go(id)}><Icon size={19} /><span>{label}</span></button>; })}
        <span className="hangar-nav-label">STUDIOS</span>
        {WORKSTREAMS.map(group => { const Icon = icons[group.id as keyof typeof icons]; const open = expanded.includes(group.id); return <section className="hangar-nav-section" key={group.id}>
          <button type="button" className={`hangar-nav-group${currentGroup === group.id ? " is-current" : ""}`} aria-label={group.label} title={group.label} aria-expanded={open} aria-controls={`nav-${group.id}`} onClick={() => setExpanded(e => open ? e.filter(id => id !== group.id) : [...e, group.id])}><Icon size={19} /><span>{group.label}</span><ChevronDown size={14} className={open ? "is-open" : ""} /></button>
          <div id={`nav-${group.id}`} className={`hangar-nav-children${open ? " is-group-open" : ""}`}>{group.links.map(link)}</div>
        </section>; })}
      </nav>
    </aside>
  </>;
}
