"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FlaskConical } from "lucide-react";
import { ToolPageHeader } from "@/components/tool-page";
import ModelFootprint from "@/components/model-footprint";
import ModelDiscovery from "@/components/model-discovery";
import CapacityBlocker from "@/components/capacity-blocker";
import Markdown from "@/components/markdown";
import { ServiceControl } from "@/components/service-control";
import RecentRuns, { fmtCost, fmtLatency } from "@/components/labs/recent-runs";
import { CAPABILITY_LABELS } from "@/lib/capabilities";
import { getHost } from "@/lib/host";
import type { LabDefinition } from "@/lib/labs";
import type { LabModel, LabModelsPayload, LabRunResult } from "@/lib/lab-types";

/**
 * The Lab contract, implemented once.
 *
 * Every Lab gets from here: the models for its capability on THIS host with
 * footprint, licence, status and inline Start; a Run button; a local column and
 * an optional cloud column for the same input; latency, VRAM and cost per run;
 * the recent runs from the runs record; and the experiment doc. A Lab supplies
 * only its input controls, how to run one model, and how to draw one output.
 */

type RunCtx = { compareGroup: string; signal: AbortSignal };

type Slot<T> = { model: string; local: boolean; state: "running" | "done"; result?: LabRunResult<T> };

export default function LabShell<T>({
  lab,
  input,
  canRun,
  run,
  renderOutput,
  toolbar,
  below,
}: {
  lab: LabDefinition;
  /** The capability's own input controls. The Lab owns their state. */
  input: ReactNode;
  canRun: boolean;
  /** Run one model on the current input. Should resolve, not throw, on a model failure. */
  run: (model: LabModel, ctx: RunCtx) => Promise<LabRunResult<T>>;
  renderOutput: (result: LabRunResult<T>) => ReactNode;
  /**
   * Lab-level controls shown above the model list — for a Lab whose choice (the
   * 3D Lab's Object / Person) changes which capability, and so which models,
   * the shell lists.
   */
  toolbar?: ReactNode;
  /**
   * Optional panel between the results and the runs record — for Labs whose
   * runs outlive the request, like the Video Lab's queue.
   */
  below?: ReactNode;
}) {
  const [payload, setPayload] = useState<LabModelsPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [localId, setLocalId] = useState<string>("");
  const [compare, setCompare] = useState(false);
  const [cloudId, setCloudId] = useState<string>("");
  const [slots, setSlots] = useState<Slot<T>[]>([]);
  // Bumped when a run finishes, so the runs record re-reads itself.
  const [runsVersion, setRunsVersion] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async (): Promise<LabModelsPayload | null> => {
    try {
      const q = new URLSearchParams({ capability: lab.capability });
      if (lab.compareCapability) q.set("compare", lab.compareCapability);
      const r = await fetch(`/api/labs/models?${q}`, { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error ?? `HTTP ${r.status}`);
      setPayload(j);
      setLoadError(null);
      return j as LabModelsPayload;
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, [lab.capability, lab.compareCapability]);

  useEffect(() => {
    void load();
    const iv = setInterval(() => {
      if (!document.hidden) void load();
    }, 15_000);
    return () => clearInterval(iv);
  }, [load]);

  // A compareCapability model (an LLM beside a decision model) is only ever a
  // comparison target, even when it runs locally.
  const locals = useMemo(() => payload?.models.filter((m) => m.local && !m.compare) ?? [], [payload]);
  const clouds = useMemo(() => payload?.models.filter((m) => !m.local || m.compare) ?? [], [payload]);

  // Default picks: the first ready local model; for the cloud column, the
  // model this capability is routed to when that is a cloud one (what you would
  // otherwise be using), else the cheapest ready one — never an arbitrary
  // first-alphabetically model at $30/Mtok.
  useEffect(() => {
    if (!localId && locals.length) setLocalId((locals.find((m) => m.status === "ready") ?? locals[0]).id);
    if (!cloudId && clouds.length) {
      const ready = clouds.filter((m) => m.status === "ready");
      const routed = ready.find((m) => m.id === payload?.routed);
      const cheapest = [...ready]
        .filter((m) => m.costPerMTokOut != null)
        .sort((a, b) => (a.costPerMTokOut ?? 0) - (b.costPerMTokOut ?? 0))[0];
      setCloudId((routed ?? cheapest ?? ready[0] ?? clouds[0]).id);
    }
  }, [locals, clouds, localId, cloudId, payload?.routed]);

  const chosenLocal = locals.find((m) => m.id === localId);
  const chosenCloud = clouds.find((m) => m.id === cloudId);
  const targets = [
    ...(chosenLocal ? [chosenLocal] : []),
    ...(compare && lab.cloudComparison && chosenCloud ? [chosenCloud] : []),
  ];
  const running = slots.some((s) => s.state === "running");
  const notReady = targets.find((m) => m.status !== "ready");
  const blockedReason = !targets.length
    ? "Pick a model first."
    : notReady
      ? `${notReady.id} is not ready — ${notReady.detail ?? "start it first."}`
      : null;

  const go = async () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    const compareGroup = targets.length > 1 ? crypto.randomUUID() : "";
    setSlots(targets.map((m) => ({ model: m.id, local: m.local, state: "running" })));
    // One request per model, so each column lands when it is done — the Arena's
    // lesson: a combined request shows nothing until the slowest model returns.
    await Promise.all(
      targets.map(async (m, i) => {
        let result: LabRunResult<T>;
        try {
          result = await run(m, { compareGroup, signal: ac.signal });
        } catch (e) {
          result = { ok: false, model: m.id, local: m.local, error: e instanceof Error ? e.message : String(e) };
        }
        setSlots((prev) => prev.map((s, j) => (j === i ? { ...s, state: "done", result } : s)));
      }),
    );
    setRunsVersion((v) => v + 1);
    void load();
  };

  const capLabel = CAPABILITY_LABELS[lab.capability];
  const hostName = payload?.host.name ?? "this machine";

  return (
    <div className="space-y-5">
      <ToolPageHeader
        eyebrow="Lab"
        title={lab.label}
        description={lab.hint}
        icon={<FlaskConical className="h-5 w-5" />}
        meta={
          <span className="rounded-full border border-gray-700 px-2 py-0.5 text-[11px] text-gray-400">
            {capLabel} · {hostName}
          </span>
        }
      />

      {loadError && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-300">
          Could not list models: {loadError}
        </p>
      )}

      {toolbar}

      {/* ── models on this host ── */}
      <section className="rounded-xl border border-gray-800 bg-gray-900/40">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-800 px-4 py-2.5">
          <h2 className="text-sm font-medium text-gray-200">Local models on {hostName}</h2>
          {payload && !payload.routerUp && locals.some((m) => m.source === "router") && (
            <span className="flex items-center gap-2 text-[11px] text-amber-300">
              AI Router is down — nothing can be called through it.
              <ServiceControl id="ai-router" up={false} probe={async () => !!(await load())?.routerUp} showLogs={false} />
            </span>
          )}
        </div>
        {!payload ? (
          <p className="px-4 py-6 text-xs text-gray-500">Loading…</p>
        ) : locals.length === 0 ? (
          <div className="space-y-3 px-4 py-4">
            <p className="text-sm text-gray-300">
              Nothing on {hostName} serves {capLabel}.
            </p>
            <p className="text-xs text-gray-500">
              A service declares it with <code className="rounded bg-gray-800 px-1">serves: {`{ "${lab.capability}": "<model>" }`}</code> in{" "}
              <code className="rounded bg-gray-800 px-1">config/hosts/{payload.host.id}.json</code>, with a start command in{" "}
              <code className="rounded bg-gray-800 px-1">scripts/{getHost().commandsFile}</code>.
            </p>
            {/* What would fit here, per the model scout, with a verdict for this machine. */}
            <ModelDiscovery
              capability={lab.capability}
              label={capLabel}
              defaultOpen
              empty={
                <p className="text-xs text-gray-500">
                  The model scout has no {capLabel} candidates yet, so there is no fit verdict to show. Candidates come from its
                  weekly report, <code className="rounded bg-gray-800 px-1">config/model-scout.json</code> (rules in{" "}
                  <code className="rounded bg-gray-800 px-1">docs/models.md</code>).
                </p>
              }
            />
          </div>
        ) : (
          <ul className="divide-y divide-gray-800/70">
            {locals.map((m) => (
              <ModelRow key={m.id} model={m} selected={m.id === localId} onSelect={() => setLocalId(m.id)} probe={load} />
            ))}
          </ul>
        )}
      </section>

      {/* ── input + run ── */}
      <section className="space-y-3 rounded-xl border border-gray-800 bg-gray-900/40 p-4">
        {input}
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={go}
            disabled={running || !canRun || !!blockedReason}
            className="rounded-lg bg-orange-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-orange-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {running ? "Running…" : targets.length > 1 ? "Run both" : "Run"}
          </button>
          {running && (
            <button type="button" onClick={() => abortRef.current?.abort()} className="text-xs text-gray-400 hover:text-gray-200">
              Cancel
            </button>
          )}
          {lab.cloudComparison && (
            <label className="flex items-center gap-2 text-xs text-gray-400">
              <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} className="accent-orange-500" />
              {lab.compareCapability
                ? `Same input on a ${CAPABILITY_LABELS[lab.compareCapability]} model`
                : "Same input on a cloud model"}
              {compare && (
                <select
                  value={cloudId}
                  onChange={(e) => setCloudId(e.target.value)}
                  className="rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-xs text-gray-200"
                  aria-label="Cloud model to compare against"
                >
                  {clouds.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id}
                      {m.local ? " (local)" : ""}
                      {m.status !== "ready" ? " (not ready)" : ""}
                      {m.costPerMTokIn != null ? ` · $${m.costPerMTokIn.toFixed(2)}/$${(m.costPerMTokOut ?? 0).toFixed(2)} per Mtok` : ""}
                    </option>
                  ))}
                </select>
              )}
            </label>
          )}
          {blockedReason && canRun && <span className="text-xs text-amber-300">{blockedReason}</span>}
        </div>
      </section>

      {/* ── results ── */}
      {slots.length > 0 && (
        <section className={`grid gap-4 ${slots.length > 1 ? "lg:grid-cols-2" : ""}`}>
          {slots.map((s, i) => (
            <ResultColumn key={`${s.model}-${i}`} slot={s} renderOutput={renderOutput} onReleased={load} />
          ))}
        </section>
      )}

      {below}

      {/* ── runs record ── */}
      <RecentRuns lab={lab.id} refreshKey={runsVersion} />

      <ExperimentDoc path={lab.doc} />
    </div>
  );
}

