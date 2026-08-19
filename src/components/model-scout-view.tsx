"use client";

import { useCallback, useMemo, useState } from "react";
import { ToolSectionHeading } from "./tool-page";
import LeaderboardView, { type LeaderboardPayload } from "./leaderboard-view";
import { useLiveRefresh } from "@/lib/use-live-refresh";
import { ArrowsClockwise, Binoculars, Lightning, Plug, TrendUp, Warning } from "@phosphor-icons/react";

/**
 * "What am I missing, and would it even run here?"
 *
 * The Models tab could always tell you about the models already wired into the
 * router. It could not tell you about the ones that are not — which is the only
 * question worth asking when a checkpoint lands that is a third the size of the
 * one you are running. This surface answers it in three registers, deliberately
 * kept visually distinct because they carry different weight:
 *
 *  • UPGRADES — a wired alias has a newer version. Highest signal, smallest ask.
 *  • CANDIDATES — the weekly report's judgement, each with a live fit verdict.
 *  • NEW FROM YOUR PROVIDERS — raw facts off the vendors' own model lists.
 *
 * Nothing here changes a route. Wiring adds an alias; choosing to use it is
 * still a deliberate click on the routing cards above.
 */

type Fit = {
  verdict: "fits" | "tight" | "swap" | "no" | "off-box";
  headline: string;
  vramNeededGb: number;
  ramNeededGb: number;
  diskNeededGb: number;
  headroomGb: number;
  displaces: string[];
  reasons: string[];
  basis?: string;
  estimated: boolean;
};

type Candidate = {
  id: string;
  name: string;
  kind: "local" | "cloud";
  capability: string;
  why: string;
  checkpoint?: string;
  provider?: string;
  target?: string;
  mode?: string;
  params?: string;
  released?: string;
  license?: string;
  docs?: string;
  paper?: string;
  pricing?: { inPerMTok?: number; outPerMTok?: number; perImage?: number };
  fit: Fit;
  alreadyWired?: string;
};

type Stats = {
  input_price: number | null;
  output_price: number | null;
  throughput: number | null;
  gpqa_score: number | null;
  hle_score: number | null;
  context: number | null;
};

type Discovered = {
  provider: string;
  modelId: string;
  target: string;
  mode: string;
  released?: string;
  supersedes?: string;
  newerThanWired: boolean;
  stats?: Stats;
};

type Payload = {
  machine: {
    gpuName: string;
    vramTotalGb: number;
    vramFreeGb: number;
    ramTotalGb: number;
    ramFreeGb: number;
    weightsDiskFreeGb: number;
    weightsDiskLabel: string;
    weightsDiskTotalGb?: number;
    weightsUsedGb?: number;
    weightsPath?: string;
    weightsIndexed?: boolean;
  };
  occupants: { serviceId: string; name: string; vramGb: number; ramGb: number }[];
  report: {
    generatedAt?: string;
    generatedBy?: string;
    ageDays?: number;
    stale: boolean;
    notes: string[];
    upgrades: { alias: string; from: string; to: string; why: string }[];
  };
  candidates: Candidate[];
  discovery: { provider: string; keyEnv: string; reachable: boolean; error?: string; models: Discovered[] }[];
  wired: { alias: string; target: string; provider: string; mode: string; addedAt: string; source?: string }[];
  handWritten: string[];
  leaderboard: LeaderboardPayload;
};

const VERDICT_STYLE: Record<Fit["verdict"], string> = {
  fits: "bg-green-500/10 text-green-400 border-green-500/25",
  tight: "bg-amber-500/10 text-amber-300 border-amber-500/25",
  swap: "bg-blue-500/10 text-blue-300 border-blue-500/25",
  no: "bg-red-500/10 text-red-400 border-red-500/25",
  "off-box": "bg-gray-700/30 text-gray-400 border-gray-600/40",
};
const VERDICT_LABEL: Record<Fit["verdict"], string> = {
  fits: "fits",
  tight: "fits alone",
  swap: "needs a swap",
  no: "won't fit",
  "off-box": "off-box",
};

const PROVIDER_STYLE: Record<string, string> = {
  openai: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  gemini: "bg-blue-500/15 text-blue-300 border-blue-500/30",
  anthropic: "bg-orange-500/15 text-orange-300 border-orange-500/30",
};

