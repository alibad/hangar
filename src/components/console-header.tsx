"use client";

import Image from "next/image";
import type { ReactNode } from "react";
import { Moon, Sun } from "@phosphor-icons/react";
import { RefreshCw, Server } from "lucide-react";
import { CommandPalette, type ConsoleTab } from "@/components/command-palette";
import { ThemePicker } from "@/components/theme-picker";
import { useTheme } from "@/components/theme-provider";
import { getHost } from "@/lib/host";

type Props = {
  machineCapacity: ReactNode;
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
  /** Which machine this console is running as. Falls back to the original name
   *  until /api/host answers, so the header never flashes a placeholder. */
  hostName?: string;
};

export default function ConsoleHeader({
  machineCapacity,
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
  hostName,
}: Props) {
  // The profile, not a hardcoded name, when the prop has not arrived yet.
  // hostName comes from /api/host, so it is undefined on first paint — and on a
  // background tab it stays undefined, because the live refresh pauses while
  // document.hidden. Falling back to a literal meant B5 sat there calling itself
  // BeTenshi: the other machine's name, on the one surface whose job is to say
  // which machine you are looking at. getHost() needs no fetch — the id is
  // resolved at build time into NEXT_PUBLIC_HOST_ID.
  const machine = hostName || getHost().name;
  const { theme, toggle } = useTheme();
  return (
    <>
    <header className="console-header sticky top-0 z-30 border-b border-gray-800 bg-gray-950/90 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-[1500px] items-center gap-3 px-4 sm:px-6">
        <button type="button" onClick={() => onSelect("world")} className="flex h-11 shrink-0 items-center gap-2.5 md:h-auto" aria-label={`Open Hangar world for ${machine}`}>
          <Image src="/icons/icon.svg" alt="" width={24} height={24} priority className="h-6 w-6" />
          <span className="text-lg font-semibold tracking-[-0.02em] text-gray-100">Hangar</span>
          <span className="hidden rounded-full border border-gray-800 bg-gray-900 px-2 py-0.5 text-[10px] font-medium text-gray-500 lg:inline">
            {machine} console
          </span>
        </button>

        <div className="ml-auto flex min-w-0 items-center gap-2">
          {machineCapacity}
          <CommandPalette active={active} onSelect={onSelect} />
          <button type="button" onClick={onRefresh} disabled={refreshing} aria-label={refreshing ? "Refreshing console" : "Refresh console"} className="flex h-11 w-11 items-center justify-center rounded-lg border border-gray-800 text-gray-500 transition hover:border-gray-600 hover:text-gray-100 disabled:opacity-50 md:h-9 md:w-9">
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
          </button>
          <button
            type="button"
            onClick={() => onSelect("services")}
            aria-label={`Service status: ${readyServices} ready now, ${onDemandServices} on demand, ${attentionServices} ${attentionServices === 1 ? "needs" : "need"} attention`}
            title={`${readyServices} ready · ${onDemandServices} on demand · ${attentionServices} need attention — open Services`}
            className="console-service-status flex h-9 items-center gap-1.5 rounded-lg px-2 text-xs text-gray-400 hover:bg-gray-900"
          >
            <span className={`h-2 w-2 rounded-full ${overallStatus === "operational" ? "bg-emerald-400" : overallStatus === "degraded" ? "bg-amber-400" : "bg-red-400"}`} />
            <Server size={14} /><span>{attentionServices ? `${attentionServices} !` : readyServices}</span>
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

    </>
  );
}

