"use client";

import { useEffect, useState } from "react";
import { AudioLines, Mic, Music, ScanLine, Layers, ChevronDown, Home, Image, MessageSquare, Workflow, Server, Network, Activity, Gauge, HardDrive, Menu, X, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { WORKSTREAMS, SYSTEM_LINKS, workstreamFor, type WorkstreamLink } from "@/lib/workstreams";
import { hostHasTab } from "@/lib/host";
import type { ConsoleTab } from "@/lib/labs";

const icons = { audio: AudioLines, visual: Image, text: MessageSquare, process: Workflow };
const systemIcons = { services: Server, models: Network, requests: Activity, usage: Gauge, storage: HardDrive };

export default function WorkstreamSidebar({ active, onSelect, speechMode }: { active: ConsoleTab; onSelect: (tab: ConsoleTab) => void; speechMode: "tts" | "stt" }) {
  const selected = active === "speech" ? speechMode === "tts" ? "voices" : "speech-recognition" : active;
  const currentGroup = workstreamFor(active)?.id;
  const [expanded, setExpanded] = useState<string[]>(["audio"]);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => { try { setCollapsed(localStorage.getItem("hangar-sidebar-collapsed") === "true"); } catch { /* Storage can be unavailable. */ } }, []);
  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    try { localStorage.setItem("hangar-sidebar-collapsed", String(next)); } catch { /* Keep the control usable without storage. */ }
  };
  useEffect(() => { if (currentGroup) setExpanded(e => e.includes(currentGroup) ? e : [...e, currentGroup]); }, [currentGroup]);
  useEffect(() => { const close = (e: KeyboardEvent) => { if (e.key === "Escape") setMobileOpen(false); }; window.addEventListener("keydown", close); return () => window.removeEventListener("keydown", close); }, []);
  const go = (id: ConsoleTab) => { onSelect(id); setMobileOpen(false); };
  const link = (item: WorkstreamLink) => {
    const ChildIcon = item.id === "lab-audio" ? AudioLines : item.id === "voices" ? Mic : item.id === "speech-recognition" ? ScanLine : item.id === "lab-music" ? Music : Layers;
    const available = item.id.startsWith("lab-") || hostHasTab(item.id);
    return <button key={item.id} type="button" onClick={() => go(item.id)} aria-label={`${item.label}${available ? "" : " · Not on this machine"}`} aria-current={selected === item.id ? "page" : undefined} className="hangar-nav-child" title={`${item.label} — ${item.hint}${available ? "" : " · Not on this machine"}`}>
      <ChildIcon size={16} /><span>{item.label}</span>{!available && <small>Not on this machine</small>}
    </button>;
  };
  return <>
    <button type="button" className="hangar-mobile-nav" aria-label={mobileOpen ? "Close navigation" : "Open navigation"} aria-expanded={mobileOpen} aria-controls="hangar-sidebar" onClick={() => setMobileOpen(v => !v)}>{mobileOpen ? <X size={20} /> : <Menu size={20} />}</button>
    {mobileOpen && <button type="button" className="hangar-nav-backdrop" aria-label="Close navigation" onClick={() => setMobileOpen(false)} />}
    <aside id="hangar-sidebar" className={`hangar-sidebar${mobileOpen ? " is-open" : ""}${collapsed ? " is-collapsed" : ""}`} aria-label="Workstreams">
      <button type="button" className="hangar-sidebar-toggle hangar-nav-group" onClick={toggleCollapsed} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} title={collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-expanded={!collapsed}>
        {collapsed ? <PanelLeftOpen size={19} /> : <PanelLeftClose size={19} />}<span>Collapse sidebar</span>
      </button>
      <nav aria-label="Primary navigation">
        <button type="button" className="hangar-nav-group" aria-label="Home" title="Home" aria-current={active === "stack" ? "page" : undefined} onClick={() => go("stack")}><Home size={19} /><span>Home</span></button>
        {WORKSTREAMS.map(group => { const Icon = icons[group.id as keyof typeof icons]; const open = expanded.includes(group.id); return <section key={group.id}>
          <button type="button" className={`hangar-nav-group${currentGroup === group.id ? " is-current" : ""}`} aria-label={group.label} title={group.label} aria-expanded={open} aria-controls={`nav-${group.id}`} onClick={() => setExpanded(e => open ? e.filter(id => id !== group.id) : [...e, group.id])}><Icon size={19} /><span>{group.label}</span><ChevronDown size={14} className={open ? "is-open" : ""} /></button>
          <div id={`nav-${group.id}`} hidden={!open} className="hangar-nav-children">{group.links.map(link)}</div>
        </section>; })}
      </nav>
      <nav className="hangar-system-nav" aria-label="System and insights">{SYSTEM_LINKS.map(item => { const Icon = systemIcons[item.id as keyof typeof systemIcons]; return <button key={item.id} type="button" className="hangar-nav-group" aria-label={item.label} title={item.label} aria-current={active === item.id ? "page" : undefined} onClick={() => go(item.id)}><Icon size={18} /><span>{item.label}</span></button>; })}</nav>
    </aside>
  </>;
}
