"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CatalogModel, Capability } from "@/lib/providers";
import ModelFootprint from "./model-footprint";
import { ServiceControl } from "./service-control";

const JSON_HEADERS = { "Content-Type": "application/json" };

type CapDef = { id: Capability; label: string; modes: readonly string[]; hint: string };

interface Payload {
  routerUp: boolean;
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
}: {
  capability: Capability;
  className?: string;
  /** Local models here cannot co-reside — selecting one stops the others. */
  exclusiveLocal?: boolean;
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
        const others = local.filter((m) => m.id !== id && m.serviceId && m.status === "ready");
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
  if (!data.routerUp) {
    // The router gates the whole picker, so offer its Start here rather than
    // sending the reader to another tab to find the same button.
    return (
      <div className={`flex items-center gap-3 flex-wrap rounded-lg border border-gray-800 bg-gray-900 px-3 py-2 text-xs text-gray-400 ${className}`}>
        <span className="flex-1">AI Router is down — no models can be listed.</span>
        <ServiceControl id="ai-router" up={false} probe={async () => !!(await load())?.routerUp} />
      </div>
    );
  }
  if (!eligible.length) {
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

  return (
    <div className={`rounded-xl border border-gray-800 bg-gray-900 p-3 ${className}`}>
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
          // Every local model for this capability gets its own row, so a tab with
          // two of them (Whisper + Kokoro, two vLLMs) is managed in one place.
          <ul className="space-y-1.5">
            {local.map((m) => {
              const on = m.status === "ready";
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
                      {m.id} <span className="font-normal text-gray-500">{on ? "· running" : "· stopped"}</span>
                    </p>
                    <p className="truncate text-[10px] text-gray-500">
                      {m.target}
                      {m.params ? ` · ${m.params}` : ""}
                      {!on && m.detail ? ` · ${m.detail}` : ""}
                    </p>
                    {/* Start/Stop sits right there — say what starting it costs. */}
                    <ModelFootprint footprint={m.footprint} className="mt-1" />
                  </div>
                  {/* Shared lifecycle: adds the in-progress state and failure
                      reporting this row used to swallow. Restart is left out —
                      a model you're about to use wants Start or Stop, not a bounce. */}
                  {m.serviceId && (
                    <ServiceControl
                      id={m.serviceId}
                      up={on}
                      probe={() => probeService(m.serviceId!)}
                      actions={["stop"]}
                    />
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
