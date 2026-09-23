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
import type { CatalogModel, Entry, EntryStatus, HostBest, Machine, Occupant, Payload, Sort, SortKey } from "./models-page.types";
import { fmtGb, fmtParams } from "./models-page.types";

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
  missing: { label: "not installed", cls: "bg-red-500/10 text-red-400/90 border-red-500/25" },
  "wont-fit": { label: "won't fit", cls: "bg-red-500/10 text-red-400/90 border-red-500/25" },
};

const VERDICT_TEXT: Record<string, string> = {
  fits: "text-emerald-400",
  tight: "text-amber-300",
  swap: "text-sky-300",
  no: "text-red-400",
  "off-box": "text-gray-500",
};

/** Plain words for a verdict, for the places that have no room for a sentence. */
const VERDICT_WORD: Record<string, string> = {
  fits: "fits",
  tight: "fits alone",
  swap: "needs a swap",
  no: "won't fit",
  "off-box": "off-box",
};

/**
 * Why another machine's answer is a weaker claim than this one's, said in full
 * on hover rather than asserted in four characters.
 *
 * Numbers for a host the console is not running on come from its declared
 * profile: idle, nothing else loaded, free disk unknown. That is a real answer
 * and a different kind of answer, and the difference should not need reading
 * the source to discover.
 */
