"use client";

import { ArrowRight, CheckCircle, Cpu, WarningCircle } from "@phosphor-icons/react";
import { declaredMemoryGb } from "@/lib/host";

type GpuSnapshot = {
  name: string;
  /** Null where the GPU exposes no such counter (Apple silicon). */
  temperature: number | null;
  gpu_util: number | null;
  mem_total: number;
  mem_used: number;
  power_draw: number | null;
  /** "unified" means the GPU meter and the RAM meter would be the same pool. */
  memory_model?: "discrete" | "unified";
  host_ram?: { total_gb: number; free_gb: number; used_gb: number; pct_used: number };
  impact: "ok" | "good" | "warning" | "critical" | "busy";
  error?: string;
};

type ResourceSnapshot = {
  budgets: { ramSafetyGb: number; vramSafetyGb: number };
  capacity: {
    ram: { totalGb: number; freeGb: number };
    vram: { totalGb: number; freeGb: number };
  };
  queue: Array<unknown>;
  starts: Array<unknown>;
};

type Props = {
  gpu: GpuSnapshot | null;
  resources: ResourceSnapshot | null;
  onOpenDetails: () => void;
};

const clampPercent = (value: number, total: number) => Math.min(100, Math.max(0, total > 0 ? (value / total) * 100 : 0));

export default function ResourcePulse({ gpu, resources, onOpenDetails }: Props) {
  const vramTotal = gpu?.mem_total ? gpu.mem_total / 1024 : resources?.capacity.vram.totalGb ?? declaredMemoryGb().vramGb;
  const vramUsed = gpu?.mem_used ? gpu.mem_used / 1024 : Math.max(0, vramTotal - (resources?.capacity.vram.freeGb ?? vramTotal));
  const ramTotal = gpu?.host_ram?.total_gb ?? resources?.capacity.ram.totalGb ?? declaredMemoryGb().ramGb;
  const ramUsed = gpu?.host_ram?.used_gb ?? Math.max(0, ramTotal - (resources?.capacity.ram.freeGb ?? ramTotal));
  const vramFree = Math.max(0, vramTotal - vramUsed);
  const ramFree = Math.max(0, ramTotal - ramUsed);
  const queueDepth = (resources?.queue.length ?? 0) + (resources?.starts.length ?? 0);
  const constrained = gpu?.impact === "critical" || gpu?.impact === "warning";
  const unavailable = !gpu || Boolean(gpu.error);
  const unified = gpu?.memory_model === "unified";

  return (
    <section className="resource-pulse sticky top-16 z-20 border-b border-gray-800 bg-gray-950/88 backdrop-blur-xl" aria-label="Live machine capacity">
      <div className="mx-auto max-w-[1500px] px-4 py-2 sm:px-6">
        <button
          type="button"
          onClick={onOpenDetails}
          className="resource-pulse-surface group grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-xl border border-gray-800 bg-gray-900/85 px-3 py-2 text-left shadow-lg transition hover:border-gray-600 sm:gap-4 sm:px-4"
          aria-label="Open the detailed Resource Map"
        >
          <span className="flex items-center gap-2.5 sm:min-w-32">
            <span className="resource-pulse-icon flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-orange-500/30 bg-orange-500/10 text-orange-300">
              <Cpu size={17} weight="duotone" />
            </span>
            <span className="hidden sm:block">
              <span className="block text-xs font-semibold text-gray-100">Machine capacity</span>
              <span className={`mt-0.5 flex items-center gap-1 text-[10px] ${unavailable ? "text-gray-500" : constrained ? "text-amber-300" : "text-emerald-300"}`}>
                {unavailable || constrained ? <WarningCircle size={11} weight="fill" /> : <CheckCircle size={11} weight="fill" />}
                {unavailable ? "Telemetry unavailable" : constrained ? "Headroom limited" : "Healthy headroom"}
              </span>
            </span>
          </span>

          <span className="grid min-w-0 gap-1.5 lg:grid-cols-2 lg:gap-5">
            {/* One pool on a unified-memory host: two meters would show the same number twice. */}
            {unified ? (
              <CapacityMeter label="Memory" used={ramUsed} free={ramFree} total={ramTotal} tone="ram" />
            ) : (
              <>
                <CapacityMeter label="GPU" used={vramUsed} free={vramFree} total={vramTotal} tone="vram" />
                <CapacityMeter label="RAM" used={ramUsed} free={ramFree} total={ramTotal} tone="ram" />
              </>
            )}
          </span>

          <span className="flex shrink-0 items-center gap-3">
            <span className="hidden items-center gap-3 border-l border-gray-800 pl-4 xl:flex">
              {gpu?.gpu_util != null && <Metric label="Util" value={`${gpu.gpu_util}%`} />}
              {gpu?.temperature != null && <Metric label="Temp" value={`${gpu.temperature}°C`} />}
              {gpu?.power_draw != null && <Metric label="Power" value={`${Math.round(gpu.power_draw)}W`} />}
              <Metric label="Queue" value={String(queueDepth)} />
            </span>
            <span className="resource-pulse-details hidden items-center gap-1 text-[11px] font-medium text-orange-300 sm:flex">
              Details <ArrowRight size={12} className="transition group-hover:translate-x-0.5" />
            </span>
            <ArrowRight size={14} className="resource-pulse-details text-orange-300 sm:hidden" />
          </span>
        </button>
      </div>
    </section>
  );
}

function CapacityMeter({ label, used, free, total, tone }: { label: string; used: number; free: number; total: number; tone: "vram" | "ram" }) {
  const percent = clampPercent(used, total);
  return (
    <span className="grid min-w-0 grid-cols-[34px_minmax(72px,1fr)_78px] items-center gap-2 sm:grid-cols-[38px_minmax(100px,1fr)_100px]">
      <span className="text-[10px] font-semibold text-gray-300">{label}</span>
      <span
        role="progressbar"
        aria-label={`${label} capacity used`}
        aria-valuemin={0}
        aria-valuemax={Math.round(total * 10) / 10}
        aria-valuenow={Math.round(used * 10) / 10}
        className="h-2 overflow-hidden rounded-full bg-gray-800"
      >
        <span className={`block h-full rounded-full ${tone === "vram" ? "resource-pulse-vram bg-orange-500" : "resource-pulse-ram bg-sky-500"}`} style={{ width: `${percent}%` }} />
      </span>
      <span className="truncate text-right text-[9px] tabular-nums text-gray-500 sm:text-[10px]">
        <span className="font-medium text-gray-300">{used.toFixed(1)}</span> / {total.toFixed(1)} GB
        <span className="sr-only">, {free.toFixed(1)} GB free</span>
      </span>
    </span>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <span className="text-right leading-tight">
      <span className="block text-[8px] uppercase tracking-wide text-gray-600">{label}</span>
      <span className="block text-[10px] tabular-nums text-gray-300">{value}</span>
    </span>
  );
}
