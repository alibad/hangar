"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IMAGE_MODELS } from "@/lib/image-models";
import { projectHostRam } from "@/lib/ram-budget";
import { useLocalFootprints } from "@/lib/use-local-footprints";
import ModelFootprint, { type Footprint } from "./model-footprint";

/**
 * One prompt, several models, side by side.
 *
 * The whole point of the router was to make "is the local 20B good enough?" a
 * question you can answer rather than argue about. Everything shown here is
 * measured on the run — latency per model, published price, and the images
 * themselves at the same seed — so the tradeoff is visible instead of asserted.
 *
 * The fan-out happens HERE rather than in one server call. /api/image/compare
 * awaited every model in a Promise.all, so the UI could say nothing but
 * "running" until the slowest one landed — and on a cold local model that's
 * minutes of dead screen. Firing one standard /api/image/generate per model
 * means each tile reports its own state, results appear as they finish, and a
 * single model can be cancelled without losing the rest.
 */

type CatalogModel = {
  id: string;
  mode: string;
  local: boolean;
  status: string;
  detail?: string;
  provider: string;
  params?: string;
  serviceId?: string;
  costPerImage?: number;
  footprint?: Footprint;
};

type RunState = "queued" | "running" | "done" | "failed" | "cancelled";

type Run = {
  model: string;
  label: string;
  local: boolean;
  costUsd?: number;
  state: RunState;
  /** Why it's still running when nothing appears to be happening, e.g. a cold model loading. */
  note?: string;
  /** Wall-clock for this model alone, filled in as it finishes. */
  ms?: number;
  startedAt?: number;
  image?: string;
  savedPath?: string;
  error?: string;
};

/**
 * How long to keep re-asking a model that says it's still loading.
 *
 * Deliberately generous. Measured on this box: Qwen-Image cold off disk
 * reported elapsed_s 251 with eta_s 48 still to go — roughly five minutes to
 * stream ~28 GB of fp8 weights into host RAM. A budget that expires mid-load
 * reintroduces the exact bug this retry exists to fix, just later. The run is
 * cancellable at any point, so the cost of waiting is bounded by the user, not
 * by a number guessed here.
 */
const WARMUP_BUDGET_MS = 900_000;

const SIZES = [
  { label: "1024²", w: 1024, h: 1024 },
  { label: "768²", w: 768, h: 768 },
  { label: "512²", w: 512, h: 512 },
];

function fmtCost(c: number | undefined, local: boolean): string {
  if (local) return "free · local";
  if (c == null) return "metered";
  return `~$${c.toFixed(3)}`;
}

const STATE_STYLE: Record<RunState, string> = {
  queued: "bg-gray-600/20 text-gray-400 border-gray-600/40",
  running: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  done: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  failed: "bg-red-500/15 text-red-300 border-red-500/40",
  cancelled: "bg-gray-600/20 text-gray-500 border-gray-600/40",
};

