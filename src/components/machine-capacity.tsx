"use client";

import { useEffect, useRef, useState } from "react";
import { Cpu, ChevronDown } from "lucide-react";
import ResourcePulse, { type GpuSnapshot, type ResourceSnapshot } from "./resource-pulse";

export default function MachineCapacity({ gpu, resources, onOpenDetails }: { gpu: GpuSnapshot | null; resources: ResourceSnapshot | null; onOpenDetails: () => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
  const loading = !gpu && !resources;
  const unavailable = !loading && (!gpu || Boolean(gpu.error));
  const vramTotal = gpu?.mem_total ? gpu.mem_total / 1024 : resources?.capacity.vram.totalGb;
  const vramUsed = gpu?.mem_used != null ? gpu.mem_used / 1024 : vramTotal != null && resources ? vramTotal - resources.capacity.vram.freeGb : undefined;
  const ramTotal = gpu?.host_ram?.total_gb ?? resources?.capacity.ram.totalGb;
  const ramUsed = gpu?.host_ram?.used_gb ?? (ramTotal != null && resources ? ramTotal - resources.capacity.ram.freeGb : undefined);
  const percent = (used: number | undefined, total: number | undefined) => !loading && used != null && total ? `${Math.min(100, Math.max(0, used / total * 100)).toFixed(0)}%` : "—";
  return <div className="machine-capacity" ref={root}>
    <button ref={trigger} type="button" className="machine-capacity-trigger" onClick={() => setOpen(value => !value)} aria-expanded={open} aria-controls="machine-capacity-panel" aria-label={`Machine capacity${loading ? ": loading" : unavailable ? ": telemetry unavailable" : ""}. Open live GPU and RAM details`} title="Live machine capacity">
      <Cpu size={16} />
      <span className="machine-capacity-readings">{gpu?.memory_model !== "unified" && <span>GPU <strong>{percent(vramUsed, vramTotal)}</strong></span>}<span>RAM <strong>{percent(ramUsed, ramTotal)}</strong></span></span>
      <ChevronDown size={12} />
    </button>
    {open && <section id="machine-capacity-panel" className="machine-capacity-panel" aria-label="Live machine capacity details">
      <header><strong>Machine capacity</strong><span>{loading ? "Reading telemetry…" : unavailable ? "Telemetry unavailable · last available readings" : "Live readings"}</span></header>
      <ResourcePulse gpu={gpu} resources={resources} onOpenDetails={() => { setOpen(false); onOpenDetails(); }} />
      <p>Open the Resource Map for resident workloads, memory budgets and queue details.</p>
    </section>}
  </div>;
}
