"use client";

import { useState, type ReactNode } from "react";
import {
  ArrowsClockwise,
  CaretDown,
  CloudArrowDown,
  Cpu,
  HardDrives,
  Lightning,
  MagnifyingGlass,
  Memory,
  Plug,
  Rows,
  SquaresFour,
  Warning,
  X,
} from "@phosphor-icons/react";
import type { CatalogModel, Entry, EntryStatus, Machine, Occupant, Payload, Sort, SortKey } from "./models-page.types";
import { fmtGb } from "./models-page.types";

/* ── shared vocabulary ─────────────────────────────────────────────────────
   Status is the one thing every card shows, so it gets one definition. The
   colours encode distance rather than goodness: violet = serving traffic now,
   green = here and usable, amber = here but cold, blue = one action away,
   grey = elsewhere, red = out of reach.                                      */

const STATUS: Record<EntryStatus, { label: string; cls: string }> = {
  ready: { label: "ready", cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" },
  stopped: { label: "installed · stopped", cls: "bg-amber-500/15 text-amber-300 border-amber-500/30" },
  installed: { label: "downloaded", cls: "bg-sky-500/15 text-sky-300 border-sky-500/30" },
  downloading: { label: "downloading", cls: "bg-sky-500/20 text-sky-200 border-sky-400/40" },
  available: { label: "available", cls: "bg-gray-700/40 text-gray-400 border-gray-600/40" },
  "no-key": { label: "no key", cls: "bg-amber-500/15 text-amber-300 border-amber-500/30" },
  "wont-fit": { label: "won't fit", cls: "bg-red-500/10 text-red-400/90 border-red-500/25" },
};

const VERDICT_TEXT: Record<string, string> = {
  fits: "text-emerald-400",
  tight: "text-amber-300",
  swap: "text-sky-300",
  no: "text-red-400",
  "off-box": "text-gray-500",
};

function pct(v?: number | null): string {
  return typeof v === "number" ? String(Math.round(v * 100)) : "—";
}

/* ── the machine ───────────────────────────────────────────────────────────
   Everything below is judged against this, so it is stated once, at the top,
   in bytes — not left implicit inside per-model verdicts.                    */

export function MachineStrip({
  machine,
  occupants,
  leaderboard,
  onRefresh,
}: {
  machine: Machine;
  occupants: Occupant[];
  leaderboard: Payload["leaderboard"];
  onRefresh: () => void;
}) {
  const [spinning, setSpinning] = useState(false);
  const usedVram = occupants.reduce((a, o) => a + o.vramGb, 0);
  const usedRam = machine.ramTotalGb - machine.ramFreeGb;
  const diskUsed = machine.weightsDiskTotalGb
    ? machine.weightsDiskTotalGb - machine.weightsDiskFreeGb
    : undefined;

  return (
    <section className="tool-panel bg-gray-900 rounded-xl border border-gray-800 p-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Cpu size={16} weight="duotone" className="text-indigo-400" />
        <span className="text-sm font-semibold text-gray-100">{machine.gpuName}</span>
        <span className="text-[11px] text-gray-500">
          {leaderboard.runnable} of {leaderboard.openWeights.length} open-weights models on llm-stats run here
        </span>
        <button
          onClick={async () => {
            setSpinning(true);
            await onRefresh();
            setSpinning(false);
          }}
          className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-gray-400 hover:text-white border border-gray-800 hover:border-gray-600 rounded-md px-2 py-1 transition cursor-pointer"
        >
          <ArrowsClockwise size={12} weight="bold" className={spinning ? "animate-spin" : ""} />
          Re-check
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Meter
          icon={<Cpu size={12} weight="duotone" />}
          label="VRAM"
          usedGb={usedVram}
          totalGb={machine.vramTotalGb}
          // Segments, not one bar: which service holds the card decides what
          // else can load, and "24 GB used" cannot say that.
          segments={occupants.map((o) => ({ label: o.name, gb: o.vramGb }))}
          freeLabel={`${machine.vramFreeGb} GB free now`}
        />
        <Meter
          icon={<Memory size={12} weight="duotone" />}
          label="Host RAM"
          usedGb={usedRam}
          totalGb={machine.ramTotalGb}
          freeLabel={`${machine.ramFreeGb} GB free now`}
        />
        <Meter
          icon={<HardDrives size={12} weight="duotone" />}
          label="Weights drive"
          usedGb={diskUsed}
          totalGb={machine.weightsDiskTotalGb}
          segments={
            machine.weightsUsedGb != null ? [{ label: "model weights", gb: machine.weightsUsedGb }] : undefined
          }
          freeLabel={
            machine.weightsIndexed === false
              ? `${machine.weightsDiskFreeGb} GB free · not indexed`
              : machine.weightsUsedGb != null
                ? `${machine.weightsDiskFreeGb} GB free · ${machine.weightsUsedGb} GB of weights`
                : `${machine.weightsDiskFreeGb} GB free`
          }
          title={machine.weightsPath}
        />
      </div>
    </section>
  );
}

function Meter({
  icon,
  label,
  usedGb,
  totalGb,
  segments,
  freeLabel,
  title,
}: {
  icon: ReactNode;
  label: string;
  usedGb?: number;
  totalGb?: number;
  segments?: { label: string; gb: number }[];
  freeLabel: string;
  title?: string;
}) {
  const total = totalGb || 0;
  const parts = segments?.length ? segments : usedGb ? [{ label: "in use", gb: usedGb }] : [];
  return (
    <div title={title}>
      <div className="flex items-baseline gap-1.5">
        <span className="text-gray-500">{icon}</span>
        <span className="text-[10px] uppercase tracking-wide text-gray-500">{label}</span>
        <span className="ml-auto text-[10px] text-gray-500 tabular-nums">{total ? `${total} GB` : "—"}</span>
      </div>
      <div className="mt-1 h-2 w-full rounded-full bg-gray-800 overflow-hidden flex">
        {parts.map((s, i) => (
          <div
            key={i}
            className={i % 2 === 0 ? "bg-indigo-500/70" : "bg-violet-500/60"}
            style={{ width: total ? `${Math.min(100, (s.gb / total) * 100)}%` : "0%" }}
            title={`${s.label}: ${fmtGb(s.gb)}`}
          />
        ))}
      </div>
      <p className="mt-1 text-[10px] text-gray-500 tabular-nums">{freeLabel}</p>
      {segments && segments.length > 0 && (
        <p className="text-[10px] text-gray-600 truncate" title={segments.map((s) => `${s.label} ${fmtGb(s.gb)}`).join(" · ")}>
          {segments.map((s) => s.label).join(" · ")}
        </p>
      )}
    </div>
  );
}

/* ── active routes ─────────────────────────────────────────────────────────
   The five decisions this page exists to make, always visible. Doubles as the
   capability filter: clicking one narrows the list to models that can serve it,
   which is how "what should text use?" turns into a shortlist.               */

export function RouteStrip({
  capabilities,
  routing,
  catalogue,
  selected,
  onSelect,
}: {
  capabilities: Payload["capabilities"];
  routing: Record<string, string>;
  catalogue: CatalogModel[];
  selected: string | null;
  onSelect: (cap: string) => void;
}) {
  return (
    <section aria-label="Active routing">
      <div className="grid gap-2 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
        {capabilities.map((cap) => {
          const alias = routing[cap.id];
          const model = catalogue.find((m) => m.id === alias);
          const on = selected === cap.id;
          const healthy = model?.status === "ready";
          return (
            <button
              key={cap.id}
              onClick={() => onSelect(cap.id)}
              aria-pressed={on}
              title={`${cap.hint}\n\nClick to filter the list to models that can serve ${cap.label}.`}
              className={`rounded-xl border p-2.5 text-left transition cursor-pointer ${
                on
                  ? "border-indigo-500/60 bg-indigo-500/10"
                  : "border-gray-800 bg-gray-900 hover:border-gray-600"
              }`}
            >
              <span className="flex items-center gap-1.5">
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    !model ? "bg-gray-600" : healthy ? "bg-emerald-400" : "bg-amber-400"
                  }`}
                />
                <span className="text-[10px] font-medium uppercase tracking-wide text-gray-500">{cap.label}</span>
              </span>
              <span className="mt-1 block truncate text-[13px] font-semibold text-gray-100" title={alias}>
                {alias ?? "not selected"}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/* ── filters ─────────────────────────────────────────────────────────────── */

export function FilterBar({
  runsHere,
  onRunsHere,
  query,
  onQuery,
  capability,
  onClearCapability,
  hiddenCount,
  unwired,
  busy,
  onWireAll,
}: {
  runsHere: boolean;
  onRunsHere: (v: boolean) => void;
  query: string;
  onQuery: (v: string) => void;
  capability: string | null;
  onClearCapability: () => void;
  hiddenCount: number;
  unwired: number;
  busy: string | null;
  onWireAll: () => void;
}) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <button
        onClick={() => onRunsHere(!runsHere)}
        aria-pressed={runsHere}
        title="Hide anything this card cannot run at any quantisation."
        className={`inline-flex items-center gap-1.5 text-[11px] rounded-md px-2.5 py-1.5 border transition cursor-pointer ${
          runsHere
            ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
            : "bg-gray-900 text-gray-400 border-gray-800 hover:border-gray-600"
        }`}
      >
        <Cpu size={12} weight="duotone" />
        Runs on this machine
      </button>

      {capability && (
        <button
          onClick={onClearCapability}
          className="inline-flex items-center gap-1 text-[11px] rounded-md px-2 py-1.5 border border-indigo-500/40 bg-indigo-500/10 text-indigo-200 cursor-pointer"
        >
          {capability}
          <X size={11} weight="bold" />
        </button>
      )}

      <label className="relative flex items-center">
        <MagnifyingGlass size={12} className="absolute left-2 text-gray-600" />
        <input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search models…"
          className="text-[11px] bg-gray-900 border border-gray-800 focus:border-gray-600 rounded-md pl-6 pr-2 py-1.5 outline-none text-gray-200 placeholder:text-gray-600 w-44"
        />
      </label>

      {/* Counts per lane live on the lane tabs. What belongs here is what the
          filters are REMOVING, which is otherwise invisible. */}
      {hiddenCount > 0 && (
        <span className="text-[11px] text-gray-600" title="Models excluded by the filters above.">
          {hiddenCount} hidden
        </span>
      )}

      {unwired > 0 && (
        <button
          onClick={onWireAll}
          disabled={!!busy}
          title="Add every cloud model your providers offer as a router alias — one config write, one restart. Adding an alias changes no route."
          className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-indigo-200 bg-indigo-500/15 hover:bg-indigo-500/25 border border-indigo-500/40 rounded-md px-2.5 py-1.5 transition disabled:opacity-50 cursor-pointer"
        >
          <Lightning size={12} weight="fill" />
          {busy === "wire-all" ? "Wiring…" : `Wire all ${unwired} cloud`}
        </button>
      )}
    </div>
  );
}

/* ── lanes ─────────────────────────────────────────────────────────────────
   Two lanes rather than one list, because "on this machine" and "cloud" are
   different kinds of commitment: one costs memory and a download, the other
   costs money per call. Ranking them against each other would be comparing
   quantities that do not convert.

   Tabs rather than two stacked sections: side by side they only fitted on a very
   wide screen and stacked everywhere else, which buried the cloud lane under a
   hundred local cards. One at a time also gives each card the full width, so the
   numbers that decide a model fit on one line instead of wrapping.            */

export function LaneTabs({
  lane,
  onLane,
  localCount,
  cloudCount,
}: {
  lane: "local" | "cloud";
  onLane: (l: "local" | "cloud") => void;
  localCount: number;
  cloudCount: number;
}) {
  return (
    <div
      className="inline-flex rounded-lg border border-gray-800 bg-gray-900 p-0.5"
      role="tablist"
      aria-label="Where the model runs"
    >
      {([
        ["local", "On this machine", localCount],
        ["cloud", "Cloud", cloudCount],
      ] as const).map(([id, label, count]) => (
        <button
          key={id}
          role="tab"
          aria-selected={lane === id}
          onClick={() => onLane(id)}
          className={`inline-flex items-center gap-1.5 text-[11px] px-3 py-1.5 rounded-md transition cursor-pointer ${
            lane === id ? "bg-indigo-500/15 text-indigo-200" : "text-gray-500 hover:text-gray-300"
          }`}
        >
          {label}
          <span
            className={`tabular-nums text-[10px] px-1.5 rounded-full ${
              lane === id ? "bg-indigo-500/25 text-indigo-100" : "bg-gray-800 text-gray-500"
            }`}
          >
            {count}
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * List or cards.
 *
 * List is the default because the question this page answers is comparative —
 * which of these is best for what it costs — and a grid of cards makes you hold
 * numbers in your head between one card and the next. Cards stay for browsing,
 * where the prose matters more than the columns.
 */
export function ViewToggle({
  view,
  onView,
}: {
  view: "list" | "cards";
  onView: (v: "list" | "cards") => void;
}) {
  return (
    <div className="inline-flex rounded-md border border-gray-800 bg-gray-900 p-0.5">
      {([
        ["list", "List", <Rows key="l" size={12} weight="bold" />],
        ["cards", "Cards", <SquaresFour key="c" size={12} weight="bold" />],
      ] as const).map(([id, label, icon]) => (
        <button
          key={id}
          onClick={() => onView(id)}
          aria-pressed={view === id}
          title={
            id === "list"
              ? "Dense table, sortable — for comparing models against each other."
              : "One card each, with the reasoning spelled out."
          }
          className={`inline-flex items-center gap-1 text-[10px] px-2 py-1 rounded transition cursor-pointer ${
            view === id ? "bg-gray-800 text-gray-100" : "text-gray-500 hover:text-gray-300"
          }`}
        >
          {icon}
          {label}
        </button>
      ))}
    </div>
  );
}

type Col = {
  key: SortKey;
  label: string;
  title?: string;
  align?: "right";
  render: (e: Entry) => ReactNode;
};

const BENCH_COLS: Col[] = [
  { key: "gpqa", label: "GPQA", title: "GPQA Diamond, %", align: "right", render: (e) => pct(e.gpqa) },
  { key: "swe", label: "SWE", title: "SWE-bench Verified, %", align: "right", render: (e) => pct(e.swe) },
  { key: "hle", label: "HLE", title: "Humanity's Last Exam, %", align: "right", render: (e) => pct(e.hle) },
];

/** Columns differ by lane because the costs differ: memory here, money there. */
function columnsFor(tone: "local" | "cloud"): Col[] {
  if (tone === "local") {
    return [
      { key: "size", label: "Size", align: "right", render: (e) => (e.paramsB != null ? `${Math.round(e.paramsB)}B` : "—") },
      {
        key: "default",
        label: "Runs at",
        render: (e) =>
          e.quant ? (
            <span className={VERDICT_TEXT[e.verdict ?? ""] ?? "text-gray-400"}>{e.quant}</span>
          ) : e.measured ? (
            <span className="text-gray-500">installed</span>
          ) : (
            "—"
          ),
      },
      { key: "vram", label: "VRAM", align: "right", render: (e) => fmtGb(e.vramGb) },
      { key: "disk", label: "Disk", align: "right", render: (e) => (e.diskGb ? fmtGb(e.diskGb) : "—") },
      ...BENCH_COLS,
    ];
  }
  return [
    { key: "in", label: "$ in", title: "USD per million input tokens", align: "right", render: (e) => (e.inPrice != null ? `${e.inPrice}` : "—") },
    { key: "out", label: "$ out", title: "USD per million output tokens", align: "right", render: (e) => (e.outPrice != null ? `${e.outPrice}` : "—") },
    { key: "speed", label: "tok/s", align: "right", render: (e) => (e.throughput != null ? String(Math.round(e.throughput)) : "—") },
    { key: "ctx", label: "Ctx", align: "right", render: (e) => (e.context ? `${Math.round(e.context / 1024)}k` : "—") },
    ...BENCH_COLS,
  ];
}

export function ModelTable({
  entries,
  tone,
  limit,
  sort,
  onSort,
  selectedKey,
  onSelect,
  onMore,
}: {
  entries: Entry[];
  tone: "local" | "cloud";
  limit: number;
  sort: Sort;
  onSort: (s: Sort) => void;
  selectedKey?: string;
  onSelect: (e: Entry) => void;
  onMore: () => void;
}) {
  const cols = columnsFor(tone);
  const shown = entries.slice(0, limit);

  const head = (c: Col) => {
    const active = sort.key === c.key && c.key !== "default";
    const sortable = c.key !== "default";
    return (
      <th
        key={`${c.key}-${c.label}`}
        title={c.title}
        className={`px-2 py-1.5 font-medium ${c.align === "right" ? "text-right" : "text-left"} ${
          sortable ? "cursor-pointer hover:text-gray-300" : ""
        } ${active ? "text-gray-200" : ""}`}
        onClick={
          sortable
            ? () =>
                onSort(
                  // Third click on the same column returns to the server's
                  // ranking rather than leaving you stuck in a column sort you
                  // cannot undo without reloading.
                  active && sort.dir === "asc"
                    ? { key: "default", dir: "desc" }
                    : { key: c.key, dir: active && sort.dir === "desc" ? "asc" : "desc" },
                )
            : undefined
        }
      >
        {c.label}
        {active && <span className="ml-0.5 opacity-70">{sort.dir === "desc" ? "↓" : "↑"}</span>}
      </th>
    );
  };

  return (
    <div className="space-y-2 min-w-0">
      <div className="overflow-x-auto rounded-xl border border-gray-800">
        <table className="w-full text-left border-collapse min-w-[680px]">
          <thead>
            <tr className="text-[10px] uppercase tracking-wide text-gray-600 bg-gray-900/80">
              <th
                className={`px-2 py-1.5 font-medium cursor-pointer hover:text-gray-300 ${sort.key === "name" ? "text-gray-200" : ""}`}
                onClick={() =>
                  onSort(
                    sort.key === "name" && sort.dir === "asc"
                      ? { key: "default", dir: "desc" }
                      : { key: "name", dir: sort.key === "name" && sort.dir === "desc" ? "asc" : "desc" },
                  )
                }
              >
                Model
                {sort.key === "name" && <span className="ml-0.5 opacity-70">{sort.dir === "desc" ? "↓" : "↑"}</span>}
              </th>
              {cols.map(head)}
            </tr>
          </thead>
          <tbody>
            {shown.map((e) => {
              const st = STATUS[e.status];
              const isSel = e.key === selectedKey;
              const isActive = e.activeFor.length > 0;
              return (
                <tr
                  key={e.key}
                  onClick={() => onSelect(e)}
                  className={`border-t border-gray-800/70 cursor-pointer transition ${
                    isSel
                      ? "bg-indigo-500/10"
                      : isActive
                        ? "bg-violet-500/[0.06] hover:bg-violet-500/10"
                        : "hover:bg-gray-900/60"
                  }`}
                >
                  <td className="px-2 py-1.5">
                    <div className="flex items-center gap-1.5 min-w-0">
                      {/* One dot carries the whole status vocabulary at a glance;
                          the label is there for anyone who does not know it. */}
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${DOT[e.status]}`} title={st.label} />
                      <span className="text-[12px] text-gray-200 truncate">{e.name}</span>
                      {isActive && (
                        <span className="text-[9px] px-1 rounded-full bg-violet-500/20 text-violet-200 shrink-0">
                          {e.activeFor.join("·")}
                        </span>
                      )}
                      {e.status === "downloading" && (
                        <span className="text-[9px] text-sky-300 shrink-0 tabular-nums">
                          {e.download?.percent ?? 0}%
                        </span>
                      )}
                    </div>
                    <div className="text-[9px] text-gray-600 truncate font-mono">{e.org ? `${e.org} · ` : ""}{e.sub}</div>
                  </td>
                  {cols.map((c) => (
                    <td
                      key={`${c.key}-${c.label}`}
                      className={`px-2 py-1.5 text-[11px] tabular-nums text-gray-400 ${c.align === "right" ? "text-right" : ""}`}
                    >
                      {c.render(e)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {entries.length > shown.length && (
        <button
          onClick={onMore}
          className="w-full text-[11px] text-gray-400 hover:text-white border border-gray-800 hover:border-gray-600 rounded-md py-1.5 transition cursor-pointer"
        >
          Show {Math.min(24, entries.length - shown.length)} more of {entries.length - shown.length}
        </button>
      )}
    </div>
  );
}

const DOT: Record<EntryStatus, string> = {
  ready: "bg-emerald-400",
  stopped: "bg-amber-400",
  installed: "bg-sky-400",
  downloading: "bg-sky-400 animate-pulse",
  available: "bg-gray-600",
  "no-key": "bg-amber-400",
  "wont-fit": "bg-red-500/70",
};

/**
 * Everything about one model, on click.
 *
 * The table deliberately shows only what compares. This is where the things
 * that do not fit a column go: why a verdict came out the way it did, the whole
 * quantisation ladder, the note, and every action. Keeping them here is what
 * lets the table stay narrow enough to read across.
 */
export function DetailPanel({
  e,
  busy,
  capabilities,
  onClose,
  onUse,
  onService,
  onDownload,
  onCancelDownload,
  onWire,
  onUnwire,
}: {
  e: Entry;
  busy: string | null;
  capabilities: Payload["capabilities"];
  onClose: () => void;
  onUse: (e: Entry, cap: string) => void;
  onService?: (serviceId: string, action: "start" | "stop" | "restart") => void;
  onDownload?: (repo: string) => void;
  onCancelDownload?: (repo: string) => void;
  onWire?: (e: Entry) => void;
  onUnwire?: (e: Entry) => void;
}) {
  const st = STATUS[e.status];
  const usable = capabilities.filter((c) => e.capabilities.includes(c.id) && !e.activeFor.includes(c.id));

  return (
    <aside className="rounded-xl border border-gray-800 bg-gray-900 p-3 space-y-3 xl:sticky xl:top-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <h3 className="text-[13px] font-semibold text-gray-100">{e.name}</h3>
            <span className={`text-[9px] px-1.5 py-0.5 rounded-full border ${st.cls}`}>{st.label}</span>
            {e.activeFor.length > 0 && (
              <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-violet-500/20 text-violet-200">
                active for {e.activeFor.join(" · ")}
              </span>
            )}
          </div>
          <p className="text-[10px] font-mono text-gray-600 break-all mt-0.5">
            {e.org ? `${e.org} · ` : ""}
            {e.sub}
          </p>
        </div>
        <button
          onClick={onClose}
          aria-label="Close details"
          className="text-gray-600 hover:text-gray-300 cursor-pointer shrink-0"
        >
          <X size={14} weight="bold" />
        </button>
      </div>

      {/* Actions first: this panel exists to be acted on, not read. */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {e.alias &&
          usable.map((c) => (
            <button
              key={c.id}
              onClick={() => onUse(e, c.id)}
              disabled={!!busy || e.status === "no-key"}
              title={
                e.status === "stopped"
                  ? `Start ${e.serviceId}, wait for health, then route ${c.label} here.`
                  : `Route ${c.label} to ${e.alias}.`
              }
              className="text-[10px] text-gray-200 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded px-2 py-1 transition disabled:opacity-40 cursor-pointer"
            >
              {busy === `use:${e.key}:${c.id}` ? "…" : `Use for ${c.label.toLowerCase()}`}
            </button>
          ))}
        {e.serviceId && e.status === "ready" && onService && (
          <button
            onClick={() => onService(e.serviceId!, "stop")}
            disabled={!!busy}
            className="text-[10px] text-gray-400 hover:text-amber-300 border border-gray-800 hover:border-amber-500/40 rounded px-2 py-1 transition disabled:opacity-40 cursor-pointer"
          >
            Stop service
          </button>
        )}
        {e.serviceId && e.status === "stopped" && onService && (
          <button
            onClick={() => onService(e.serviceId!, "start")}
            disabled={!!busy}
            className="text-[10px] text-gray-200 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded px-2 py-1 transition disabled:opacity-40 cursor-pointer"
          >
            {busy === `svc:${e.serviceId}:start` ? "Starting…" : "Start service"}
          </button>
        )}
        {e.kind === "local" && e.status === "available" && onDownload && (
          <DownloadButton entry={e} busy={busy} onDownload={onDownload} />
        )}
        {e.download?.status === "running" && onCancelDownload && (
          <button
            onClick={() => onCancelDownload(e.download!.repo)}
            className="text-[10px] text-gray-500 hover:text-red-400 border border-gray-800 hover:border-red-500/40 rounded px-2 py-1 transition cursor-pointer"
          >
            Cancel download
          </button>
        )}
        {e.kind === "cloud" && e.status === "available" && onWire && (
          <button
            onClick={() => onWire(e)}
            disabled={!!busy}
            className="inline-flex items-center gap-1 text-[10px] text-gray-200 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded px-2 py-1 transition disabled:opacity-40 cursor-pointer"
          >
            <Plug size={10} weight="bold" />
            {busy === `wire:${e.key}` ? "Wiring…" : `Wire as ${e.suggestedAlias}`}
          </button>
        )}
        {e.kind === "cloud" && e.alias && e.consoleWired && e.activeFor.length === 0 && onUnwire && (
          <button
            onClick={() => onUnwire(e)}
            disabled={!!busy}
            className="text-[10px] text-gray-500 hover:text-red-400 border border-gray-800 hover:border-red-500/40 rounded px-2 py-1 transition disabled:opacity-40 cursor-pointer"
          >
            Remove alias
          </button>
        )}
      </div>

      {e.download?.status === "running" && (
        <div>
          <div className="h-1.5 w-full rounded-full bg-gray-800 overflow-hidden">
            <div className="h-full bg-sky-500 transition-all" style={{ width: `${e.download.percent ?? 3}%` }} />
          </div>
          <p className="mt-1 text-[10px] text-sky-300/80 break-all">{e.download.detail ?? "starting…"}</p>
        </div>
      )}

      {e.detail && <p className="text-[10px] text-amber-400/85 leading-relaxed">{e.detail}</p>}
      {e.note && <p className="text-[10px] text-gray-500 leading-relaxed">{e.note}</p>}

      {/* Why the verdict is what it is. */}
      {e.fit && (
        <div className="space-y-1">
          <p className={`text-[11px] leading-relaxed ${VERDICT_TEXT[e.fit.verdict] ?? "text-gray-400"}`}>
            {e.fit.headline}
          </p>
          {e.fit.reasons.map((r, i) => (
            <p key={i} className="text-[10px] text-gray-500 leading-relaxed">— {r}</p>
          ))}
        </div>
      )}
      {e.measured && (
        <p className="text-[10px] text-emerald-400/80 leading-relaxed">
          Footprint measured on this box — see config/model-meta.json.
        </p>
      )}

      {e.rungs && e.rungs.length > 0 && (
        <div className="space-y-0.5">
          <p className="text-[9px] uppercase tracking-wide text-gray-600">Quantisation ladder</p>
          {e.rungs.map((r) => (
            <div
              key={r.precision}
              className={`flex items-center gap-2 text-[10px] tabular-nums ${
                r.label === e.quant ? "text-gray-200" : ""
              }`}
              title={r.note}
            >
              <span className="w-16 text-gray-400">{r.label}</span>
              <span className="w-16 text-gray-500">{fmtGb(r.requirement.vramGb)}</span>
              <span className={VERDICT_TEXT[r.fit.verdict] ?? "text-gray-600"}>{r.fit.verdict}</span>
              {r.label === e.quant && <span className="text-[9px] text-indigo-300">← best that fits</span>}
            </div>
          ))}
          {e.fit?.basis && <p className="text-[9px] text-gray-600 leading-relaxed pt-1">{e.fit.basis}</p>}
        </div>
      )}

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] tabular-nums">
        {e.paramsB != null && <Row k="Parameters" v={`${Math.round(e.paramsB)}B`} />}
        {e.context != null && <Row k="Context" v={`${Math.round(e.context / 1024)}k`} />}
        {e.inPrice != null && <Row k="Input" v={`$${e.inPrice}/Mtok`} />}
        {e.outPrice != null && <Row k="Output" v={`$${e.outPrice}/Mtok`} />}
        {e.throughput != null && <Row k="Throughput" v={`${Math.round(e.throughput)} tok/s`} />}
        {e.gpqa != null && <Row k="GPQA" v={pct(e.gpqa)} />}
        {e.swe != null && <Row k="SWE-bench" v={pct(e.swe)} />}
        {e.hle != null && <Row k="HLE" v={pct(e.hle)} />}
        {e.released && <Row k="Released" v={e.released} />}
        {e.alias && <Row k="Alias" v={e.alias} />}
      </dl>

      {e.docs && (
        <a
          href={e.docs}
          target="_blank"
          rel="noreferrer"
          className="inline-block text-[10px] text-indigo-400 hover:text-indigo-300 underline underline-offset-2"
        >
          docs ↗
        </a>
      )}
    </aside>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="text-gray-600">{k}</dt>
      <dd className="text-gray-300 truncate" title={v}>{v}</dd>
    </>
  );
}

export function Lane({
  subtitle,
  tone,
  entries,
  limit,
  busy,
  capabilities,
  onMore,
  onUse,
  onService,
  onDownload,
  onCancelDownload,
  onWire,
  onUnwire,
}: {
  subtitle: string;
  tone: "local" | "cloud";
  entries: Entry[];
  limit: number;
  busy: string | null;
  capabilities: Payload["capabilities"];
  onMore: () => void;
  onUse: (e: Entry, cap: string) => void;
  onService?: (serviceId: string, action: "start" | "stop" | "restart") => void;
  onDownload?: (repo: string) => void;
  onCancelDownload?: (repo: string) => void;
  onWire?: (e: Entry) => void;
  onUnwire?: (e: Entry) => void;
}) {
  const shown = entries.slice(0, limit);
  return (
    <section className="space-y-2 min-w-0">
      {subtitle && <p className="text-[11px] text-gray-600 leading-relaxed">{subtitle}</p>}

      {shown.length === 0 ? (
        <p className="text-xs text-gray-600 py-6 text-center border border-dashed border-gray-800 rounded-xl">
          Nothing matches those filters.
        </p>
      ) : (
        // Two columns once there is room. A full-width lane at one card per row
        // makes a hundred models an very long scroll for no gain.
        <div className="grid gap-2 lg:grid-cols-2 items-start">
          {shown.map((e) => (
            <ModelCard
              key={e.key}
              e={e}
              tone={tone}
              busy={busy}
              capabilities={capabilities}
              onUse={onUse}
              onService={onService}
              onDownload={onDownload}
              onCancelDownload={onCancelDownload}
              onWire={onWire}
              onUnwire={onUnwire}
            />
          ))}
        </div>
      )}

      {entries.length > shown.length && (
        <button
          onClick={onMore}
          className="w-full text-[11px] text-gray-400 hover:text-white border border-gray-800 hover:border-gray-600 rounded-md py-1.5 transition cursor-pointer"
        >
          Show {Math.min(24, entries.length - shown.length)} more of {entries.length - shown.length}
        </button>
      )}
    </section>
  );
}

/* ── one model ─────────────────────────────────────────────────────────── */

function ModelCard({
  e,
  tone,
  busy,
  capabilities,
  onUse,
  onService,
  onDownload,
  onCancelDownload,
  onWire,
  onUnwire,
}: {
  e: Entry;
  tone: "local" | "cloud";
  busy: string | null;
  capabilities: Payload["capabilities"];
  onUse: (e: Entry, cap: string) => void;
  onService?: (serviceId: string, action: "start" | "stop" | "restart") => void;
  onDownload?: (repo: string) => void;
  onCancelDownload?: (repo: string) => void;
  onWire?: (e: Entry) => void;
  onUnwire?: (e: Entry) => void;
}) {
  const [open, setOpen] = useState(false);
  const st = STATUS[e.status];
  const isActive = e.activeFor.length > 0;
  // Only offer capabilities this model can actually serve AND that it is not
  // already the route for — a "use for text" button on the current text model
  // is a no-op dressed as a choice.
  const usable = capabilities.filter((c) => e.capabilities.includes(c.id) && !e.activeFor.includes(c.id));

  return (
    <article
      className={`rounded-xl border p-3 transition ${
        isActive ? "border-violet-500/50 bg-violet-500/[0.06]" : "border-gray-800 bg-gray-900 hover:border-gray-700"
      }`}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[13px] font-medium text-gray-100 truncate">{e.name}</span>
            <span className={`text-[9px] px-1.5 py-0.5 rounded-full border ${st.cls}`}>{st.label}</span>
            {isActive && (
              <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-violet-500/20 text-violet-200">
                {e.activeFor.join(" · ")}
              </span>
            )}
            {e.supersedes && (
              <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-indigo-500/15 text-indigo-300">
                newer than {e.supersedes}
              </span>
            )}
          </div>
          <p className="text-[10px] font-mono text-gray-600 truncate" title={e.sub}>
            {e.org ? `${e.org} · ` : ""}
            {e.sub}
          </p>
        </div>
      </div>

      {/* The numbers that decide it, in one row. Local: what it costs the card.
          Cloud: what it costs per call. Both: how good it is. */}
      <div className="mt-2 flex items-center gap-x-3 gap-y-1 flex-wrap text-[10px] tabular-nums">
        {tone === "local" ? (
          <>
            {e.paramsB != null && <Stat label="size" value={`${Math.round(e.paramsB)}B`} />}
            {e.quant && <Stat label="quant" value={e.quant} />}
            {e.vramGb != null && (
              <Stat
                label="VRAM"
                value={fmtGb(e.vramGb)}
                cls={e.verdict ? VERDICT_TEXT[e.verdict] : undefined}
                title={
                  e.measured
                    ? "Measured on this box — see config/model-meta.json."
                    : [e.fit?.headline, ...(e.fit?.reasons ?? [])].filter(Boolean).join("\n\n")
                }
              />
            )}
            {e.diskGb != null && e.diskGb > 0 && <Stat label="download" value={fmtGb(e.diskGb)} />}
          </>
        ) : (
          <>
            {e.inPrice != null && (
              <Stat label="$/Mtok" value={`${e.inPrice} in · ${e.outPrice ?? "?"} out`} />
            )}
            {e.throughput != null && <Stat label="speed" value={`${Math.round(e.throughput)} tok/s`} />}
            {e.context != null && <Stat label="ctx" value={`${Math.round(e.context / 1024)}k`} />}
          </>
        )}
        {(e.gpqa != null || e.swe != null || e.hle != null) && (
          <span className="flex items-center gap-2 text-gray-500" title="GPQA Diamond · SWE-bench Verified · Humanity's Last Exam, as published by llm-stats.com">
            {e.gpqa != null && <Bench label="gpqa" v={e.gpqa} />}
            {e.swe != null && <Bench label="swe" v={e.swe} />}
            {e.hle != null && <Bench label="hle" v={e.hle} />}
          </span>
        )}
      </div>

      {/* Fit, in words, when it is not simply "fine". */}
      {e.fit && e.fit.verdict !== "fits" && (
        <p className={`mt-1.5 text-[10px] leading-relaxed ${VERDICT_TEXT[e.fit.verdict] ?? "text-gray-500"}`}>
          {e.fit.headline}
        </p>
      )}
      {e.detail && <p className="mt-1.5 text-[10px] text-amber-400/80 leading-relaxed">{e.detail}</p>}

      {/* A running download owns the card while it runs. */}
      {e.download?.status === "running" && (
        <div className="mt-2">
          <div className="h-1.5 w-full rounded-full bg-gray-800 overflow-hidden">
            <div
              className="h-full bg-sky-500 transition-all"
              style={{ width: `${e.download.percent ?? 3}%` }}
            />
          </div>
          <p className="mt-1 text-[10px] text-sky-300/80 truncate" title={e.download.detail}>
            {e.download.percent != null ? `${e.download.percent}% · ` : ""}
            {e.download.detail ?? "starting…"}
          </p>
        </div>
      )}
      {e.download?.status === "failed" && (
        <p className="mt-1.5 inline-flex items-center gap-1 text-[10px] text-red-400">
          <Warning size={11} weight="fill" /> Download stopped. {e.download.detail}
        </p>
      )}

      {/* Actions. */}
      <div className="mt-2 flex items-center gap-1.5 flex-wrap">
        {usable.length > 0 && e.alias && (
          <div className="flex items-center gap-1">
            {usable.slice(0, 2).map((c) => (
              <button
                key={c.id}
                onClick={() => onUse(e, c.id)}
                disabled={!!busy || e.status === "no-key"}
                title={
                  e.status === "stopped"
                    ? `Start ${e.serviceId}, wait for health, then route ${c.label} here.`
                    : `Route ${c.label} to ${e.alias}.`
                }
                className="text-[10px] text-gray-300 hover:text-white border border-gray-700 hover:border-gray-500 rounded px-1.5 py-1 transition disabled:opacity-40 cursor-pointer"
              >
                {busy === `use:${e.key}:${c.id}` ? "…" : `Use for ${c.label.toLowerCase()}`}
              </button>
            ))}
          </div>
        )}

        {e.serviceId && e.status === "ready" && onService && (
          <button
            onClick={() => onService(e.serviceId!, "stop")}
            disabled={!!busy}
            className="text-[10px] text-gray-500 hover:text-amber-300 border border-gray-800 hover:border-amber-500/40 rounded px-1.5 py-1 transition disabled:opacity-40 cursor-pointer"
          >
            Stop
          </button>
        )}
        {e.serviceId && e.status === "stopped" && onService && (
          <button
            onClick={() => onService(e.serviceId!, "start")}
            disabled={!!busy}
            className="text-[10px] text-gray-300 hover:text-white border border-gray-700 hover:border-gray-500 rounded px-1.5 py-1 transition disabled:opacity-40 cursor-pointer"
          >
            {busy === `svc:${e.serviceId}:start` ? "Starting…" : "Start"}
          </button>
        )}

        {tone === "local" && e.status === "available" && onDownload && (
          <DownloadButton entry={e} busy={busy} onDownload={onDownload} />
        )}
        {e.download?.status === "running" && onCancelDownload && (
          <button
            onClick={() => onCancelDownload(e.download!.repo)}
            className="text-[10px] text-gray-500 hover:text-red-400 border border-gray-800 hover:border-red-500/40 rounded px-1.5 py-1 transition cursor-pointer"
          >
            Cancel
          </button>
        )}

        {tone === "cloud" && e.status === "available" && onWire && (
          <button
            onClick={() => onWire(e)}
            disabled={!!busy}
            title={`Add ${e.suggestedAlias} as a router alias. Changes no route.`}
            className="inline-flex items-center gap-1 text-[10px] text-gray-300 hover:text-white border border-gray-700 hover:border-gray-500 rounded px-1.5 py-1 transition disabled:opacity-40 cursor-pointer"
          >
            <Plug size={10} weight="bold" />
            {busy === `wire:${e.key}` ? "Wiring…" : "Wire in"}
          </button>
        )}
        {tone === "cloud" && e.alias && e.consoleWired && !isActive && onUnwire && (
          <button
            onClick={() => onUnwire(e)}
            disabled={!!busy}
            className="text-[10px] text-gray-600 hover:text-red-400 border border-gray-800 hover:border-red-500/40 rounded px-1.5 py-1 transition disabled:opacity-40 cursor-pointer"
          >
            Remove
          </button>
        )}

        {(e.rungs?.length || e.note || e.docs) && (
          <button
            onClick={() => setOpen((v) => !v)}
            className="ml-auto inline-flex items-center gap-0.5 text-[10px] text-gray-600 hover:text-gray-300 cursor-pointer"
          >
            {open ? "less" : "more"}
            <CaretDown size={10} weight="bold" className={open ? "rotate-180 transition" : "transition"} />
          </button>
        )}
      </div>

      {open && (
        <div className="mt-2 pt-2 border-t border-gray-800/70 space-y-1.5">
          {e.note && <p className="text-[10px] text-gray-500 leading-relaxed">{e.note}</p>}
          {/* Every quantisation, so "fits at 4-bit" can be checked against what
              bf16 would have cost rather than taken on trust. */}
          {e.rungs && e.rungs.length > 0 && (
            <div className="space-y-0.5">
              <p className="text-[9px] uppercase tracking-wide text-gray-600">Quantisation ladder</p>
              {e.rungs.map((r) => (
                <div key={r.precision} className="flex items-center gap-2 text-[10px] tabular-nums" title={r.note}>
                  <span className="w-16 text-gray-400">{r.label}</span>
                  <span className="w-16 text-gray-500">{fmtGb(r.requirement.vramGb)}</span>
                  <span className={VERDICT_TEXT[r.fit.verdict] ?? "text-gray-600"}>{r.fit.verdict}</span>
                </div>
              ))}
              {e.fit?.basis && <p className="text-[9px] text-gray-600 leading-relaxed mt-1">{e.fit.basis}</p>}
            </div>
          )}
          {e.docs && (
            <a
              href={e.docs}
              target="_blank"
              rel="noreferrer"
              className="text-[10px] text-indigo-400 hover:text-indigo-300 underline underline-offset-2"
            >
              docs ↗
            </a>
          )}
        </div>
      )}
    </article>
  );
}

/**
 * Download needs a repo, and a leaderboard id is not one.
 *
 * "qwen3.8-27b" has to become "Qwen/Qwen3.8-27B" — and usually the interesting
 * repo is a sibling (-FP8, -AWQ, -GGUF) that is a third the size. So the button
 * resolves first and shows what it found, with real byte counts, before anything
 * is pulled. A 55 GB download is not something to start on a guess.
 */
function DownloadButton({
  entry,
  busy,
  onDownload,
}: {
  entry: Entry;
  busy: string | null;
  onDownload: (repo: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [res, setRes] = useState<{
    primary?: { repo: string; gb: number; quant?: string; gated: boolean; installed: boolean; downloads: number };
    variants: { repo: string; gb: number; quant?: string; gated: boolean; installed: boolean; downloads: number }[];
    error?: string;
  } | null>(null);

  const resolve = async () => {
    setOpen(true);
    if (res || loading) return;
    setLoading(true);
    try {
      const r = await fetch(`/api/scout?resolve=${encodeURIComponent(entry.name)}`).then((x) => x.json());
      setRes(r);
    } catch (err) {
      setRes({ variants: [], error: err instanceof Error ? err.message : String(err) });
    }
    setLoading(false);
  };

  const options = res ? [res.primary, ...res.variants].filter(Boolean).slice(0, 6) : [];

  return (
    <span className="relative">
      <button
        onClick={() => (open ? setOpen(false) : resolve())}
        className="inline-flex items-center gap-1 text-[10px] text-sky-300 hover:text-sky-200 border border-sky-500/30 hover:border-sky-400/60 rounded px-1.5 py-1 transition cursor-pointer"
      >
        <CloudArrowDown size={11} weight="bold" />
        Download
      </button>
      {open && (
        <div className="absolute z-20 left-0 mt-1 w-80 rounded-lg border border-gray-700 bg-gray-950 shadow-xl p-2 space-y-1">
          {loading && <p className="text-[10px] text-gray-500 px-1 py-2">Finding it on the Hub…</p>}
          {res?.error && <p className="text-[10px] text-red-400 px-1 py-2">{res.error}</p>}
          {options.map((v) => (
            <button
              key={v!.repo}
              disabled={v!.installed || !!busy}
              onClick={() => {
                onDownload(v!.repo);
                setOpen(false);
              }}
              className="w-full text-left rounded px-1.5 py-1.5 hover:bg-gray-900 disabled:opacity-45 disabled:hover:bg-transparent cursor-pointer disabled:cursor-default"
            >
              <span className="flex items-center gap-1.5">
                <span className="text-[10px] font-mono text-gray-200 truncate">{v!.repo}</span>
                {v!.quant && (
                  <span className="text-[9px] px-1 rounded bg-gray-800 text-gray-400 shrink-0">{v!.quant}</span>
                )}
                {v!.installed && <span className="text-[9px] text-emerald-400 shrink-0">have it</span>}
                {v!.gated && <span className="text-[9px] text-amber-400 shrink-0">gated</span>}
              </span>
              <span className="text-[9px] text-gray-500 tabular-nums">
                {v!.gb ? `${v!.gb} GB` : "size unknown"} · {v!.downloads.toLocaleString()} downloads
              </span>
            </button>
          ))}
          {res && options.length === 0 && !res.error && (
            <p className="text-[10px] text-gray-500 px-1 py-2">No repo found for this name.</p>
          )}
        </div>
      )}
    </span>
  );
}

function Stat({ label, value, cls, title }: { label: string; value: string; cls?: string; title?: string }) {
  return (
    <span className="flex items-baseline gap-1" title={title}>
      <span className="text-gray-600">{label}</span>
      <span className={cls ?? "text-gray-300"}>{value}</span>
    </span>
  );
}

function Bench({ label, v }: { label: string; v: number }) {
  return (
    <span className="flex items-center gap-1">
      <span className="text-gray-600">{label}</span>
      <span className="inline-block w-8 h-1 rounded-full bg-gray-800 overflow-hidden align-middle">
        <span className="block h-full bg-gray-500" style={{ width: `${Math.round(v * 100)}%` }} />
      </span>
      <span className="text-gray-400">{pct(v)}</span>
    </span>
  );
}
