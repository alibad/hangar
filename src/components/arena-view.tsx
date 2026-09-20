"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cer, wer, chrF, scoreFields, arabicRatio } from "@/lib/text-scoring";
import type { Footprint } from "./model-footprint";
import { ToolPageHeader, ToolSectionHeading } from "./tool-page";
import { useVoiceInput, appendTranscript } from "./voice-input";
import { Swords, ImagePlus, X, Gavel, Loader2, Copy, Check, Cpu, Cloud, Search } from "lucide-react";

/**
 * Arena — one prompt, several chat models, side by side, with real scores.
 *
 * The console could already run ONE text model (the playground) and compare
 * several IMAGE models (the compare view). The gap between those was the whole
 * question this box exists to answer: is the local model good enough for this
 * job, or is it worth paying a vendor.
 *
 * ── Local models run ONE AT A TIME, and the UI says so ──────────────────────
 * This is the constraint that shapes the whole surface. Each local model here is
 * 20-26 GB of a 31.8 GB card, and Ollama is configured `OLLAMA_MAX_LOADED_MODELS=1`,
 * so two of them cannot be resident together — picking three does not mean three
 * run in parallel, it means three run in turn with a model swap between each.
 *
 * The first version fired every selected model at once and let the resource
 * coordinator sort it out. That was wrong in two ways: the tiles all claimed to
 * be "running" when at most one could be, and firing two local models
 * simultaneously raced their eviction against their admission check. So local
 * models are now an explicit **sequential queue** — one runs, the rest say
 * "queued" with their position — while cloud models, which cost money rather
 * than memory, still fan out in parallel. The two lanes are drawn separately for
 * the same reason: they are different kinds of commitment.
 *
 * Everything else it does: deterministic scoring against a reference you supply
 * (shared with `scripts/experiment-arabic.mjs`, so a number here and a number in
 * a committed write-up mean the same thing), Arabic handled properly with both
 * strict and normalised error rates, and cost and footprint shown beside quality.
 */

type CatalogModel = {
  id: string;
  mode: string;
  local: boolean;
  status: string;
  detail?: string;
  provider: string;
  params?: string;
  checkpoint?: string;
  keyEnv?: string;
  serviceId?: string;
  vision?: boolean;
  footprint?: Footprint;
  costPerMTokIn?: number;
  costPerMTokOut?: number;
};

type RunState = "queued" | "preparing" | "running" | "done" | "failed" | "cancelled";

type Run = {
  model: string;
  state: RunState;
  /** Position in the local queue, 1-based. Only set while queued. */
  queuePosition?: number;
  /** What the system is doing to make this model runnable, in plain words. */
  prepNote?: string;
  content?: string;
  thinking?: string | null;
  latency?: number;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  costUsd?: number | null;
  truncated?: boolean;
  error?: string;
};

type ScoreMode = "none" | "reference" | "fields";

/**
 * Discriminated on `kind` rather than on the presence of a key: an `in` check
 * does not narrow a union whose members share no common tag.
 */
type ScoreResult =
  | null
  | { kind: "invalid" }
  | { kind: "fields"; accuracy: number; parsed: boolean; missed: { field: string; expected: string; got: string | null }[] }
  | { kind: "reference"; cerNorm: number; cerStrict: number; werNorm: number; chrf: number; arabic: number };

const JSON_HEADERS = { "Content-Type": "application/json" };

/** Models that cannot run are still listed, with the reason — never hidden. */
function statusLabel(m: CatalogModel): string | null {
  if (m.status === "ready") return null;
  if (m.status === "no-key") return `needs ${m.keyEnv ?? "a key"}`;
  if (m.status === "model-missing") return "not installed on this machine";
  if (m.status === "service-stopped") return "will start on run";
  return m.status;
}

/**
 * Whether picking this model is pointless because nothing can make it run.
 *
 * A stopped service is NOT blocking: /api/arena/prepare starts it, stopping
 * whatever is in the way first. Refusing the selection put that work on the
 * reader — go to Services, work out what to stop, start the right thing, come
 * back — when the console already knows all of it. A missing API key is
 * genuinely blocking, because no amount of starting and stopping produces a
 * credential.
 */
