"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CatalogModel, Capability } from "@/lib/providers";
import ModelFootprint from "./model-footprint";
import { ServiceControl } from "./service-control";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

const JSON_HEADERS = { "Content-Type": "application/json" };

type CapDef = { id: Capability; label: string; modes: readonly string[]; hint: string };

interface Payload {
  routerUp: boolean;
  /** "config" means the list was read from ai-router.yaml, not a live router. */
  source?: "router" | "config";
  models: CatalogModel[];
  routing: Record<string, string>;
  capabilities: CapDef[];
}

/**
 * Pick the model for ONE capability, with local services managed inline.
 *
 * Shared by every testing tab, but never generic about content: it filters the
 * catalogue by the capability's own `modes`, so the image tab cannot list a chat
 * or voice model even if the router grows one. Adding a capability stays a single
 * entry in CAPABILITIES — this component needs no change.
 *
 * Local vs cloud is a real split, not cosmetic. A local model is a process that
 * has to be running and is competing for one GPU, so it needs status and
 * start/stop. A cloud model is an integration that needs a key. Showing both in
 * one flat list hid which question you were actually answering.
 *
 * Styling note: plain gray-N only, no `dark:` variants — themes.css inverts the
 * gray scale in light mode, so a `bg-white`/`dark:bg-gray-900` pair (what this
 * component shipped with, while it was still unused) renders gray-900 text on
 * white in light mode: invisible. Every other surface in the console follows the
 * same single-scale rule.
 */