function hostVerdictTitle(h: HostBest): string {
  const at = h.label ? ` at ${h.label}` : "";
  const mem = h.vramGb ? `, needing ${fmtGb(h.vramGb)}` : "";
  return `On ${h.hostName}: ${VERDICT_WORD[h.verdict] ?? h.verdict}${at}${mem}. From ${h.hostName}'s declared specs — an idle machine with unknown free disk, not a live reading.`;
}

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
  machines,
  onRefresh,
}: {
  machine: Machine;
  occupants: Occupant[];
  leaderboard: Payload["leaderboard"];
  /** Every configured host. Live first; the rest are declared, not measured. */
  machines?: Payload["machines"];
  onRefresh: () => void;
}) {
  const [spinning, setSpinning] = useState(false);
  const usedVram = occupants.reduce((a, o) => a + o.vramGb, 0);
  const usedRam = machine.ramTotalGb - machine.ramFreeGb;
  const diskUsed = machine.weightsDiskTotalGb
    ? machine.weightsDiskTotalGb - machine.weightsDiskFreeGb
    : undefined;
  const others = (machines ?? []).filter((m) => !m.live);
  const countFor = (hostId: string) =>
    leaderboard.runnableByHost?.find((r) => r.hostId === hostId)?.runnable;

  return (
    <section className="tool-panel bg-gray-900 rounded-xl border border-gray-800 p-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Cpu size={16} weight="duotone" className="text-indigo-400" />
        <span className="text-sm font-semibold text-gray-100">{machine.gpuName}</span>
        <span className="text-[11px] text-gray-500">
          {/* "run here" was a complete sentence with one box and is not with
              two. The meters below are still this machine's alone — they are
              live readings, and there is no telemetry from the other host. */}
          {leaderboard.runnable} of {leaderboard.openWeights.length} open-weights models on llm-stats run
          {others.length ? " on this one" : " here"}
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

      {/* The other machines get a line, not a meter row. A meter implies a live
          reading, and there is none from a box this process is not on — these
          are the specs in config/hosts and a count derived from them. */}
      {others.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap border-t border-gray-800 pt-2.5">
          <span className="text-[9px] uppercase tracking-wide text-gray-600">Also yours</span>
          {others.map((m) => {
            const n = countFor(m.hostId);
            const pool =
              m.machine.memoryModel === "unified"
                ? `${m.machine.ramTotalGb} GB unified`
                : `${m.machine.vramTotalGb} GB VRAM · ${m.machine.ramTotalGb} GB RAM`;
            return (
              <span
                key={m.hostId}
                className="inline-flex items-center gap-1.5 text-[11px] text-gray-400 rounded-md border border-gray-800 px-2 py-1"
                title={m.machine.vramBasis ?? `${m.hostName}, declared in config/hosts/${m.hostId}.json.`}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-gray-600 shrink-0" />
                <span className="text-gray-300">{m.hostName}</span>
                <span className="text-gray-600">{pool}</span>
                {n != null && <span className="text-gray-500 tabular-nums">· {n} run there</span>}
              </span>
            );
          })}
          <span className="text-[10px] text-gray-600">declared, not measured</span>
        </div>
      )}
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

type HubVariant = {
  repo: string;
  gb: number;
  quant?: string;
  gated: boolean;
  installed: boolean;
  downloads: number;
  runtimes?: string[];
  setup?: {
    kind: "ollama-gguf" | "ollama-safetensors";
    runtime: "Ollama";
    model: string;
    file?: string;
    gb: number;
    experimental: boolean;
    note: string;
  };
  setupReason?: string;
};

/**
 * Direct model discovery for people who arrive with either a capability in mind
 * or a model name copied from somewhere else.
 *
 * The curated rows below remain the safer recommendations because Hangar can
 * calculate their runtime footprint. This search deliberately shows only facts
 * the Hub reports — repo size, popularity, gate, and format — and never claims
 * an arbitrary checkpoint will run merely because it fits on disk.
 */
export function HubModelSearch({
  busy,
  diskFreeGb,
  initialQuery = "",
  downloads,
  onDownload,
  onInstall,
  onCancel,
}: {
  busy: string | null;
  diskFreeGb: number;
  initialQuery?: string;
  downloads: Payload["downloads"];
  onDownload: (repo: string) => void;
  onInstall: (repo: string, file?: string) => void;
  onCancel: (repo: string) => void;
}) {
  const [open, setOpen] = useState(Boolean(initialQuery));
  const [query, setQuery] = useState(initialQuery);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState("");
  const [result, setResult] = useState<{ primary?: HubVariant; variants: HubVariant[]; error?: string } | null>(null);

  const search = async () => {
    const value = query.trim();
    if (!value || loading) return;
    setLoading(true);
    setSearched(value);
    setResult(null);
    try {
      const response = await fetch(`/api/scout?resolve=${encodeURIComponent(value)}`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok || body.error) throw new Error(body.error || `Hub search returned ${response.status}`);
      setResult(body);
    } catch (cause) {
      setResult({ variants: [], error: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setLoading(false);
    }
  };

  const options = result ? [result.primary, ...result.variants].filter((item): item is HubVariant => Boolean(item)).slice(0, 8) : [];

  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="group rounded-xl border border-gray-800 bg-gray-900/70"
    >
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 marker:hidden">
        <span className="rounded-lg border border-sky-500/20 bg-sky-500/10 p-2 text-sky-300">
          <MagnifyingGlass size={16} weight="bold" />
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-gray-100">Search the Hugging Face model library</span>
          <span className="block text-[11px] text-gray-500">Already know a model name? Find the real repository, compare variants, and download it here.</span>
        </span>
        <CaretDown size={14} className="ml-auto shrink-0 text-gray-500 transition group-open:rotate-180" />
      </summary>
      <div className="border-t border-gray-800 p-4">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void search();
          }}
          className="flex flex-col gap-2 sm:flex-row"
        >
          <label className="relative min-w-0 flex-1">
            <MagnifyingGlass size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-600" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Try Qwen image, Gemma, Whisper, or owner/repository"
              aria-label="Search Hugging Face models"
              className="h-10 w-full rounded-lg border border-gray-700 bg-gray-950 pl-9 pr-3 text-sm text-gray-100 outline-none transition placeholder:text-gray-600 focus:border-sky-500/60"
            />
          </label>
          <button
            type="submit"
            disabled={!query.trim() || loading}
            className="h-10 rounded-lg bg-sky-500 px-4 text-sm font-semibold text-white transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {loading ? "Searching…" : "Find models"}
          </button>
        </form>

        {!result && !loading && (
          <p className="mt-2 text-[10px] leading-5 text-gray-600">
            Nothing downloads until you choose a repository. Hangar shows its reported size first; curated recommendations below also include a hardware-fit estimate.
          </p>
        )}
        {result?.error && <p role="alert" className="mt-3 text-xs text-red-300">{result.error}</p>}
        {result && !result.error && options.length === 0 && (
          <p className="mt-3 text-xs text-gray-500">No repositories matched “{searched}”. Try the model family or an exact owner/repository name.</p>
        )}
        {options.length > 0 && (
          <div className="mt-4 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-gray-500">Best matches for {searched}</p>
              <p className="text-[10px] text-gray-600">{diskFreeGb.toFixed(1)} GB free on weights drive</p>
            </div>
            <div className="grid gap-2 lg:grid-cols-2">
              {options.map((variant) => {
                const transferGb = variant.setup?.gb || variant.gb;
                const tooLarge = transferGb > 0 && transferGb > diskFreeGb;
                const job = downloads.find((download) => download.repo === variant.repo);
                const installing = job?.status === "running";
                const runtimeReady = job?.status === "done" && job.kind === "runtime-install";
                return (
                  <article key={variant.repo} className="rounded-xl border border-gray-800 bg-gray-950/45 p-3">
                    <div className="flex min-w-0 items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-mono text-xs font-medium text-gray-200" title={variant.repo}>{variant.repo}</p>
                        <p className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-[10px] text-gray-500">
                          <span>{variant.gb ? `${variant.gb} GB` : "size unknown"}</span>
                          <span>{variant.downloads.toLocaleString()} downloads</span>
                          {variant.quant && <span className="text-sky-300">{variant.quant}</span>}
                          {variant.runtimes?.length ? <span>{variant.runtimes.join(" · ")}</span> : null}
                          {variant.gated && <span className="text-amber-300">access required</span>}
                        </p>
                        {variant.setup ? (
                          <p className="mt-1 text-[10px] text-emerald-300/80">
                            {variant.setup.experimental ? "Experimental " : ""}{variant.setup.runtime} setup · {variant.setup.gb || "?"} GB transfer
                            {variant.setup.file ? ` · ${variant.setup.file}` : ""}
                          </p>
                        ) : (
                          <p className="mt-1 text-[10px] text-amber-300/70" title={variant.setupReason}>Weights only · no automatic runtime</p>
                        )}
                      </div>
                      {runtimeReady ? (
                        <span className="shrink-0 rounded-md bg-emerald-500/10 px-2 py-1 text-[10px] font-medium text-emerald-300">Ready in Ollama</span>
                      ) : variant.setup ? (
                        <button
                          type="button"
                          onClick={() => installing ? onCancel(variant.repo) : onInstall(variant.repo, variant.setup?.file)}
                          disabled={Boolean(busy) || (!installing && tooLarge)}
                          title={
                            installing
                              ? "Stop this install. Downloaded cache files are kept so a retry can resume."
                              : tooLarge
                              ? `Needs ${transferGb} GB, but only ${diskFreeGb.toFixed(1)} GB is free.`
                              : variant.setup.note
                          }
                          className={`inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[10px] font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-40 ${installing ? "bg-red-500 hover:bg-red-400" : "bg-emerald-500 hover:bg-emerald-400"}`}
                        >
                          <CloudArrowDown size={12} weight="bold" />
                          {installing ? `Cancel${job?.percent != null ? ` · ${job.percent}%` : " install"}` : tooLarge ? "Not enough disk" : variant.installed ? "Add to Ollama" : "Install with Ollama"}
                        </button>
                      ) : variant.installed ? (
                        <span className="shrink-0 rounded-md bg-sky-500/10 px-2 py-1 text-[10px] font-medium text-sky-300">Weights downloaded</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => onDownload(variant.repo)}
                          disabled={Boolean(busy) || tooLarge}
                          title={tooLarge ? `Needs ${variant.gb} GB, but only ${diskFreeGb.toFixed(1)} GB is free.` : `Download ${variant.repo}`}
                          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-sky-500/30 px-2.5 py-1.5 text-[10px] font-semibold text-sky-200 transition hover:border-sky-400/60 hover:bg-sky-500/10 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <CloudArrowDown size={12} weight="bold" />
                          {tooLarge ? "Not enough disk" : "Download"}
                        </button>
                      )}
                    </div>
                    {runtimeReady && (
                      <p className="mt-2 text-[10px] text-emerald-300/80">It now appears in the local models below. Choose “Use for text” there to make it active.</p>
                    )}
                    {job?.status === "failed" && job.kind === "runtime-install" && (
                      <p className="mt-2 text-[10px] text-red-300" title={job.detail}>Runtime setup failed. Review the model format or retry the install.</p>
                    )}
                  </article>
                );
              })}
            </div>
            <p className="text-[10px] leading-5 text-gray-600">
              “Install with Ollama” downloads only the planned artifact and registers a runnable local model. “Download” stores weights for a manual runtime; Hangar does not claim those are runnable yet.
            </p>
          </div>
        )}
      </div>
    </details>
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
  otherHosts,
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
  /** Names of the other configured machines, for a chip that tells the truth. */
  otherHosts: string[];
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
        // With a second machine configured this can no longer say "this GPU":
        // keeping a row that B5 runs is the whole point, so the chip has to
        // describe the fleet rather than the box serving the page.
        title={
          otherHosts.length
            ? `Hide anything none of your machines can run at any quantisation, down to 2-bit. Includes ${otherHosts.join(" and ")}.`
            : "Hide anything this card cannot run at any quantisation, down to 2-bit."
        }
        className={`ui-chip inline-flex items-center gap-1.5 text-[11px] rounded-md px-2.5 py-1.5 border transition cursor-pointer ${runsHere ? "is-on" : ""}`}
      >
        <Cpu size={12} weight="duotone" />
        {otherHosts.length ? "Fits a machine I have" : "Fits this GPU"}
      </button>

      {capability && (
        <button
          onClick={onClearCapability}
          className="ui-chip is-on inline-flex items-center gap-1 text-[11px] rounded-md px-2 py-1.5 border cursor-pointer"
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
          className="ui-chip is-on ml-auto inline-flex items-center gap-1.5 text-[11px] border rounded-md px-2.5 py-1.5 transition disabled:opacity-50 cursor-pointer"
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
      {/* "Local" / "Cloud", not "On this machine" — that phrasing collided with
          the "Fits this GPU" filter beside it and read as two controls for the
          same thing. These pick WHERE a model runs; the filter picks whether it
          CAN run here. */}
      {([
        ["local", "Local", localCount],
        ["cloud", "Cloud", cloudCount],
      ] as const).map(([id, label, count]) => (
        <button
          key={id}
          role="tab"
          aria-selected={lane === id}
          onClick={() => onLane(id)}
          className={`ui-chip inline-flex items-center gap-1.5 text-[11px] px-3 py-1.5 rounded-md transition cursor-pointer border-0 ${
            lane === id ? "is-on" : ""
          }`}
        >
          {label}
          <span className="ui-count tabular-nums text-[10px] px-1.5 rounded-full">
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
          className={`ui-chip inline-flex items-center gap-1 text-[10px] px-2 py-1 rounded transition cursor-pointer border-0 ${
            view === id ? "is-on" : ""
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
      { key: "size", label: "Size", align: "right", render: (e) => fmtParams(e.paramsB) },
      {
        key: "default",
        label: "Runs at",
        // Two machines, so two answers — but only when they differ, which the
        // server decides by sending `elsewhere` at all. Stacked in one cell
        // rather than given a column of its own: an extra column would be
        // blank on most rows and would cost the whole table the width, and
        // the point is the comparison, which wants the answers adjacent.
        render: (e) => (
          <>
            {e.quant ? (
              <span className={VERDICT_TEXT[e.verdict ?? ""] ?? "text-gray-400"}>{e.quant}</span>
            ) : e.measured ? (
              <span className="text-gray-500">installed</span>
            ) : e.fit && e.kind === "local" ? (
              // A scout pick has a sourced requirement, not a ladder — there is
              // no rung to name, so the cell carries the verdict itself rather
              // than a dash that reads as "unknown".
              <span className={VERDICT_TEXT[e.verdict ?? ""] ?? "text-gray-400"}>
                {VERDICT_WORD[e.verdict ?? ""] ?? "—"}
              </span>
            ) : (
              <span className="text-gray-600">—</span>
            )}
            {e.elsewhere?.map((h) => (
              <div key={h.hostId} className="text-[10px] leading-tight truncate" title={hostVerdictTitle(h)}>
                <span className="text-gray-600">{h.hostName}: </span>
                <span className={VERDICT_TEXT[h.verdict] ?? "text-gray-500"}>
                  {h.verdict === "no" ? "won't fit" : (h.label ?? VERDICT_WORD[h.verdict])}
                </span>
              </div>
            ))}
          </>
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
                      {/* The one row type on this page that is an argument
                          rather than a measurement. Marked so it reads as one. */}
                      {e.why && (
                        <span
                          className="text-[9px] px-1 rounded-full bg-indigo-500/20 text-indigo-200 shrink-0"
                          title="Picked by the weekly scout report — open for the argument."
                        >
                          scout
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
  missing: "bg-red-500/70",
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
  reportDate,
  reportStale,
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
  /** When the scout report was written, so its opinion can be dated. */
  reportDate?: string;
  reportStale?: boolean;
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

  /**
   * A fixed side drawer, at every width.
   *
   * This was a grid column that only existed at the `xl` breakpoint, so on any
   * narrower window it fell BELOW the table — click a row and the detail
   * appeared off-screen underneath a hundred models. A side panel has to be a
   * side panel unconditionally; there is no width at which "somewhere down the
   * page" is the right answer to clicking a row.
   */
  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="false" aria-label={`${e.name} details`}>
      <button
        aria-label="Close details"
        onClick={onClose}
        className="absolute inset-0 bg-black/40 backdrop-blur-[1px] cursor-default"
      />
      <aside
        className="models-drawer relative z-10 h-full w-full max-w-[26rem] overflow-y-auto border-l border-gray-800 bg-gray-900 p-4 space-y-3 shadow-2xl"
        onKeyDown={(ev) => ev.key === "Escape" && onClose()}
      >
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
              disabled={!!busy || e.status === "no-key" || e.status === "missing"}
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

      {/* Judgment, not telemetry — and dated, because it ages differently from
          everything else on this panel. Given its own frame so it is never
          mistaken for something the machine reported. */}
      {e.why && (
        <div className="rounded-md border border-indigo-500/25 bg-indigo-500/[0.06] p-2.5 space-y-1">
          <p className="text-[9px] uppercase tracking-wide text-indigo-300/80">
            Why the scout picked this{reportDate ? ` · ${reportDate}` : ""}
            {reportStale ? " · stale" : ""}
          </p>
          <p className="text-[10px] text-gray-300 leading-relaxed">{e.why}</p>
          {(e.license || e.paper) && (
            <p className="text-[9px] text-gray-500">
              {e.license && <span>Licence {e.license}</span>}
              {e.license && e.paper && <span> · </span>}
              {e.paper && (
                <a href={e.paper} target="_blank" rel="noreferrer" className="hover:text-gray-300 underline">
                  paper
                </a>
              )}
            </p>
          )}
        </div>
      )}

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

      {/* The other machines, when they disagree. Shown after this one's verdict
          rather than beside it, because they are a weaker claim and the
          ordering should say so before the numbers do. */}
      {e.elsewhere && e.elsewhere.length > 0 && (
        <div className="space-y-1 border-l-2 border-gray-800 pl-2.5">
          <p className="text-[9px] uppercase tracking-wide text-gray-600">On your other machines</p>
          {e.elsewhere.map((h) => (
            <p key={h.hostId} className="text-[10px] leading-relaxed">
              <span className="text-gray-400">{h.hostName}</span>{" "}
              <span className={VERDICT_TEXT[h.verdict] ?? "text-gray-500"}>
                {VERDICT_WORD[h.verdict] ?? h.verdict}
              </span>
              {h.label && <span className="text-gray-500"> at {h.label}</span>}
              {h.vramGb ? <span className="text-gray-600"> · {fmtGb(h.vramGb)}</span> : null}
            </p>
          ))}
          <p className="text-[9px] text-gray-600 leading-relaxed">
            From each host&apos;s declared specs in config/hosts — an idle machine with nothing else
            loaded and free disk unknown, so this answers &ldquo;would it fit there&rdquo; and not
            &ldquo;would it fit there right now&rdquo;. Only machines that disagree with this one are listed.
          </p>
        </div>
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
        {e.paramsB != null && <Row k="Parameters" v={fmtParams(e.paramsB)} />}
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
    </div>
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
            {e.paramsB != null && <Stat label="size" value={fmtParams(e.paramsB)} />}
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
                disabled={!!busy || e.status === "no-key" || e.status === "missing"}
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
