"use client";
import { ENGINE_ROOM_LINKS } from "@/lib/workstreams";
import type { ConsoleTab } from "@/lib/labs";

/** The Engine room's pages share one strip, so the system pages read as parts of one place. */
export default function EngineRoomTabs({ active, onSelect }: { active: ConsoleTab; onSelect: (tab: ConsoleTab) => void }) {
  return <nav className="engine-room-tabs" aria-label="Engine room">
    {ENGINE_ROOM_LINKS.map(item => <button key={item.id} type="button" title={item.hint} aria-current={active === item.id ? "page" : undefined} onClick={() => onSelect(item.id)}>{item.label}</button>)}
  </nav>;
}
