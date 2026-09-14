"use client";

import Image from "next/image";
import { useEffect, useRef } from "react";
import { CaretDown, Moon, Sun } from "@phosphor-icons/react";
import { Activity, Gauge, HardDrive, Home, Network, RefreshCw } from "lucide-react";
import { CommandPalette, type ConsoleTab } from "@/components/command-palette";
import { ThemePicker } from "@/components/theme-picker";
import { useTheme } from "@/components/theme-provider";

type Props = {
  active: ConsoleTab;
  onSelect: (tab: ConsoleTab) => void;
  overallStatus: "operational" | "degraded" | "down";
  readyServices: number;
  onDemandServices: number;
  attentionServices: number;
  refreshing: boolean;
  onRefresh: () => void;
  autoRefresh: boolean;
  onAutoRefresh: (value: boolean) => void;
};

const workstreams: Array<{ id: ConsoleTab; label: string; hint: string }> = [
  { id: "llm", label: "Chat & Code", hint: "Local text models" },
  // Directly under Chat & Code: it answers the question that tab provokes —
  // "is this model the right one?" — rather than being a separate kind of work.
  { id: "arena", label: "Arena", hint: "Compare models on one prompt" },
  { id: "qwen", label: "Image Studio", hint: "Generate and edit" },
  { id: "speech", label: "Speech", hint: "Transcribe and synthesize" },
  { id: "sam3d", label: "3D Body", hint: "Human mesh and pose" },
  { id: "sam3", label: "Segment", hint: "Open-vocabulary masks" },
];

// What is flowing through the stack, and what it costs.
const insights: Array<{ id: ConsoleTab; label: string; hint: string }> = [
  { id: "requests", label: "Requests", hint: "Live traffic and failures" },
  { id: "usage", label: "AI Usage", hint: "Router, providers and cost" },
  { id: "storage", label: "Storage", hint: "Drive space, files and changes" },
];