/** Ticks while anything is in flight, so running tiles show a live elapsed count. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export default function CompareView() {
  const [prompt, setPrompt] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [size, setSize] = useState(SIZES[1]);
  const [cloud, setCloud] = useState<CatalogModel[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [seed, setSeed] = useState<number | null>(null);
  const abortRef = useRef<Map<string, AbortController>>(new Map());
  /** Set when the whole run is cancelled, so the local chain stops advancing. */
  const cancelledAllRef = useRef(false);
  const { footprints, liveMb, hostFreeGb } = useLocalFootprints();

  const running = runs.some((r) => r.state === "queued" || r.state === "running");
  const now = useNow(running);

  useEffect(() => {
    fetch("/api/providers", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        const all: CatalogModel[] = d?.models ?? [];
        setCloud(all.filter((m) => m.mode === "image_generation" && !m.local));
      })
      .catch(() => { /* local-only comparison still works */ });
  }, []);

  // Local models come from the studio's own registry, cloud from the router —
  // the same two sources the rest of the console uses, so nothing can disagree.
  const options = useMemo(
    () => [
      ...IMAGE_MODELS.map((m) => ({
        id: m.id, label: m.name, sub: m.tier, local: true, cost: 0,
        blocked: undefined as string | undefined,
        // What it costs on the card. The only figure that matters for a local
        // model, and it used to be the one thing this list didn't say.
        // serviceId is null for a cloud entry — it has no local process to cost.
        footprint: (m.serviceId ? footprints.get(m.serviceId) : undefined) as Footprint | undefined,
        liveMb: m.serviceId ? liveMb.get(m.serviceId) : undefined,
      })),
      ...cloud.map((m) => ({
        id: m.id, label: m.id, sub: m.provider, local: false, cost: m.costPerImage,
        blocked: m.status === "ready" ? undefined : (m.detail ?? m.status),
        footprint: m.footprint,
        liveMb: undefined as number | undefined,
      })),
    ],
    [cloud, footprints, liveMb],
  );

  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  /** Rough spend for one run, shown BEFORE committing to it. */
  const estCost = useMemo(
    () => options.filter((o) => picked.includes(o.id)).reduce((s, o) => s + (o.cost ?? 0), 0),
    [options, picked],
  );

  /**
   * Will this selection fit in system RAM?
   *
   * Local models run one at a time here, and that does NOT make the cost
   * sequential: Qwen-Image holds its ~28 GB of host-resident weights for as long
   * as the service is up, so a FLUX run afterwards ADDS to it rather than
   * replacing it. Two of those on a 63 GB box is the MemoryError that already
   * killed the Qwen service — summing per service is the honest model.
   *
   * VRAM is not checked: local runs are serialised on the card, so they never
   * overlap there. RAM is the one that accumulates.
   */
  const ramBudget = useMemo(() => {
    if (hostFreeGb == null) return null; // no reading yet — don't block on nothing
    return projectHostRam({
      modelIds: picked,
      serviceOf: (id) => IMAGE_MODELS.find((m) => m.id === id)?.serviceId,
      footprintOf: (svc) => footprints.get(svc),
      freeGb: hostFreeGb,
    });
  }, [picked, footprints, hostFreeGb]);

  const ramBlocked = ramBudget != null && !ramBudget.fits;

  const patch = useCallback((model: string, next: Partial<Run>) => {
    setRuns((rs) => rs.map((r) => (r.model === model ? { ...r, ...next } : r)));
  }, []);

  /** One standard generate call. Resolves when this model is finished, either way. */
  const runOne = useCallback(
    async (model: string, runSeed: number) => {
      const ac = new AbortController();
      abortRef.current.set(model, ac);
      const startedAt = Date.now();
      patch(model, { state: "running", startedAt, note: undefined });
      try {
        // A cold local model answers 503 model_loading with an ETA. That is not
        // a result — it's "ask again shortly" — and reporting it as a failure
        // makes the comparison lie about the very thing it exists to measure.
        // Seen for real: freeing ComfyUI's VRAM evicted Qwen, so Qwen "failed"
        // in 0.1s while FLUX took a minute and succeeded.
        const warmDeadline = Date.now() + WARMUP_BUDGET_MS;
        let res: Response;
        let j: { error?: string; load?: { eta_s?: number }; image?: string; savedPath?: string };

        for (;;) {
          res = await fetch("/api/image/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model, prompt, width: size.w, height: size.h, seed: runSeed }),
            signal: ac.signal,
          });
          j = await res.json();

          const warming = res.status === 503 || /warming up|model_loading|still loading/i.test(String(j.error ?? ""));
          if (!warming || Date.now() > warmDeadline) break;

          const etaS = Number(j.load?.eta_s);
          const waitMs = Math.min(Math.max(Number.isFinite(etaS) ? etaS * 1000 : 5000, 2000), 20000);
          patch(model, { note: `loading${Number.isFinite(etaS) ? ` — ~${Math.ceil(etaS)}s` : ""}` });
          await new Promise(r => setTimeout(r, waitMs));
          if (ac.signal.aborted) throw new DOMException("Aborted", "AbortError");
        }

        if (!res.ok || j.error) {
          patch(model, { state: "failed", ms: Date.now() - startedAt, note: undefined, error: String(j.error ?? `HTTP ${res.status}`) });
        } else {
          patch(model, {
            state: "done",
            ms: Date.now() - startedAt,
            note: undefined,
            image: j.image,
            savedPath: j.savedPath ?? undefined,
          });
        }
      } catch (e) {
        const aborted = e instanceof DOMException && e.name === "AbortError";
        patch(model, {
          state: aborted ? "cancelled" : "failed",
          ms: Date.now() - startedAt,
          error: aborted ? undefined : e instanceof Error ? e.message : String(e),
        });
      } finally {
        abortRef.current.delete(model);
      }
    },
    [patch, prompt, size],
  );

  const run = useCallback(async () => {
    cancelledAllRef.current = false;
    // Same seed across every model, or the comparison measures luck, not quality.
    const runSeed = Math.floor(Math.random() * 2_147_483_647);
    setSeed(runSeed);

    const chosen = options.filter((o) => picked.includes(o.id));
    setRuns(
      chosen.map((o) => ({
        model: o.id, label: o.label, local: o.local, costUsd: o.cost, state: "queued" as RunState,
      })),
    );

    // Cloud models genuinely run in parallel. Local ones share one GPU, so
    // firing them together would just queue them inside the service where the UI
    // can't see it — running them in sequence here makes "waiting for the GPU"
    // on a tile a fact rather than a guess.
    const cloudIds = chosen.filter((o) => !o.local).map((o) => o.id);
    const localIds = chosen.filter((o) => o.local).map((o) => o.id);

    await Promise.all([
      ...cloudIds.map((id) => runOne(id, runSeed)),
      (async () => {
        for (const id of localIds) {
          if (cancelledAllRef.current) break;
          await runOne(id, runSeed);
        }
      })(),
    ]);
  }, [options, picked, runOne]);

  const cancel = useCallback((model?: string) => {
    if (model) {
      abortRef.current.get(model)?.abort();
      // A queued local model hasn't started, so there's no request to abort —
      // mark it directly or it would sit at "queued" forever.
      setRuns((rs) => rs.map((r) => (r.model === model && r.state === "queued" ? { ...r, state: "cancelled" } : r)));
      return;
    }
    cancelledAllRef.current = true;
    for (const ac of abortRef.current.values()) ac.abort();
    setRuns((rs) => rs.map((r) => (r.state === "queued" || r.state === "running" ? { ...r, state: "cancelled" } : r)));
  }, []);

  const canRun = prompt.trim().length > 0 && picked.length >= 2 && !running && !ramBlocked;

  const doneCount = runs.filter((r) => r.state === "done").length;
  const spent = runs.filter((r) => r.state === "done" && !r.local).reduce((s, r) => s + (r.costUsd ?? 0), 0);
  const fastest = useMemo(() => {
    const finished = runs.filter((r) => r.state === "done" && r.ms != null);
    if (finished.length < 2) return null;
    return finished.reduce((a, b) => ((a.ms ?? 0) <= (b.ms ?? 0) ? a : b));
  }, [runs]);

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-gray-800 bg-gray-900 p-4 space-y-3">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="One prompt, run on every model you pick…"
          rows={3}
          className="w-full rounded-lg bg-gray-950 border border-gray-800 px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-gray-600 resize-y"
        />

        <div className="flex flex-wrap gap-2">
          {options.map((o) => {
            const on = picked.includes(o.id);
            return (
              <button
                key={o.id}
                onClick={() => toggle(o.id)}
                disabled={!!o.blocked || running}
                title={o.blocked ?? undefined}
                className={`rounded-lg border px-2.5 py-1.5 text-left transition disabled:opacity-40 disabled:cursor-not-allowed ${
                  on ? "border-indigo-500/60 bg-indigo-500/10" : "border-gray-800 hover:border-gray-600"
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <span className={`size-2 rounded-full ${on ? "bg-indigo-400" : "bg-gray-700"}`} />
                  <span className="text-xs font-medium text-gray-100">{o.label}</span>
                </div>
                <div className="mt-0.5 flex items-center gap-1.5">
                  <span className="text-[10px] text-gray-500">{o.sub}</span>
                  <span className="text-[10px] text-gray-600">· {fmtCost(o.cost, o.local)}</span>
                </div>
                {/* No guard: the component renders "off-box" for cloud and
                    nothing at all for a local model it has no numbers for. */}
                <ModelFootprint footprint={o.footprint} local={o.local} liveVramMb={o.liveMb} className="mt-1" />
                {o.blocked && <div className="mt-0.5 text-[10px] text-amber-400/80">{o.blocked}</div>}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex gap-1 rounded-lg bg-gray-800 p-0.5">
            {SIZES.map((s) => (
              <button
                key={s.label}
                onClick={() => setSize(s)}
                disabled={running}
                className={`rounded-md px-2 py-1 text-xs transition disabled:opacity-40 ${
                  size.label === s.label ? "bg-gray-100 text-gray-900" : "text-gray-400 hover:text-gray-100"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>

          {running ? (
            <button
              onClick={() => cancel()}
              className="rounded-lg border border-red-700/50 hover:border-red-600 px-3 py-1.5 text-sm font-medium text-red-400 hover:text-red-300 transition"
            >
              Cancel all
            </button>
          ) : (
            <button
              onClick={run}
              disabled={!canRun}
              className="rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed px-3 py-1.5 text-sm font-medium on-accent transition"
            >
              {runs.length ? "Run again" : `Compare ${picked.length || ""}`}
            </button>
          )}

          {/* Spend is stated before the click, not discovered afterwards. */}
          {estCost > 0 && !running && (
            <span className="text-[11px] text-amber-400/90 tabular-nums">~${estCost.toFixed(3)} per run</span>
          )}
          {running && (
            <span className="text-[11px] text-gray-400 tabular-nums">
              {doneCount}/{runs.length} done
              {spent > 0 && <> · ~${spent.toFixed(3)} spent</>}
            </span>
          )}
          {picked.length < 2 && !running && <span className="text-[11px] text-gray-600">Pick at least two.</span>}
          {picked.filter((id) => IMAGE_MODELS.some((m) => m.id === id)).length > 1 && (
            <span className="text-[11px] text-gray-600">Local models run one at a time — they share the GPU.</span>
          )}
        </div>

        {/* The constraint that actually breaks this box, said before the click
            rather than discovered as a dead service. Names the pairing, because
            "out of memory" alone doesn't tell you which two to separate. */}
        {ramBlocked && ramBudget && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 space-y-1">
            <p className="text-xs text-red-300">
              Won&apos;t fit in system RAM — needs{" "}
              <span className="tabular-nums font-medium">~{ramBudget.requiredGb} GB</span> with only{" "}
              <span className="tabular-nums font-medium">{ramBudget.freeGb} GB</span> free.
            </p>
            <p className="text-[11px] text-red-300/70">
              {ramBudget.parts.map((p) => `${p.serviceId} ~${p.ramGb} GB`).join(" + ")} — these keep their
              weights in host RAM and don&apos;t release them between runs. Run them separately, or stop one
              service first.
            </p>
          </div>
        )}
        {!ramBlocked && ramBudget && ramBudget.requiredGb > 0 && !running && (
          <p className="text-[11px] text-gray-600 tabular-nums">
            host RAM: ~{ramBudget.requiredGb} GB needed · {ramBudget.freeGb} GB free ·{" "}
            {ramBudget.headroomGb} GB headroom
          </p>
        )}
      </section>

      {runs.length > 0 && (
        <section className="space-y-2">
          <div className="flex items-center gap-3 text-[11px] text-gray-500 flex-wrap">
            {seed != null && (
              <span>seed <span className="font-mono text-gray-400">{seed}</span> — same for every model</span>
            )}
            <span className="text-gray-700">·</span>
            <span>saved to Activity, tagged by model</span>
            {fastest && !running && (
              <>
                <span className="text-gray-700">·</span>
                <span className="text-emerald-400/80">
                  fastest {fastest.label} at {((fastest.ms ?? 0) / 1000).toFixed(1)}s
                </span>
              </>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {runs.map((r) => {
              const elapsed =
                r.state === "running" && r.startedAt ? (now - r.startedAt) / 1000 : (r.ms ?? 0) / 1000;
              return (
                <div key={r.model} className="rounded-xl border border-gray-800 bg-gray-900 overflow-hidden flex flex-col">
                  {/* The image slot keeps a floor height in every state, so tiles
                      don't jump around as each model lands. */}
                  <div className="relative bg-gray-950 min-h-40 flex items-center justify-center">
                    {r.state === "done" && r.image ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={r.image} alt={r.label} className="w-full block" />
                    ) : r.state === "failed" ? (
                      <p className="p-4 text-xs text-red-400 break-words">{r.error ?? "failed"}</p>
                    ) : r.state === "cancelled" ? (
                      <p className="p-4 text-xs text-gray-600">cancelled</p>
                    ) : r.state === "running" ? (
                      <div className="flex flex-col items-center gap-2 p-4">
                        <span className="inline-block w-4 h-4 rounded-full border-2 border-amber-400 border-t-transparent animate-spin" />
                        <span className="text-[11px] text-gray-500 tabular-nums">{elapsed.toFixed(1)}s</span>
                        {/* Without this a cold model is indistinguishable from a stalled one. */}
                        {r.note && <span className="text-[10px] text-amber-400/80">{r.note}</span>}
                      </div>
                    ) : (
                      <p className="p-4 text-[11px] text-gray-600">
                        {r.local ? "waiting for the GPU" : "queued"}
                      </p>
                    )}
                  </div>

                  <div className="p-2.5 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-medium text-gray-100">{r.label}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${STATE_STYLE[r.state]}`}>
                        {r.state}
                      </span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${
                        r.local
                          ? "bg-violet-500/15 text-violet-300 border-violet-500/30"
                          : "bg-gray-600/20 text-gray-400 border-gray-600/40"
                      }`}>
                        {r.local ? "local" : "cloud"}
                      </span>
                      {(r.state === "queued" || r.state === "running") && (
                        <button
                          onClick={() => cancel(r.model)}
                          className="ml-auto text-[10px] text-gray-500 hover:text-red-400 transition"
                        >
                          cancel
                        </button>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-[11px] text-gray-500 tabular-nums">
                      <span>{r.state === "done" || r.state === "failed" ? `${elapsed.toFixed(1)}s` : "—"}</span>
                      <span className="text-gray-700">·</span>
                      <span className={r.local ? "text-emerald-400/80" : "text-amber-400/80"}>
                        {fmtCost(r.costUsd, r.local)}
                      </span>
                    </div>
                    {r.savedPath && <p className="text-[10px] text-gray-600 font-mono break-all">{r.savedPath}</p>}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