/**
 * A default alias for a vendor id.
 *
 * Vendor ids are already alias-shaped ("gpt-5.6-terra"), so the id itself is the
 * least surprising default. Anything that collides is caught server-side rather
 * than guessed at here — a silently-suffixed alias is worse than an error that
 * says which name is taken.
 */
function defaultAlias(modelId: string): string {
  return modelId.toLowerCase().replace(/[^a-z0-9._-]/g, "-").slice(0, 64);
}

export default function ModelScoutView({ view = "scout" }: { view?: "scout" | "leaderboard" }) {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [showAll, setShowAll] = useState(false);

  const refresh = useCallback(async (force = false) => {
    try {
      const res = await fetch(`/api/scout${force ? "?force=1" : ""}`, { cache: "no-store" });
      const payload = await res.json();
      if (!payload?.error) setData(payload);
    } catch {
      /* keep the last good view */
    }
    setLoading(false);
  }, []);

  // Slower than the routing panel above: this reads the machine and, on a cold
  // cache, three vendor APIs. The vendors' answers are cached server-side for
  // 15 minutes, so anything faster would only re-measure free RAM.
  useLiveRefresh(refresh, { intervalMs: 60_000 });

  const forceRefresh = useCallback(async () => {
    setRefreshing(true);
    setMsg({ text: "Asking each provider for its current model list…" });
    await refresh(true);
    setRefreshing(false);
    setMsg(null);
  }, [refresh]);

  const post = useCallback(async (body: Record<string, unknown>, label: string) => {
    setBusy(label);
    setMsg(null);
    try {
      const res = await fetch("/api/scout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await res.json();
      if (!res.ok || j.error) throw new Error(j.error || `Server returned ${res.status}`);
      setMsg(j.warning ? { text: j.warning, bad: true } : { text: `${label} — the router restarted and is serving it.` });
      await refresh(true);
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : String(e), bad: true });
    }
    setBusy(null);
    setTimeout(() => setMsg(null), 8000);
  }, [refresh]);

  const wire = useCallback((d: { target: string; provider: string; mode: string; modelId: string; source: string }) =>
    post(
      {
        action: "wire",
        alias: defaultAlias(d.modelId),
        target: d.target,
        provider: d.provider,
        mode: d.mode,
        source: d.source,
      },
      `Wired ${defaultAlias(d.modelId)}`,
    ), [post]);

  const totals = useMemo(() => {
    const models = data?.discovery.flatMap((p) => p.models) ?? [];
    return {
      discovered: models.length,
      superseding: models.filter((m) => m.supersedes).length,
    };
  }, [data]);

  if (loading) return <p className="text-sm text-gray-500 py-8 text-center">Scouting…</p>;
  if (!data) return <p className="text-sm text-gray-500 py-8 text-center">Scout unavailable.</p>;

  // Both tabs are fed by the same /api/scout call, so switching between them
  // costs nothing and neither can show a machine reading the other disagrees
  // with — the failure mode of giving each its own endpoint.
  if (view === "leaderboard") {
    return data.leaderboard ? (
      <LeaderboardView leaderboard={data.leaderboard} machine={data.machine} />
    ) : (
      <p className="text-sm text-gray-500 py-8 text-center">Leaderboard unavailable.</p>
    );
  }

  const { machine, report } = data;
  const visibleCandidates = showAll ? data.candidates : data.candidates.filter((c) => c.fit.verdict !== "no");

  return (
    <div className="space-y-6">
      <ToolSectionHeading
        eyebrow="Scout"
        title="What this box isn't using yet"
        description="Vendor model lists are read live; the judgement below is a weekly Claude routine's, versioned in config/model-scout.json. Fit is measured against this machine right now."
        action={
          <button
            onClick={forceRefresh}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 text-[11px] text-gray-300 hover:text-white border border-gray-700 hover:border-gray-500 rounded-md px-2.5 py-1.5 transition disabled:opacity-50 cursor-pointer"
          >
            <ArrowsClockwise size={13} weight="bold" className={refreshing ? "animate-spin" : ""} />
            {refreshing ? "Checking…" : "Re-check providers"}
          </button>
        }
      />

      {/* What every verdict below is measured against. Without it the badges are
          assertions; with it they are arithmetic the reader can check. */}
      <section className="tool-panel bg-gray-900 rounded-xl border border-gray-800 p-4">
        <div className="flex items-start gap-3 flex-wrap">
          <Binoculars size={18} weight="duotone" className="text-indigo-400 mt-0.5" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-gray-200">{machine.gpuName}</p>
            <p className="text-[11px] text-gray-500 mt-0.5 tabular-nums">
              {machine.vramTotalGb} GB VRAM ({machine.vramFreeGb} GB free now) ·{" "}
              {machine.ramTotalGb} GB RAM ({machine.ramFreeGb} GB free now) ·{" "}
              {machine.weightsDiskFreeGb} GB free on {machine.weightsDiskLabel} for weights
            </p>
            {/* Free space alone does not say whether a 20 GB download is a
                rounding error or the thing that fills the drive. The storage
                index knows what is already down there, so say it. */}
            {machine.weightsUsedGb != null && (
              <p className="text-[11px] text-gray-600 mt-0.5 tabular-nums" title={machine.weightsPath}>
                {machine.weightsUsedGb} GB of model weights already downloaded
                {machine.weightsDiskTotalGb ? ` · drive is ${machine.weightsDiskTotalGb} GB` : ""}
              </p>
            )}
            {machine.weightsIndexed === false && (
              <p className="text-[11px] text-gray-600 mt-0.5">
                Storage index has not scanned {machine.weightsDiskLabel}, so what is already downloaded is unknown.
              </p>
            )}
            {data.occupants.length > 0 && (
              <p className="text-[11px] text-gray-600 mt-1">
                Holding memory right now: {data.occupants.map((o) => `${o.name} (${o.vramGb} GB VRAM)`).join(" · ")}
              </p>
            )}
          </div>
          <span
            className={`text-[10px] px-2 py-1 rounded-full border ${
              report.stale
                ? "bg-amber-500/10 text-amber-300 border-amber-500/25"
                : "bg-gray-800 text-gray-400 border-gray-700"
            }`}
            title={report.generatedBy}
          >
            {report.generatedAt
              ? `report ${report.generatedAt}${report.ageDays !== undefined ? ` · ${report.ageDays}d old` : ""}`
              : "no report yet"}
            {report.stale ? " · stale" : ""}
          </span>
        </div>
        {report.stale && (
          <p className="mt-2 text-[11px] text-amber-300/80 leading-relaxed">
            The weekly scout has not run in over ten days, so the candidates below may have been overtaken.
            Provider lists and fit verdicts are still live. See <span className="font-mono text-gray-500">docs/model-scout.md</span>.
          </p>
        )}
      </section>

      {msg && (
        <div
          role="status"
          aria-live="polite"
          className={`text-xs rounded-lg px-3 py-2 ${msg.bad ? "bg-red-500/10 text-red-400" : "bg-green-500/10 text-green-400"}`}
        >
          {msg.text}
        </div>
      )}

      {/* ── upgrades: a wired alias is behind ─────────────────────────────── */}
      {report.upgrades.length > 0 && (
        <section className="space-y-2">
          <div className="flex items-center gap-2">
            <TrendUp size={15} weight="duotone" className="text-indigo-400" />
            <h3 className="text-sm font-semibold text-gray-200">Aliases running behind</h3>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-indigo-500/15 text-indigo-300">
              {report.upgrades.length}
            </span>
          </div>
          <p className="text-[11px] text-gray-600 leading-relaxed">
            The console will not rewrite <span className="font-mono text-gray-500">config/ai-router.yaml</span> — that file is
            hand-written and its comments are most of its value. Wire the newer model as its own alias, compare the two, and
            repoint by hand once you are convinced.
          </p>
          <div className="grid gap-2 lg:grid-cols-2">
            {report.upgrades.map((u) => {
              const provider = u.to.split("/")[0];
              const modelId = u.to.split("/").slice(1).join("/");
              const alias = defaultAlias(modelId);
              const wired = data.wired.some((w) => w.alias === alias) || data.handWritten.includes(alias);
              return (
                <div key={u.alias} className="rounded-xl border border-gray-800 bg-gray-900 p-3 space-y-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm text-gray-100">{u.alias}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ml-auto ${PROVIDER_STYLE[provider] ?? "bg-gray-600/20 text-gray-400 border-gray-600/40"}`}>
                      {provider}
                    </span>
                  </div>
                  <p className="text-[11px] font-mono text-gray-500 break-all">
                    {u.from} <span className="text-indigo-400">→</span> <span className="text-gray-300">{u.to}</span>
                  </p>
                  <p className="text-[11px] text-gray-500 leading-relaxed">{u.why}</p>
                  <div className="flex items-center gap-2 pt-0.5">
                    {wired ? (
                      <span className="text-[10px] text-green-400">already wired as {alias}</span>
                    ) : (
                      <button
                        onClick={() => wire({ target: u.to, provider, mode: "chat", modelId, source: `scout upgrade for ${u.alias}` })}
                        disabled={!!busy}
                        className="inline-flex items-center gap-1 text-[11px] text-gray-300 hover:text-white border border-gray-700 hover:border-gray-500 rounded-md px-2 py-1 transition disabled:opacity-50 cursor-pointer ml-auto"
                      >
                        <Plug size={12} weight="bold" />
                        {busy === `Wired ${alias}` ? "Wiring…" : `Wire as ${alias}`}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* ── candidates: the weekly report's judgement, fitted live ────────── */}
      <section className="space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="text-sm font-semibold text-gray-200">Candidates worth the download</h3>
          <span className="text-[10px] text-gray-600">
            sorted by whether they fit — measured against the card, host RAM, and free disk above
          </span>
          {data.candidates.some((c) => c.fit.verdict === "no") && (
            <button
              onClick={() => setShowAll((v) => !v)}
              className="ml-auto text-[11px] text-gray-500 hover:text-gray-300 underline underline-offset-2 cursor-pointer"
            >
              {showAll ? "hide what won't fit" : `show ${data.candidates.filter((c) => c.fit.verdict === "no").length} that won't fit`}
            </button>
          )}
        </div>
        {visibleCandidates.length === 0 ? (
          <p className="text-xs text-gray-600 py-4">
            No candidates in the current report. The weekly routine writes them to config/model-scout.json.
          </p>
        ) : (
          <div className="grid gap-2 lg:grid-cols-2">
            {visibleCandidates.map((c) => (
              <CandidateCard
                key={c.id}
                c={c}
                busy={busy}
                occupants={data.occupants}
                onWire={() =>
                  c.target &&
                  c.provider &&
                  wire({
                    target: c.target,
                    provider: c.provider,
                    mode: c.mode ?? "chat",
                    modelId: c.target.split("/").slice(1).join("/"),
                    source: `scout candidate ${c.id}`,
                  })
                }
              />
            ))}
          </div>
        )}
      </section>

      {/* ── raw discovery: the vendors' own lists ─────────────────────────── */}
      <section className="space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="text-sm font-semibold text-gray-200">New from your providers</h3>
          <span className="text-[10px] text-gray-600">
            {totals.discovered} model{totals.discovered === 1 ? "" : "s"} you can already pay for and are not using
            {totals.superseding > 0 && ` · ${totals.superseding} supersede something wired`}
          </span>
          {totals.discovered > 0 && (
            <button
              onClick={() =>
                post(
                  { action: "wire-all" },
                  `Wired ${totals.discovered} model${totals.discovered === 1 ? "" : "s"}`,
                )
              }
              disabled={!!busy}
              title="Add every one of these as a router alias, in one config write and one restart. Adding an alias does not change any route — the routing cards above still decide what gets used."
              className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-indigo-200 bg-indigo-500/15 hover:bg-indigo-500/25 border border-indigo-500/40 rounded-md px-2.5 py-1.5 transition disabled:opacity-50 cursor-pointer"
            >
              <Lightning size={12} weight="fill" />
              {busy?.startsWith("Wired ") ? "Wiring…" : `Wire all ${totals.discovered}`}
            </button>
          )}
        </div>
        <p className="text-[11px] text-gray-600 leading-relaxed">
          Wiring only makes a model reachable under an alias — it changes no route and costs nothing until something
          calls it. Price and speed below come from llm-stats.com, matched to each vendor id.
        </p>
        <div className="space-y-3">
          {data.discovery.map((p) => (
            <div key={p.provider} className="rounded-xl border border-gray-800 bg-gray-900 p-3">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${PROVIDER_STYLE[p.provider] ?? "bg-gray-600/20 text-gray-400 border-gray-600/40"}`}>
                  {p.provider}
                </span>
                {p.reachable ? (
                  <span className="text-[11px] text-gray-500">{p.models.length} not wired</span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-[11px] text-amber-400">
                    <Warning size={12} weight="fill" /> {p.error}
                  </span>
                )}
              </div>
              {p.models.length > 0 && (
                <ul className="mt-2 divide-y divide-gray-800/70">
                  {p.models.map((m) => {
                    const alias = defaultAlias(m.modelId);
                    const already = data.wired.some((w) => w.alias === alias) || data.handWritten.includes(alias);
                    return (
                      <li key={m.modelId} className="flex items-center gap-2 py-1.5 flex-wrap">
                        <span className="font-mono text-[11px] text-gray-300">{m.modelId}</span>
                        {m.supersedes && (
                          <span
                            className="text-[10px] px-1.5 py-0.5 rounded-full bg-indigo-500/15 text-indigo-300"
                            title={`Same family as the wired alias "${m.supersedes}", but later. Heuristic — check before trusting it.`}
                          >
                            newer than {m.supersedes}
                          </span>
                        )}
                        {!m.supersedes && m.newerThanWired && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-700/40 text-gray-400">
                            newer than anything wired here
                          </span>
                        )}
                        <span className="text-[10px] text-gray-600">{m.mode.replace("_", " ")}</span>
                        {m.released && <span className="text-[10px] text-gray-600 tabular-nums">{m.released}</span>}
                        {/* What it costs and how fast — the two facts that decide
                            whether a newer id is actually an upgrade. */}
                        {m.stats?.input_price != null && (
                          <span className="text-[10px] text-gray-500 tabular-nums" title="USD per million tokens, in / out">
                            ${m.stats.input_price}/${m.stats.output_price ?? "?"}
                          </span>
                        )}
                        {m.stats?.throughput != null && (
                          <span className="text-[10px] text-gray-600 tabular-nums" title="Output tokens per second">
                            {Math.round(m.stats.throughput)} tok/s
                          </span>
                        )}
                        {m.stats?.gpqa_score != null && (
                          <span className="text-[10px] text-gray-500 tabular-nums" title="GPQA Diamond">
                            gpqa {Math.round(m.stats.gpqa_score * 100)}
                          </span>
                        )}
                        {already ? (
                          <span className="ml-auto text-[10px] text-green-400">wired</span>
                        ) : (
                          <button
                            onClick={() => wire({ ...m, source: "scout discovery" })}
                            disabled={!!busy}
                            className="ml-auto inline-flex items-center gap-1 text-[10px] text-gray-400 hover:text-white border border-gray-800 hover:border-gray-600 rounded px-1.5 py-0.5 transition disabled:opacity-50 cursor-pointer"
                          >
                            <Plug size={11} weight="bold" />
                            {busy === `Wired ${alias}` ? "Wiring…" : "Wire in"}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* ── what the console itself added ─────────────────────────────────── */}
      {data.wired.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-gray-200">Wired from this page</h3>
          <p className="text-[11px] text-gray-600">
            Kept in <span className="font-mono text-gray-500">config/wired-models.json</span> and rendered into a managed
            block in ai-router.yaml. Everything else in that file is hand-written and untouched.
          </p>
          <div className="rounded-xl border border-gray-800 bg-gray-900 divide-y divide-gray-800/70">
            {data.wired.map((w) => (
              <div key={w.alias} className="flex items-center gap-2 px-3 py-2 flex-wrap">
                <span className="text-sm text-gray-200">{w.alias}</span>
                <span className="font-mono text-[10px] text-gray-500">{w.target}</span>
                <span className="text-[10px] text-gray-600">{w.mode.replace("_", " ")}</span>
                <span className="text-[10px] text-gray-700 tabular-nums">added {w.addedAt.slice(0, 10)}</span>
                <button
                  onClick={() => post({ action: "unwire", alias: w.alias }, `Removed ${w.alias}`)}
                  disabled={!!busy}
                  className="ml-auto text-[10px] text-gray-500 hover:text-red-400 border border-gray-800 hover:border-red-500/40 rounded px-1.5 py-0.5 transition disabled:opacity-50 cursor-pointer"
                >
                  {busy === `Removed ${w.alias}` ? "Removing…" : "Remove"}
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {report.notes.length > 0 && (
        <section className="rounded-xl border border-gray-800 bg-gray-900/60 p-3">
          <p className="text-[10px] uppercase tracking-wide text-gray-600 mb-1.5">Scout notes</p>
          <ul className="space-y-1.5">
            {report.notes.map((n, i) => (
              <li key={i} className="text-[11px] text-gray-500 leading-relaxed">— {n}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function CandidateCard({
  c, busy, occupants, onWire,
}: {
  c: Candidate;
  busy: string | null;
  occupants: { serviceId: string; name: string }[];
  onWire: () => void;
}) {
  const alias = c.target ? defaultAlias(c.target.split("/").slice(1).join("/")) : null;
  const displaced = c.fit.displaces
    .map((id) => occupants.find((o) => o.serviceId === id)?.name ?? id)
    .join(" and ");

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-3 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-medium text-sm text-gray-100">{c.name}</span>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-800 text-gray-400">{c.capability}</span>
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded-full border ml-auto ${VERDICT_STYLE[c.fit.verdict]}`}
          title={[c.fit.headline, ...c.fit.reasons, c.fit.basis].filter(Boolean).join("\n\n")}
        >
          {VERDICT_LABEL[c.fit.verdict]}
        </span>
      </div>

      {c.checkpoint && (
        <p className="text-[10px] font-mono text-gray-600 truncate" title={c.checkpoint}>{c.checkpoint}</p>
      )}

      <div className="flex items-center gap-1.5 flex-wrap">
        {c.params && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-800 text-gray-300">{c.params}</span>}
        {c.license && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-800/60 text-gray-500">{c.license}</span>}
        {c.released && <span className="text-[10px] text-gray-600">released {c.released}</span>}
        {c.pricing && (c.pricing.inPerMTok || c.pricing.outPerMTok) && (
          <span className="text-[10px] text-gray-500 tabular-nums">
            ${c.pricing.inPerMTok ?? 0} in · ${c.pricing.outPerMTok ?? 0} out /Mtok
          </span>
        )}
      </div>

      {/* The verdict in words, not just a badge — including the estimate caveat,
          because a number sourced from a parameter count is not a measurement. */}
      <p
        className={`text-[11px] leading-relaxed ${c.fit.verdict === "no" ? "text-red-400/80" : "text-gray-400"}`}
      >
        {c.fit.headline}
        {c.fit.verdict === "swap" && displaced && ` Stop ${displaced} first.`}
        {c.fit.estimated && c.kind === "local" && (
          <span className="text-gray-600" title={c.fit.basis}> (estimated, hover for the arithmetic)</span>
        )}
      </p>

      <p className="text-[11px] text-gray-500 leading-relaxed">{c.why}</p>

      <div className="flex items-center gap-2 pt-0.5 text-[10px]">
        {c.docs && (
          <a href={c.docs} target="_blank" rel="noreferrer" className="text-indigo-400 hover:text-indigo-300 underline underline-offset-2">
            model card ↗
          </a>
        )}
        {c.paper && (
          <a href={c.paper} target="_blank" rel="noreferrer" className="text-indigo-400 hover:text-indigo-300 underline underline-offset-2">
            paper ↗
          </a>
        )}
        {c.alreadyWired ? (
          <span className="ml-auto text-green-400">wired as {c.alreadyWired}</span>
        ) : c.kind === "cloud" && c.target && c.provider ? (
          <button
            onClick={onWire}
            disabled={!!busy}
            className="ml-auto inline-flex items-center gap-1 text-[11px] text-gray-300 hover:text-white border border-gray-700 hover:border-gray-500 rounded-md px-2 py-1 transition disabled:opacity-50 cursor-pointer"
          >
            <Plug size={12} weight="bold" />
            {busy === `Wired ${alias}` ? "Wiring…" : `Wire as ${alias}`}
          </button>
        ) : (
          // Local models cannot be wired from here on purpose: a local alias needs
          // a service that serves it, and inventing a route to a port with nothing
          // behind it would produce exactly the silent dead model this tab exists
          // to prevent.
          <span className="ml-auto text-gray-600" title="Local models need a service to serve them — see docs/model-scout.md.">
            needs a local service
          </span>
        )}
      </div>
    </div>
  );
}