function ModelRow({
  model: m,
  selected,
  onSelect,
  probe,
}: {
  model: LabModel;
  selected: boolean;
  onSelect: () => void;
  probe: () => Promise<LabModelsPayload | null>;
}) {
  const ready = m.status === "ready";
  return (
    <li className={`flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 ${selected ? "bg-orange-500/[0.05]" : ""}`}>
      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5">
        <input type="radio" name="lab-model" checked={selected} onChange={onSelect} className="accent-orange-500" />
        <span className={`size-2 shrink-0 rounded-full ${ready ? "bg-emerald-400" : "bg-gray-600"}`} aria-hidden="true" />
        <span className="min-w-0">
          <span className="block truncate text-sm text-gray-100">{m.id}</span>
          <span className="block truncate text-[11px] text-gray-500">
            {[m.params, m.serviceName, m.loaded === true ? "loaded" : m.loaded === false ? "not loaded — loads on first run" : null]
              .filter(Boolean)
              .join(" · ") || "—"}
          </span>
        </span>
      </label>
      <ModelFootprint footprint={m.footprint} local />
      <span
        className={`rounded px-1.5 py-0.5 text-[10px] ${m.license ? "bg-gray-800/70 text-gray-300" : "bg-amber-500/10 text-amber-300"}`}
        title={m.license ? "Weights licence, per the model card" : "No licence declared in config/model-meta.json"}
      >
        {m.license ?? "licence not declared"}
      </span>
      {m.serviceId ? (
        <ServiceControl
          id={m.serviceId}
          up={ready}
          probe={async () => (await probe())?.models.find((x) => x.id === m.id)?.status === "ready"}
          actions={["stop"]}
          name={m.serviceName}
          showLogs={false}
        />
      ) : (
        !ready && <span className="text-[11px] text-amber-300">{m.detail}</span>
      )}
    </li>
  );
}