function isBlocked(m: CatalogModel): boolean {
  return m.status === "no-key" || m.status === "model-missing";
}

function gb(n: number | undefined): string | null {
  return n == null ? null : `${n >= 10 ? Math.round(n) : n.toFixed(1)} GB`;
}

export default function ArenaView() {
  const [catalogue, setCatalogue] = useState<CatalogModel[]>([]);
  const [routerUp, setRouterUp] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [prompt, setPrompt] = useState("");
  const voice = useVoiceInput({
    onTranscript: (t) => setPrompt((v) => appendTranscript(v, t)),
    label: "prompt",
  });
  const [image, setImage] = useState<{ dataUrl: string; name: string } | null>(null);
  const [scoreMode, setScoreMode] = useState<ScoreMode>("none");
  const [reference, setReference] = useState("");
  const [runs, setRuns] = useState<Record<string, Run>>({});
  const [provider, setProvider] = useState<string>("");
  const [query, setQuery] = useState("");
  const [showCloud, setShowCloud] = useState(false);
  const [judgeModel, setJudgeModel] = useState("");
  const [judgeResult, setJudgeResult] = useState<{ raw: string; labels: Record<string, string>; note: string } | null>(null);
  const [judging, setJudging] = useState(false);
  const [judgeError, setJudgeError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const controllers = useRef<Record<string, AbortController>>({});
  /** Set when the user cancels everything, so the sequential chain stops too. */
  const abandoned = useRef(false);

  useEffect(() => {
    fetch("/api/providers", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        setRouterUp(Boolean(d.routerUp));
        setCatalogue((d.models ?? []).filter((m: CatalogModel) => m.mode === "chat"));
      })
      .catch(() => setRouterUp(false));
  }, []);

  // An attached image narrows the field to models that can actually see it.
  // Selections that no longer qualify are dropped rather than silently ignored.
  const eligible = useMemo(
    () => (image ? catalogue.filter((m) => m.vision) : catalogue),
    [catalogue, image],
  );
  useEffect(() => {
    const ok = new Set(eligible.map((m) => m.id));
    setSelected((prev) => (prev.every((id) => ok.has(id)) ? prev : prev.filter((id) => ok.has(id))));
  }, [eligible]);

  /**
   * Free-text filter across id, provider and parameter count. Matched models
   * that are already SELECTED stay visible regardless, so narrowing the search
   * never appears to silently drop a contestant you had chosen.
   */
  const matches = useCallback(
    (m: CatalogModel) => {
      const q = query.trim().toLowerCase();
      if (!q) return true;
      if (selected.includes(m.id)) return true;
      return [m.id, m.provider, m.params, m.checkpoint].filter(Boolean).join(" ").toLowerCase().includes(q);
    },
    [query, selected],
  );

  const localModels = useMemo(() => eligible.filter((m) => m.local && matches(m)), [eligible, matches]);
  const cloudModels = useMemo(() => eligible.filter((m) => !m.local && matches(m)), [eligible, matches]);
  const providers = useMemo(
    () => [...new Set(cloudModels.map((m) => m.provider))].sort(),
    [cloudModels],
  );
  useEffect(() => {
    if (!provider && providers.length) setProvider(providers[0]);
  }, [provider, providers]);

  // A search that only matches cloud models should not appear to find nothing
  // because the cloud lane happens to be collapsed.
  useEffect(() => {
    if (query.trim() && cloudModels.length > 0) setShowCloud(true);
  }, [query, cloudModels.length]);

  // Keep the provider tab on one that still has matches, or the lane looks empty
  // while the count in its header says otherwise.
  useEffect(() => {
    if (!query.trim() || !providers.length) return;
    if (!providers.includes(provider)) setProvider(providers[0]);
  }, [query, providers, provider]);

  const selectedLocal = useMemo(
    () => selected.filter((id) => catalogue.find((m) => m.id === id)?.local),
    [selected, catalogue],
  );
  const selectedCloud = useMemo(
    () => selected.filter((id) => !catalogue.find((m) => m.id === id)?.local),
    [selected, catalogue],
  );

  const busy = Object.values(runs).some(
    (r) => r.state === "running" || r.state === "queued" || r.state === "preparing",
  );

  const toggle = useCallback((id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);

  const onImage = useCallback((file: File | null) => {
    if (!file) return setImage(null);
    const reader = new FileReader();
    reader.onload = () => setImage({ dataUrl: String(reader.result), name: file.name });
    reader.readAsDataURL(file);
  }, []);

  const runOne = useCallback(
    async (model: string, promptText: string, imageUrl: string | null) => {
      const controller = new AbortController();
      controllers.current[model] = controller;
      try {
        // Make it runnable first: start its service, stopping whatever is in the
        // way. A no-op for cloud models and for anything already up.
        setRuns((prev) => ({
          ...prev,
          [model]: { model, state: "preparing", prepNote: "Checking what needs to start…" },
        }));
        const prep = await fetch("/api/arena/prepare", {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ model }),
          signal: controller.signal,
        });
        const prepData = await prep.json();
        if (!prep.ok) {
          setRuns((prev) => ({
            ...prev,
            [model]: { model, state: "failed", error: prepData.error ?? `Could not prepare (HTTP ${prep.status})` },
          }));
          return;
        }
        setRuns((prev) => ({ ...prev, [model]: { model, state: "running" } }));
        const res = await fetch("/api/arena/run", {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ model, prompt: promptText, image: imageUrl ?? undefined }),
          signal: controller.signal,
        });
        const data = await res.json();
        if (!res.ok) {
          setRuns((prev) => ({ ...prev, [model]: { model, state: "failed", error: data.error ?? `HTTP ${res.status}` } }));
          return;
        }
        setRuns((prev) => ({
          ...prev,
          [model]: {
            model,
            state: "done",
            content: data.content ?? "",
            thinking: data.thinking ?? null,
            latency: data.latency,
            usage: data.usage,
            costUsd: data.costUsd,
            truncated: data.truncated,
          },
        }));
      } catch (err) {
        const cancelled = err instanceof Error && err.name === "AbortError";
        setRuns((prev) => ({
          ...prev,
          [model]: { model, state: cancelled ? "cancelled" : "failed", error: cancelled ? undefined : String(err) },
        }));
      } finally {
        delete controllers.current[model];
      }
    },
    [],
  );

  const runAll = useCallback(() => {
    if (!prompt.trim() || selected.length === 0) return;
    abandoned.current = false;
    setJudgeResult(null);
    setJudgeError(null);

    // Seed every tile up front: cloud starts immediately, local waits its turn
    // and says which turn that is.
    const seeded: Record<string, Run> = {};
    for (const m of selectedCloud) seeded[m] = { model: m, state: "running" };
    selectedLocal.forEach((m, i) => {
      seeded[m] = i === 0 ? { model: m, state: "running" } : { model: m, state: "queued", queuePosition: i };
    });
    setRuns(seeded);

    // Cloud: parallel. They cost money, not memory, and nothing serialises them.
    for (const model of selectedCloud) void runOne(model, prompt, image?.dataUrl ?? null);

    // Local: strictly one at a time. The card holds one 20+ GB model, so this
    // loop is the honest shape of what the hardware does — and it keeps two
    // models from racing each other's eviction and admission check.
    void (async () => {
      for (const model of selectedLocal) {
        if (abandoned.current) {
          setRuns((prev) => ({ ...prev, [model]: { model, state: "cancelled" } }));
          continue;
        }
        await runOne(model, prompt, image?.dataUrl ?? null);
      }
    })();
  }, [prompt, selected, selectedLocal, selectedCloud, image, runOne]);

  const cancel = useCallback((model: string) => controllers.current[model]?.abort(), []);
  const cancelAll = useCallback(() => {
    abandoned.current = true;
    for (const c of Object.values(controllers.current)) c.abort();
  }, []);

  /** Deterministic scores for one output, per the chosen mode. */
  const scoreOf = useCallback(
    (content: string | undefined): ScoreResult => {
      if (!content || scoreMode === "none" || !reference.trim()) return null;
      if (scoreMode === "fields") {
        let expected: Record<string, string>;
        try {
          const parsed = JSON.parse(reference);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "invalid" };
          expected = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
        } catch {
          return { kind: "invalid" };
        }
        const f = scoreFields(content, expected);
        return { kind: "fields", accuracy: f.accuracy, parsed: f.parsed, missed: f.missed };
      }
      return {
        kind: "reference",
        cerNorm: cer(reference, content, "normalized").rate,
        cerStrict: cer(reference, content, "strict").rate,
        werNorm: wer(reference, content, "normalized").rate,
        chrf: chrF(reference, content),
        arabic: arabicRatio(content),
      };
    },
    [scoreMode, reference],
  );

  const finished = useMemo(
    () => Object.values(runs).filter((r) => r.state === "done" && r.content?.trim()),
    [runs],
  );

  const judgeCandidates = useMemo(
    () => catalogue.filter((m) => m.status === "ready" && !finished.some((f) => f.model === m.id)),
    [catalogue, finished],
  );

  const runJudge = useCallback(async () => {
    if (!judgeModel || finished.length < 2) return;
    setJudging(true);
    setJudgeError(null);
    setJudgeResult(null);
    try {
      const res = await fetch("/api/arena/judge", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          judge: judgeModel,
          task: prompt,
          entries: finished.map((r) => ({ model: r.model, content: r.content })),
        }),
      });
      const data = await res.json();
      if (!res.ok) setJudgeError(data.error ?? `HTTP ${res.status}`);
      else setJudgeResult({ raw: data.raw, labels: data.labels, note: data.note });
    } catch (err) {
      setJudgeError(String(err));
    } finally {
      setJudging(false);
    }
  }, [judgeModel, finished, prompt]);

  const copyResults = useCallback(() => {
    const lines = [`# Arena run`, ``, `## Prompt`, prompt, ``];
    if (reference.trim() && scoreMode !== "none") lines.push(`## Reference (${scoreMode})`, reference, ``);
    for (const r of Object.values(runs)) {
      lines.push(`## ${r.model}`, `state: ${r.state}`);
      if (r.latency) lines.push(`latency: ${(r.latency / 1000).toFixed(1)}s`);
      if (r.error) lines.push(`error: ${r.error}`);
      if (r.content) lines.push(``, r.content);
      lines.push(``);
    }
    void navigator.clipboard.writeText(lines.join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [runs, prompt, reference, scoreMode]);

  return (
    <div className="tool-page arena-page space-y-5">
      <ToolPageHeader
        eyebrow="Comparison workstream"
        title="Arena"
        description="One prompt, several models, measured side by side — latency, tokens, cost, and error rates against a reference you supply."
        icon={<Swords size={24} />}
        meta={
          <span className="tool-page-chip">
            {localModels.length} local · {cloudModels.length} cloud
          </span>
        }
      />

      {!routerUp && (
        <div className="tool-panel rounded-xl border border-amber-700/50 bg-amber-950/30 p-4 text-sm text-amber-200">
          The AI Router is not running, so no models are available. Start it from the Services tab.
        </div>
      )}

      {/* ── 1. prompt first: it is the thing you came to run ── */}
      <section className="tool-panel bg-gray-900 rounded-xl border border-gray-800 p-4">
        <ToolSectionHeading
          eyebrow="Input"
          title="Prompt"
          description="Every selected model is asked exactly this. Attach an image to compare vision models on one document."
        />
        <div className="relative">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            // dir="auto" throughout: the first strong character decides. An Arabic
            // prompt typed into an LTR box is genuinely hard to proofread.
            dir="auto"
            rows={3}
            placeholder="Ask every selected model the same thing…"
            className="w-full rounded-xl border border-gray-700 bg-gray-800 py-2.5 pl-3.5 pr-14 text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
          />
          {voice.mic}
        </div>
        {voice.banner && <div className="mt-2">{voice.banner}</div>}
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-gray-800 bg-gray-900 px-3 py-2 text-sm hover:border-gray-700">
            <ImagePlus size={15} />
            {image ? "Replace image" : "Attach image"}
            <input type="file" accept="image/*" className="hidden" onChange={(e) => onImage(e.target.files?.[0] ?? null)} />
          </label>
          {image && (
            <span className="inline-flex items-center gap-2 text-xs text-gray-400">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={image.dataUrl} alt="" className="h-8 w-8 rounded object-cover" />
              {image.name}
              <button type="button" onClick={() => setImage(null)} className="text-gray-500 hover:text-gray-300">
                <X size={14} />
              </button>
            </span>
          )}
        </div>
      </section>

      {/* ── 2. contestants, in two lanes ── */}
      <section className="tool-panel bg-gray-900 rounded-xl border border-gray-800 p-4">
        <ToolSectionHeading
          eyebrow="Contestants"
          title="Pick the models to compare"
          description={
            image
              ? "An image is attached, so only models that accept image input are listed."
              : "Local models are free but hold the card. Cloud models cost per call."
          }
        />

        {/* Search spans BOTH lanes: with 26 models the question is usually
            "where is claude-haiku", not "which provider is it under", and a
            provider filter cannot answer that. */}
        <div className="relative mb-4">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search models by name, provider or size…"
            aria-label="Search models"
            className="w-full rounded-xl border border-gray-700 bg-gray-800 py-2 pl-9 pr-9 text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear search"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
            >
              <X size={14} />
            </button>
          )}
        </div>

        {/* Local lane */}
        <div className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-gray-500">
          <Cpu size={12} />
          On this machine
          <span className="font-normal normal-case tracking-normal text-gray-600">
            · one at a time — the card holds a single 20 GB model
          </span>
        </div>
        {localModels.length === 0 ? (
          <p className="mb-4 text-xs text-gray-500">
            {query.trim()
              ? `No local model matches “${query.trim()}”.`
              : "No local model can serve this. Cloud is the only option."}
          </p>
        ) : (
          <ul className="mb-5 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {localModels.map((m) => {
              const bad = statusLabel(m);
              const blocked = isBlocked(m);
              const on = selected.includes(m.id);
              const order = selectedLocal.indexOf(m.id);
              return (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => toggle(m.id)}
                    disabled={blocked}
                    title={m.detail ?? undefined}
                    className={`flex w-full items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left transition ${
                      on ? "border-blue-500 bg-blue-950/40" : "border-gray-800 bg-gray-950/25 hover:border-gray-600"
                    } ${blocked ? "cursor-not-allowed opacity-45" : ""}`}
                  >
                    {/* The run order IS the information: with one model resident
                        at a time, position is what tells you when it goes. */}
                    {/* Empty when unselected rather than transparent text: a
                        hidden "0" is invisible on screen but read aloud. */}
                    <span
                      className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md border text-[10px] font-semibold ${
                        on ? "border-blue-400 bg-blue-500 text-white" : "border-gray-700"
                      }`}
                      aria-hidden={!on}
                    >
                      {on ? order + 1 : ""}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-1.5">
                        <span className="truncate text-sm font-medium text-gray-100">{m.id}</span>
                        {m.vision && <span className="shrink-0 text-[10px] font-medium text-emerald-400">vision</span>}
                      </span>
                      <span className="mt-0.5 block truncate text-[11px] text-gray-500">
                        {[m.params, gb(m.footprint?.vramGb) && `${gb(m.footprint?.vramGb)} VRAM`]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                      {bad && <span className="mt-0.5 block text-[11px] text-amber-400">{bad}</span>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {/* Cloud lane — a list behind a provider filter, not 21 cards. */}
        <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-gray-500">
          <Cloud size={12} />
          Cloud
          <span className="font-normal normal-case tracking-normal text-gray-600">· parallel, billed per call</span>
          <button
            type="button"
            onClick={() => setShowCloud((v) => !v)}
            className="ml-auto rounded-md border border-gray-800 px-2 py-1 text-[10px] font-medium normal-case tracking-normal text-gray-400 hover:border-gray-600 hover:text-gray-200"
          >
            {showCloud ? "Hide" : `Show ${cloudModels.length}`}
          </button>
        </div>
        {showCloud && (
          <>
            <div className="mb-2 flex flex-wrap gap-1">
              {providers.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setProvider(p)}
                  className={`rounded-md border px-2 py-1 text-[11px] capitalize transition ${
                    provider === p ? "border-gray-100 text-gray-100" : "border-gray-800 text-gray-500 hover:border-gray-600"
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
            <ul className="max-h-64 space-y-1 overflow-y-auto pr-1">
              {cloudModels
                .filter((m) => m.provider === provider)
                .map((m) => {
                  const bad = statusLabel(m);
                  const blocked = isBlocked(m);
                  const on = selected.includes(m.id);
                  return (
                    <li key={m.id}>
                      <button
                        type="button"
                        onClick={() => toggle(m.id)}
                        disabled={blocked}
                        title={m.detail ?? undefined}
                        className={`flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition ${
                          on ? "border-blue-500 bg-blue-950/40" : "border-gray-800 bg-gray-950/25 hover:border-gray-600"
                        } ${blocked ? "cursor-not-allowed opacity-45" : ""}`}
                      >
                        <span
                          className={`size-4 shrink-0 rounded border ${
                            on ? "border-blue-400 bg-blue-500" : "border-gray-700"
                          }`}
                        />
                        <span className="min-w-0 flex-1 truncate text-sm text-gray-100">{m.id}</span>
                        {m.vision && <span className="shrink-0 text-[10px] text-emerald-400">vision</span>}
                        <span className="shrink-0 text-[11px] tabular-nums text-gray-500">
                          {m.costPerMTokIn != null ? `$${m.costPerMTokIn.toFixed(2)}/M` : "—"}
                        </span>
                        {bad && <span className="shrink-0 text-[11px] text-amber-400">{bad}</span>}
                      </button>
                    </li>
                  );
                })}
            </ul>
          </>
        )}

        {/* The selection summary and the button that acts on it live on the
            same surface as the choice itself. As its own panel this read as a
            stray strip floating between two sections. */}
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-gray-800 pt-3">
          <p className="text-sm text-gray-300">
            {selected.length === 0 ? (
              <span className="text-gray-500">Nothing selected yet.</span>
            ) : (
              <>
                <strong className="font-semibold text-gray-100">{selected.length}</strong> selected
                {selectedLocal.length > 0 && (
                  <span className="text-gray-400">{` · ${selectedLocal.length} local, run in turn`}</span>
                )}
                {selectedCloud.length > 0 && (
                  <span className="text-gray-400">{` · ${selectedCloud.length} cloud, in parallel`}</span>
                )}
              </>
            )}
          </p>
          <div className="ml-auto flex items-center gap-2">
            {busy ? (
              <button
                type="button"
                onClick={cancelAll}
                className="rounded-xl bg-gray-700 px-5 py-2.5 text-sm font-medium hover:bg-gray-600"
              >
                Cancel all
              </button>
            ) : (
              <button
                type="button"
                onClick={runAll}
                disabled={!prompt.trim() || selected.length === 0}
                className="rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-40"
              >
                Run
              </button>
            )}
          </div>
        </div>
        {selectedLocal.length > 1 && (
          <p className="mt-2 text-[11px] text-gray-500">
            Each local model is loaded, run, then swapped out for the next. Expect roughly 10-15 seconds of load time
            between them — they cannot be held on the card together.
          </p>
        )}
      </section>

      {/* ── 3. scoring ── */}
      <section className="tool-panel bg-gray-900 rounded-xl border border-gray-800 p-4">
        <ToolSectionHeading
          eyebrow="Scoring"
          title="Optional reference"
          description="Supply the correct answer and every output is scored against it automatically."
        />
        <div className="mb-3 flex gap-2">
          {(
            [
              ["none", "No scoring"],
              ["reference", "Reference text"],
              ["fields", "Expected JSON"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setScoreMode(id)}
              className={`rounded-lg border px-3 py-1.5 text-xs transition ${
                scoreMode === id ? "border-blue-500 bg-blue-950/40" : "border-gray-800 bg-gray-950/25 hover:border-gray-600"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {scoreMode !== "none" && (
          <textarea
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            dir="auto"
            rows={3}
            placeholder={
              scoreMode === "fields"
                ? '{"invoice_number": "INV-2026-0412", "total": "81600"}'
                : "The correct transcription or translation…"
            }
            className="w-full rounded-xl border border-gray-700 bg-gray-800 px-3.5 py-2.5 font-mono text-sm placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
          />
        )}
        {scoreMode === "reference" && (
          <p className="mt-2 text-[11px] text-gray-500">
            Two error rates are reported. <strong>Normalised</strong> folds Arabic diacritics, alef and ya variants and
            Arabic-Indic digits; <strong>strict</strong> folds nothing. A model with a low normalised and a high strict
            rate read the text correctly but did not reproduce its diacritics.
          </p>
        )}
      </section>

      {/* ── 4. results ── */}
      {Object.keys(runs).length > 0 && (
        <section className="tool-panel bg-gray-900 rounded-xl border border-gray-800 p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <ToolSectionHeading eyebrow="Results" title="Side by side" description="Each model reports its own timing as it finishes." />
            <button
              type="button"
              onClick={copyResults}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-gray-800 bg-gray-900 px-3 py-1.5 text-xs hover:border-gray-700"
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
              {copied ? "Copied" : "Copy all"}
            </button>
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {selected.map((model) => {
              const run = runs[model];
              if (!run) return null;
              const s = scoreOf(run.content);
              return (
                <article key={model} className="flex flex-col overflow-hidden rounded-xl border border-gray-800 bg-gray-950/25">
                  <header className="flex items-center justify-between gap-2 border-b border-gray-800 px-4 py-2.5">
                    <span className="truncate text-sm font-medium">{model}</span>
                    <div className="flex shrink-0 items-center gap-2 text-[11px] text-gray-400">
                      {run.latency != null && <span>{(run.latency / 1000).toFixed(1)}s</span>}
                      {run.usage?.completion_tokens != null && <span>{run.usage.completion_tokens} tok</span>}
                      {run.costUsd != null && <span>${run.costUsd.toFixed(4)}</span>}
                      {(run.state === "running" || run.state === "queued" || run.state === "preparing") && (
                        <button type="button" onClick={() => cancel(model)} className="text-gray-500 hover:text-gray-300">
                          <X size={13} />
                        </button>
                      )}
                    </div>
                  </header>

                  {s && s.kind !== "invalid" && (
                    <div className="flex flex-wrap gap-x-4 gap-y-1 border-b border-gray-800 px-4 py-2 text-[11px]">
                      {s.kind === "reference" ? (
                        <>
                          <Metric label="CER norm" value={`${(s.cerNorm * 100).toFixed(1)}%`} good={s.cerNorm < 0.05} />
                          <Metric label="CER strict" value={`${(s.cerStrict * 100).toFixed(1)}%`} />
                          <Metric label="WER" value={`${(s.werNorm * 100).toFixed(1)}%`} good={s.werNorm < 0.1} />
                          <Metric label="chrF" value={(s.chrf * 100).toFixed(1)} good={s.chrf > 0.8} />
                          <Metric label="Arabic" value={`${(s.arabic * 100).toFixed(0)}%`} />
                        </>
                      ) : (
                        <>
                          <Metric label="Fields" value={`${(s.accuracy * 100).toFixed(0)}%`} good={s.accuracy === 1} />
                          {!s.parsed && <span className="text-amber-400">no JSON in reply</span>}
                          {s.missed.length > 0 && (
                            <span className="text-gray-500">missed: {s.missed.map((m) => m.field).join(", ")}</span>
                          )}
                        </>
                      )}
                    </div>
                  )}
                  {s?.kind === "invalid" && (
                    <div className="border-b border-gray-800 px-4 py-2 text-[11px] text-amber-400">
                      Expected-JSON mode needs a valid JSON object in the reference box.
                    </div>
                  )}

                  <div className="min-h-[160px] flex-1 p-4">
                    {run.state === "queued" && (
                      <p className="text-sm text-gray-500">
                        Queued — position {run.queuePosition}. Waiting for the card.
                      </p>
                    )}
                    {run.state === "preparing" && (
                      <p className="inline-flex items-center gap-2 text-sm text-gray-500">
                        <Loader2 size={14} className="animate-spin" />
                        {run.prepNote ?? "Preparing…"}
                      </p>
                    )}
                    {run.state === "running" && (
                      <p className="inline-flex items-center gap-2 text-sm text-gray-500">
                        <Loader2 size={14} className="animate-spin" />
                        Running. A cold local model loads ~20 GB first.
                      </p>
                    )}
                    {run.state === "cancelled" && <p className="text-sm italic text-gray-500">Cancelled.</p>}
                    {run.state === "failed" && <p className="break-words text-sm text-red-400">{run.error}</p>}
                    {run.state === "done" && (
                      <>
                        {run.thinking && (
                          <details className="mb-3 text-xs text-gray-500">
                            <summary className="cursor-pointer">Thinking ({run.thinking.length} chars)</summary>
                            <pre dir="auto" className="mt-2 whitespace-pre-wrap text-gray-600">{run.thinking}</pre>
                          </details>
                        )}
                        {run.content?.trim() ? (
                          <pre dir="auto" className="whitespace-pre-wrap font-sans text-sm leading-relaxed">{run.content}</pre>
                        ) : (
                          <p className="text-sm italic text-gray-500">
                            {run.truncated ? "Spent the whole token budget thinking — no answer left." : "Empty reply."}
                          </p>
                        )}
                      </>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      )}

      {/* ── 5. judge ── */}
      {finished.length >= 2 && (
        <section className="tool-panel bg-gray-900 rounded-xl border border-gray-800 p-4">
          <ToolSectionHeading
            eyebrow="Judgment"
            title="Grade these blind"
            description="For tasks with no reference answer. The judge sees the outputs labelled A, B, C with no model names, and cannot be one of the contestants."
          />
          <div className="flex flex-wrap items-center gap-3">
            <select
              value={judgeModel}
              onChange={(e) => setJudgeModel(e.target.value)}
              className="rounded-xl border border-gray-700 bg-gray-800 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40"
            >
              <option value="">Pick a judge…</option>
              {judgeCandidates.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                  {m.local ? " (local)" : ""}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={runJudge}
              disabled={!judgeModel || judging}
              className="inline-flex items-center gap-2 rounded-xl bg-gray-700 px-4 py-2 text-sm font-medium hover:bg-gray-600 disabled:opacity-40"
            >
              {judging ? <Loader2 size={14} className="animate-spin" /> : <Gavel size={14} />}
              {judging ? "Grading" : "Grade"}
            </button>
          </div>
          {judgeError && <p className="mt-3 text-sm text-red-400">{judgeError}</p>}
          {judgeResult && (
            <div className="mt-3 rounded-xl border border-gray-800 bg-gray-950/25 p-4">
              <p className="mb-2 text-[11px] text-gray-500">{judgeResult.note}</p>
              <p className="mb-2 text-[11px] text-gray-400">
                {Object.entries(judgeResult.labels).map(([label, model]) => `${label} = ${model}`).join("   ")}
              </p>
              <pre dir="auto" className="whitespace-pre-wrap text-sm leading-relaxed">{judgeResult.raw}</pre>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function Metric({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="text-gray-500">{label}</span>
      <span className={good === undefined ? "text-gray-300" : good ? "text-emerald-400" : "text-gray-300"}>{value}</span>
    </span>
  );
}