export default function ModelPicker({
  capability,
  className = "",
  exclusiveLocal = false,
  compact = false,
}: {
  capability: Capability;
  className?: string;
  /** Local models here cannot co-reside — selecting one stops the others. */
  exclusiveLocal?: boolean;
  /**
   * One row instead of a card: a dropdown for the choice, the live state of
   * whatever is chosen, and its Start. The expanded list is the right shape for
   * a page ABOUT models; on a page where picking one is a prerequisite to the
   * actual work, it pushed the work below the fold.
   */
  compact?: boolean;
}) {
  const [data, setData] = useState<Payload | null>(null);
  const [tab, setTab] = useState<"local" | "cloud" | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<Payload | null> => {
    try {
      const payload: Payload = await fetch("/api/providers", { cache: "no-store" }).then((r) => r.json());
      setData(payload);
      return payload;
    } catch {
      /* transient — the poll will retry */
      return null;
    }
  }, []);

  /** Did this service's models become usable? Drives the shared lifecycle control. */
  const probeService = useCallback(
    async (serviceId: string) =>
      (await load())?.models.some((m) => m.serviceId === serviceId && m.status === "ready") ?? false,
    [load],
  );

  useEffect(() => {
    load();
    const iv = setInterval(load, 6000);
    return () => clearInterval(iv);
  }, [load]);

  const cap = data?.capabilities.find((c) => c.id === capability);

  // The whole point of the capability prop: this tab sees only its own models.
  const eligible = useMemo(
    () => (data && cap ? data.models.filter((m) => cap.modes.includes(m.mode)) : []),
    [data, cap],
  );
  const local = useMemo(() => eligible.filter((m) => m.local), [eligible]);
  const cloud = useMemo(() => eligible.filter((m) => !m.local), [eligible]);
  const active = data?.routing?.[capability];
  const activeModel = eligible.find((m) => m.id === active);

  // Default the toggle to wherever the active model already lives, so opening a
  // tab shows the thing that is actually in use rather than an arbitrary side.
  useEffect(() => {
    if (tab || !activeModel) return;
    setTab(activeModel.local ? "local" : "cloud");
  }, [tab, activeModel]);

  const providers = useMemo(
    () => Array.from(new Set(cloud.map((m) => m.provider))).sort(),
    [cloud],
  );
  useEffect(() => {
    if (provider || !providers.length) return;
    setProvider(activeModel && !activeModel.local ? activeModel.provider : providers[0]);
  }, [provider, providers, activeModel]);

  /** Free the card without stopping the runtime. See /api/ollama/unload. */
  const unload = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      const r = await fetch("/api/ollama/unload", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ model: id }),
      });
      const j = await r.json();
      if (!r.ok) setError(j.error ?? "Could not unload");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
      load();
    }
  };

  /**
   * How many local models sit on the single most-shared runtime. Greater than one
   * means this lane is showing mutually exclusive options, not additive ones.
   */
  const sharedRuntimeCount = (() => {
    const byService = new Map<string, number>();
    for (const m of local) {
      if (!m.serviceId) continue;
      byService.set(m.serviceId, (byService.get(m.serviceId) ?? 0) + 1);
    }
    return Math.max(0, ...byService.values());
  })();

  const select = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      // Capabilities whose local models cannot co-reside (two vLLMs on one 32 GB
      // card) stop the others first — the behaviour LlmPicker had, which would
      // otherwise be lost by replacing it. Speech models are small enough to sit
      // side by side, so that tab leaves this off.
      const picked = eligible.find((m) => m.id === id);
      if (exclusiveLocal && picked?.local) {
        // Never stop a service that also hosts the model being selected. Three
        // Ollama aliases share one `ollama` service, so "stop the others" used to
        // resolve to stopping the runtime behind the model just chosen — the user
        // pressed Use and the thing they picked went down. Models on a SHARED
        // runtime are excluded here and displaced by that runtime instead: Ollama
        // runs one model at a time and evicts the previous on load.
        const others = local.filter(
          (m) => m.id !== id && m.serviceId && m.serviceId !== picked.serviceId && m.status === "ready",
        );
        await Promise.all(
          others.map((m) =>
            fetch(`/api/services/${m.serviceId}`, {
              method: "POST",
              headers: JSON_HEADERS,
              body: JSON.stringify({ action: "stop" }),
            }).catch(() => {}),
          ),
        );
      }
      const r = await fetch("/api/providers", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ [capability]: id }),
      });
      const j = await r.json();
      if (!r.ok) setError(j.error ?? "Could not switch model");
    } finally {
      setBusy(null);
      load();
    }
  };

  if (!data) return <div className={`text-xs text-gray-500 ${className}`}>Loading models…</div>;
  // A dead router used to end the render here, which threw away the catalogue,
  // every service's status and every Start button along with it. It is now one
  // banner above a picker that still works: you can see what exists, see which
  // backing services are warm, start them, and choose what this capability will
  // use — all of which outlives the gateway. Only CALLING a model needs it up.
  const routerDown = !data.routerUp;
  if (routerDown && !eligible.length) {
    return (
      <div className={`flex items-center gap-3 flex-wrap rounded-lg border border-gray-800 bg-gray-900 px-3 py-2 text-xs text-gray-400 ${className}`}>
        <span className="flex-1">
          AI Router is down and <code>config/ai-router.yaml</code> lists no{" "}
          {cap?.label.toLowerCase() ?? capability} model.
        </span>
        <ServiceControl id="ai-router" up={false} probe={async () => !!(await load())?.routerUp} />
      </div>
    );
  }
  if (!routerDown && !eligible.length) {
    return (
      <div className={`rounded-lg border border-gray-800 bg-gray-900 px-3 py-2 text-xs text-gray-400 ${className}`}>
        No {cap?.label ?? capability} models in the router. Add one to <code>config/ai-router.yaml</code>.
      </div>
    );
  }

  const pill = (on: boolean) =>
    `rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
      on ? "bg-gray-100 text-gray-900" : "text-gray-400 hover:text-gray-100"
    }`;

  if (compact) {
    const m = activeModel;
    const serviceUp = m?.status === "ready";
    const onDemand = m?.loaded !== undefined;
    const on = onDemand ? m?.loaded === true : serviceUp;
    const state = !m
      ? "none selected"
      : !m.local
        ? m.status === "no-key"
          ? "needs a key"
          : "cloud"
        : !onDemand
          ? serviceUp ? "running" : "stopped"
          : !serviceUp ? "runtime stopped" : m.loaded ? "loaded" : "ready to load";
    return (
      <div className={className}>
        {routerDown && (
          <div className="mb-2 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-lg border border-amber-500/25 bg-amber-500/10 px-2.5 py-1.5">
            <span className="flex-1 text-[11px] leading-snug text-amber-300">
              <strong className="font-semibold">AI Router is down</strong> — nothing can be called
              until it starts.
            </span>
            <ServiceControl id="ai-router" up={false} probe={async () => !!(await load())?.routerUp} />
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-gray-800 bg-gray-900 px-2.5 py-2">
          {/* The live dot belongs next to the NAME, not in a list far from it —
              "which model, and is it up" is one question. */}
          <span
            className={`size-2 shrink-0 rounded-full ${
              on ? "bg-emerald-400 shadow-[0_0_5px_rgba(52,211,153,0.7)]" : "bg-gray-600"
            }`}
          />
          <Select value={active ?? ""} onValueChange={(v) => v && select(v)}>
            <SelectTrigger className="h-7 w-[13.5rem] border-gray-700 bg-gray-800 text-xs text-gray-100">
              <SelectValue placeholder={`Pick a ${cap?.label.toLowerCase() ?? capability} model`} />
            </SelectTrigger>
            <SelectContent className="border-gray-700 bg-gray-800 text-gray-300">
              {local.length > 0 && (
                <SelectGroup>
                  <SelectLabel className="text-[10px] uppercase tracking-wider text-gray-500">
                    On this box
                  </SelectLabel>
                  {local.map((o) => (
                    <SelectItem key={o.id} value={o.id} className="text-xs">
                      {o.id}
                      {o.status !== "ready" ? " · stopped" : ""}
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
              {cloud.length > 0 && (
                <SelectGroup>
                  <SelectLabel className="text-[10px] uppercase tracking-wider text-gray-500">
                    Cloud
                  </SelectLabel>
                  {cloud.map((o) => (
                    <SelectItem key={o.id} value={o.id} className="text-xs">
                      {o.id}
                      {o.status === "no-key" ? " · no key" : ""}
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
            </SelectContent>
          </Select>
          <span className="text-[11px] text-gray-500">{state}</span>
          {m?.local && <ModelFootprint footprint={m.footprint} className="ml-auto" />}
          {/* Run the thing you just picked, without leaving the page.

              The first compact version dropped this for on-demand runtimes,
              which meant selecting an Ollama model gave you no control at all —
              the one case where you most want it, since the model is not
              resident until something asks for it. Pinned service: Start/Stop.
              On-demand: start the RUNTIME if it is down, Unload once a model is
              resident. */}
          {m?.local && m.serviceId && (
            onDemand && serviceUp ? (
              <button
                type="button"
                disabled={!on || busy === m.id}
                onClick={() => unload(m.id)}
                title={on ? "Unload this model and free the card" : "Not loaded — it loads on first use"}
                className="rounded-md border border-gray-700 px-2 py-1 text-[11px] text-gray-300 disabled:opacity-30"
              >
                Unload
              </button>
            ) : (
              <ServiceControl
                id={m.serviceId}
                up={!!serviceUp}
                probe={() => probeService(m.serviceId!)}
                actions={["stop"]}
              />
            )
          )}
        </div>
        {error && <p className="mt-1.5 text-xs text-red-400">{error}</p>}
        {m && !serviceUp && m.detail && (
          <p className="mt-1 text-[11px] text-gray-500">{m.detail}</p>
        )}
      </div>
    );
  }

  return (
    <div className={`rounded-xl border border-gray-800 bg-gray-900 p-3 ${className}`}>
      {routerDown && (
        // Says the one thing that is actually lost, and nothing more. The rows
        // below still tell the truth about which services are running, which is
        // the question someone opening this tab is really asking.
        <div className="mb-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-amber-500/25 bg-amber-500/10 px-2.5 py-2">
          <span className="flex-1 text-[11px] leading-snug text-amber-300">
            <strong className="font-semibold">AI Router is down</strong> — nothing can be called
            until it starts. Listed from <code>config/ai-router.yaml</code>; service status below is
            live.
          </span>
          <ServiceControl id="ai-router" up={false} probe={async () => !!(await load())?.routerUp} />
        </div>
      )}
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
          {cap?.label ?? capability} model
        </span>
        {activeModel && (
          <span className="text-[11px] text-gray-400">
            in use: <span className="font-medium text-gray-100">{activeModel.id}</span>
            {activeModel.local && activeModel.status !== "ready" && (
              <span className="text-amber-400"> · service stopped</span>
            )}
          </span>
        )}
        <div className="ml-auto flex gap-1 rounded-lg bg-gray-800 p-0.5">
          <button className={pill(tab === "local")} onClick={() => setTab("local")}>
            Local{local.length > 1 ? ` (${local.length})` : ""}
          </button>
          <button className={pill(tab === "cloud")} onClick={() => setTab("cloud")}>
            Cloud{cloud.length ? ` (${cloud.length})` : ""}
          </button>
        </div>
      </div>

      {error && <p className="mb-2 text-xs text-red-400">{error}</p>}

      {tab === "local" && (
        local.length === 0 ? (
          <p className="text-xs text-gray-500">
            No local {cap?.label.toLowerCase()} model. Cloud is the only option here.
          </p>
        ) : (
          <>
          {/* Footprints are per-model, so a lane of three 20+ GB models shows
              ~73 GB of VRAM on a 31.8 GB card and reads as though they coexist.
              They do not: models sharing one runtime are mutually exclusive, and
              saying so once here is clearer than repeating it on every row. */}
          {sharedRuntimeCount > 1 && (
            <p className="mb-1.5 text-[10px] leading-snug text-gray-500">
              {sharedRuntimeCount} of these share one runtime and run{" "}
              <strong className="font-medium text-gray-400">one at a time</strong> — loading one evicts the last. The
              VRAM figures below are each model&apos;s own cost, not a total.
            </p>
          )}
          {/* Every local model for this capability gets its own row, so a tab with
              two of them (Whisper + Kokoro, two vLLMs) is managed in one place. */}
          <ul className="space-y-1.5">
            {local.map((m) => {
              const serviceUp = m.status === "ready";
              // `loaded` is only defined for on-demand runtimes (Ollama). For a
              // pinned service like vLLM, the service being up IS the model being
              // up, and there is no separate question to ask.
              const onDemand = m.loaded !== undefined;
              const on = onDemand ? m.loaded === true : serviceUp;
              const stateLabel = !onDemand
                ? serviceUp ? "running" : "stopped"
                : !serviceUp ? "runtime stopped"
                : m.loaded ? "loaded" : "ready to load";
              const chosen = m.id === active;
              return (
                <li
                  key={m.id}
                  className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 ${
                    chosen ? "border-gray-500" : "border-gray-800"
                  }`}
                >
                  <span
                    className={`size-2 shrink-0 rounded-full ${
                      on ? "bg-emerald-400 shadow-[0_0_5px_rgba(52,211,153,0.7)]" : "bg-gray-600"
                    }`}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-gray-100">
                      {m.id} <span className="font-normal text-gray-500">· {stateLabel}</span>
                    </p>
                    <p className="truncate text-[10px] text-gray-500">
                      {m.target}
                      {m.params ? ` · ${m.params}` : ""}
                      {!serviceUp && m.detail ? ` · ${m.detail}` : ""}
                    </p>
                    {/* Start/Stop sits right there — say what starting it costs. */}
                    <ModelFootprint footprint={m.footprint} className="mt-1" />
                  </div>
                  {/* Shared lifecycle: adds the in-progress state and failure
                      reporting this row used to swallow. Restart is left out —
                      a model you're about to use wants Start or Stop, not a bounce. */}
                  {/* On a shared runtime, Stop means "unload this model" — the
                      service-level Stop would take every sibling alias down with
                      it. On a pinned service it still means stop the service. */}
                  {onDemand ? (
                    <button
                      type="button"
                      disabled={!on || busy === m.id}
                      onClick={() => unload(m.id)}
                      title={on ? "Unload this model and free the card" : "Not loaded"}
                      className="rounded-md border border-gray-700 px-2 py-1 text-[11px] text-gray-300 disabled:opacity-30"
                    >
                      Unload
                    </button>
                  ) : (
                    m.serviceId && (
                      <ServiceControl
                        id={m.serviceId}
                        up={on}
                        probe={() => probeService(m.serviceId!)}
                        actions={["stop"]}
                      />
                    )
                  )}
                  <button
                    disabled={chosen || busy === m.id}
                    onClick={() => select(m.id)}
                    className="rounded-md bg-gray-100 px-2 py-1 text-[11px] font-medium text-gray-900 disabled:opacity-40"
                  >
                    {chosen ? "In use" : "Use"}
                  </button>
                </li>
              );
            })}
          </ul>
          </>
        )
      )}

      {tab === "cloud" && (
        <div className="space-y-2">
          {/* Integration first, then its models — the order you actually decide in. */}
          <div className="flex flex-wrap gap-1">
            {providers.map((p) => (
              <button
                key={p}
                onClick={() => setProvider(p)}
                className={`rounded-md border px-2 py-1 text-[11px] capitalize transition-colors ${
                  provider === p
                    ? "border-gray-100 text-gray-100"
                    : "border-gray-800 text-gray-500 hover:border-gray-600"
                }`}
              >
                {p}
              </button>
            ))}
          </div>
          <ul className="space-y-1.5">
            {cloud
              .filter((m) => m.provider === provider)
              .map((m) => {
                const chosen = m.id === active;
                const keyMissing = m.status === "no-key";
                return (
                  <li
                    key={m.id}
                    className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 ${
                      chosen ? "border-gray-500" : "border-gray-800"
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium text-gray-100">{m.id}</p>
                      <p className="truncate text-[10px] text-gray-500">
                        {m.target}
                        {keyMissing ? ` · needs ${m.keyEnv}` : ""}
                      </p>
                    </div>
                    <button
                      disabled={chosen || keyMissing || busy === m.id}
                      title={keyMissing ? `Set ${m.keyEnv} to use this model` : undefined}
                      onClick={() => select(m.id)}
                      className="rounded-md bg-gray-100 px-2 py-1 text-[11px] font-medium text-gray-900 disabled:opacity-40"
                    >
                      {chosen ? "In use" : "Use"}
                    </button>
                  </li>
                );
              })}
          </ul>
        </div>
      )}

      {cap?.hint && <p className="mt-2 text-[10px] leading-snug text-gray-500">{cap.hint}</p>}
      {/* The choice is persisted routing, not a per-tab toggle: quote-forge and
          move-quest resolve the same file, so picking a cloud model here sends
          their traffic off-box too. Worth saying out loud next to the button. */}
      <p className="mt-1 text-[10px] leading-snug text-gray-600">
        Saved box-wide — every caller on this box that asks for{" "}
        {(cap?.label ?? capability).toLowerCase()} gets this model.
      </p>
    </div>
  );
}