function ResultColumn<T>({
  slot,
  renderOutput,
  onReleased,
}: {
  slot: Slot<T>;
  renderOutput: (r: LabRunResult<T>) => ReactNode;
  onReleased: () => void;
}) {
  const r = slot.result;
  return (
    <article className="min-w-0 rounded-xl border border-gray-800 bg-gray-900/40">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-gray-800 px-4 py-2.5">
        <span className="text-sm font-medium text-gray-100">{slot.model}</span>
        <span className={`rounded px-1.5 py-0.5 text-[10px] ${slot.local ? "bg-emerald-500/10 text-emerald-300" : "bg-sky-500/10 text-sky-300"}`}>
          {slot.local ? "local" : "cloud"}
        </span>
        {r && (
          <span className="ml-auto flex flex-wrap gap-x-3 text-[11px] tabular-nums text-gray-400">
            <span title="Wall-clock, measured on the server">{fmtLatency(r.latencyMs ?? null)}</span>
            <span title={r.vramNote ?? undefined}>
              {r.peakVramGb != null
                ? `peak ${r.peakVramGb.toFixed(1)} GB${r.baselineVramGb != null ? ` (+${Math.max(0, r.peakVramGb - r.baselineVramGb).toFixed(1)})` : ""}`
                : slot.local
                  ? "VRAM n/a"
                  : "no local VRAM"}
            </span>
            <span>{fmtCost(r.costUsd ?? null, slot.local)}</span>
          </span>
        )}
      </header>
      <div className="p-4">
        {slot.state === "running" ? (
          <p className="text-xs text-gray-500">Running… a cold local model can take a minute or more to load.</p>
        ) : r && !r.ok ? (
          r.resourceBlocked ? (
            <CapacityBlocker message={r.error ?? "Not enough memory."} onReleased={onReleased} />
          ) : (
            <p className="whitespace-pre-wrap text-xs text-red-300">{r.error}</p>
          )
        ) : r ? (
          renderOutput(r)
        ) : null}
        {r?.vramNote && slot.local && <p className="mt-3 text-[10px] text-gray-600">{r.vramNote}</p>}
      </div>
    </article>
  );
}