export default function ConsoleHeader({
  active,
  onSelect,
  overallStatus,
  readyServices,
  onDemandServices,
  attentionServices,
  refreshing,
  onRefresh,
  autoRefresh,
  onAutoRefresh,
}: Props) {
  const { theme, toggle } = useTheme();
  const workstreamsMenuRef = useRef<HTMLDetailsElement>(null);
  const insightsMenuRef = useRef<HTMLDetailsElement>(null);
  const workstreamActive = workstreams.some((item) => item.id === active);
  const insightsActive = insights.some((item) => item.id === active);

  useEffect(() => {
    const menus = [workstreamsMenuRef, insightsMenuRef];
    const closeAll = () => menus.forEach((ref) => ref.current?.removeAttribute("open"));
    const handlePointerDown = (event: PointerEvent) => {
      for (const ref of menus) {
        if (!ref.current?.contains(event.target as Node)) ref.current?.removeAttribute("open");
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const open = menus.find((ref) => ref.current?.open);
      if (!open) return;
      closeAll();
      open.current?.querySelector("summary")?.focus();
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  const selectWorkstream = (tab: ConsoleTab) => {
    workstreamsMenuRef.current?.removeAttribute("open");
    onSelect(tab);
  };

  const selectInsight = (tab: ConsoleTab) => {
    insightsMenuRef.current?.removeAttribute("open");
    onSelect(tab);
  };

  return (
    <>
    <header className="console-header sticky top-0 z-30 border-b border-gray-800 bg-gray-950/90 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-[1500px] items-center gap-3 px-4 sm:px-6">
        <button type="button" onClick={() => onSelect("stack")} className="flex h-11 shrink-0 items-center gap-2.5 md:h-auto" aria-label="Open BeTenshi Home">
          <Image src="/icons/icon.svg" alt="" width={24} height={24} priority className="h-6 w-6" />
          <span className="text-lg font-semibold tracking-[-0.02em] text-gray-100">BeTenshi</span>
        </button>

        <nav className="ml-2 hidden h-full items-center gap-1 md:flex" aria-label="Primary navigation">
          <NavButton active={active === "stack"} onClick={() => onSelect("stack")}>Home</NavButton>
          <details ref={workstreamsMenuRef} className="group relative h-full">
            <summary className={`flex h-full cursor-pointer list-none items-center gap-1 px-3 text-sm font-medium transition ${workstreamActive ? "text-orange-300" : "text-gray-500 hover:text-gray-200"}`}>
              Workstreams
              <CaretDown size={11} className="transition group-open:rotate-180" />
            </summary>
            <div className="absolute left-0 top-[54px] w-56 overflow-hidden rounded-xl border border-gray-700 bg-gray-950 p-1.5 shadow-2xl">
              {workstreams.map((item) => (
                <button key={item.id} type="button" onClick={() => selectWorkstream(item.id)} className="block w-full rounded-lg px-3 py-2 text-left transition hover:bg-gray-800">
                  <span className="block text-xs font-medium text-gray-200">{item.label}</span>
                  <span className="block text-[10px] text-gray-600">{item.hint}</span>
                </button>
              ))}
            </div>
          </details>
          <NavButton active={active === "services"} onClick={() => onSelect("services")}>Services</NavButton>
          <NavButton active={active === "models"} onClick={() => onSelect("models")}>Models</NavButton>
          <details ref={insightsMenuRef} className="group relative h-full">
            <summary className={`flex h-full cursor-pointer list-none items-center gap-1 px-3 text-sm font-medium transition ${insightsActive ? "text-orange-300" : "text-gray-500 hover:text-gray-200"}`}>
              Insights
              <CaretDown size={11} className="transition group-open:rotate-180" />
            </summary>
            <div className="absolute left-0 top-[54px] w-56 overflow-hidden rounded-xl border border-gray-700 bg-gray-950 p-1.5 shadow-2xl">
              {insights.map((item) => (
                <button key={item.id} type="button" onClick={() => selectInsight(item.id)} className="block w-full rounded-lg px-3 py-2 text-left transition hover:bg-gray-800">
                  <span className="block text-xs font-medium text-gray-200">{item.label}</span>
                  <span className="block text-[10px] text-gray-600">{item.hint}</span>
                </button>
              ))}
            </div>
          </details>
        </nav>

        <div className="ml-auto flex min-w-0 items-center gap-2">
          <CommandPalette active={active} onSelect={onSelect} />
          <button type="button" onClick={onRefresh} disabled={refreshing} aria-label={refreshing ? "Refreshing console" : "Refresh console"} className="flex h-11 w-11 items-center justify-center rounded-lg border border-gray-800 text-gray-500 transition hover:border-gray-600 hover:text-gray-100 disabled:opacity-50 md:h-9 md:w-9">
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
          </button>
          <button
            type="button"
            onClick={() => onSelect("services")}
            aria-label={`Service status: ${readyServices} ready now, ${onDemandServices} on demand, ${attentionServices} need attention`}
            className="hidden h-10 items-center gap-2 rounded-lg border border-gray-800 bg-gray-900/55 px-3 lg:flex"
          >
            <span className={`h-2 w-2 rounded-full ${overallStatus === "operational" ? "bg-emerald-400" : overallStatus === "degraded" ? "bg-amber-400" : "bg-red-400"}`} />
            <span className="leading-tight">
              <span className="block text-xs font-medium text-gray-200">{attentionServices ? `${attentionServices} need attention` : `${readyServices} ready now`}</span>
              <span className="block text-[9px] text-gray-600">{onDemandServices} on demand</span>
            </span>
          </button>
          <label className="hidden h-9 cursor-pointer items-center gap-1.5 rounded-lg border border-gray-800 px-2 text-[10px] text-gray-500 xl:flex" title="Automatically refresh console data every 15 seconds">
            <input type="checkbox" role="switch" aria-label="Automatically refresh console every 15 seconds" checked={autoRefresh} onChange={(event) => onAutoRefresh(event.target.checked)} className="accent-orange-500" />
            Live
          </label>
          <button type="button" onClick={toggle} title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"} aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"} className="flex h-11 w-11 items-center justify-center rounded-lg border border-gray-800 text-gray-500 transition hover:border-gray-600 hover:text-gray-100 md:h-9 md:w-9">
            {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
          </button>
          <ThemePicker />
        </div>
      </div>
    </header>
    <nav className="fixed inset-x-3 bottom-3 z-40 grid grid-cols-5 rounded-2xl border border-gray-700 bg-gray-950/95 p-1.5 shadow-2xl backdrop-blur-xl md:hidden" aria-label="Mobile navigation">
        <MobileNavButton label="Home" active={active === "stack"} onClick={() => onSelect("stack")} icon={<Home className="h-4 w-4" />} />
        <MobileNavButton label="Storage" active={active === "storage"} onClick={() => onSelect("storage")} icon={<HardDrive className="h-4 w-4" />} />
        <MobileNavButton label="Requests" active={active === "requests"} onClick={() => onSelect("requests")} icon={<Activity className="h-4 w-4" />} />
        <MobileNavButton label="Usage" active={active === "usage"} onClick={() => onSelect("usage")} icon={<Gauge className="h-4 w-4" />} />
        <MobileNavButton label="Models" active={active === "models"} onClick={() => onSelect("models")} icon={<Network className="h-4 w-4" />} />
    </nav>
    </>
  );
}

function MobileNavButton({ label, active, onClick, icon }: { label: string; active: boolean; onClick: () => void; icon: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-current={active ? "page" : undefined} className={`flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-xl text-[10px] font-medium transition ${active ? "bg-orange-500/12 text-orange-200" : "text-gray-500 hover:bg-gray-900 hover:text-gray-200"}`}>
      {icon}
      {label}
    </button>
  );
}

function NavButton({ active = false, onClick, children }: { active?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-current={active ? "page" : undefined} className={`relative flex h-full items-center px-3 text-sm font-medium transition ${active ? "text-orange-300" : "text-gray-500 hover:text-gray-200"}`}>
      {children}
      {active && <span className="absolute inset-x-2 bottom-0 h-0.5 bg-orange-500" />}
    </button>
  );
}