export function ExperimentDoc({ path }: { path?: string }) {
  const [md, setMd] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (!path) {
    return (
      <p className="text-xs text-gray-600">
        No experiment doc yet. When there is one, set <code>doc</code> on this Lab&apos;s entry in <code>src/lib/labs.ts</code>.
      </p>
    );
  }
  return (
    <details
      className="rounded-xl border border-gray-800 bg-gray-900/40"
      onToggle={(e) => {
        if (!(e.currentTarget as HTMLDetailsElement).open || md || err) return;
        fetch(`/api/labs/doc?path=${encodeURIComponent(path)}`)
          .then((r) => r.json())
          .then((j) => (j.markdown ? setMd(j.markdown) : setErr(j.error ?? "Could not load.")))
          .catch((e) => setErr(String(e)));
      }}
    >
      <summary className="cursor-pointer px-4 py-2.5 text-sm font-medium text-gray-200">
        What we learned <span className="ml-1 text-[11px] font-normal text-gray-500">{path}</span>
      </summary>
      <div className="max-h-[32rem] overflow-y-auto border-t border-gray-800 px-4 py-3">
        {err ? <p className="text-xs text-red-300">{err}</p> : md ? <Markdown>{md}</Markdown> : <p className="text-xs text-gray-500">Loading…</p>}
      </div>
    </details>
  );
}
