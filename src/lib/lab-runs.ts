import { randomUUID } from "crypto";
import { getDb } from "./db";
import { getHost } from "./host";
import { gpuReading } from "./sysinfo";

/**
 * The runs record: every Lab run, persisted.
 *
 * Without it "compare" meant whatever happened to be on screen, and nothing was
 * reproducible — the Arena scores a run and forgets it on reload. Lives in the
 * console's existing DuckDB store (src/lib/db.ts, alongside `images` and
 * `batch_jobs`) rather than a new file: it is the same kind of history, it is
 * already outside the project root where the file watcher cannot see it, and
 * one store is one thing to back up.
 *
 * A Lab's run route does this:
 *
 *   const m = await measureRun(() => doTheWork(), { local });   // never throws
 *   const run = await recordLabRun({
 *     lab: "video", capability: "video", model, local,
 *     status: m.ok ? "ok" : "error", error: m.ok ? null : String(m.error),
 *     ...m.measurement,
 *   });
 *
 * or, for runs that happen somewhere the console cannot wrap, POST the same
 * fields to /api/labs/runs (without VRAM — only the server can sample the card).
 */

export type LabRunInput = {
  lab: string;
  capability: string;
  model: string;
  local: boolean;
  /** Shared by the runs of one side-by-side comparison. */
  compareGroup?: string | null;
  /** What was asked, trimmed. Never the whole prompt or file. */
  inputSummary?: string;
  /** Capability-specific settings (steps, temperature, size…). */
  params?: Record<string, unknown>;
  seed?: number | null;
  status: "ok" | "error";
  error?: string | null;
  latencyMs?: number | null;
  peakVramGb?: number | null;
  baselineVramGb?: number | null;
  /** Why VRAM is what it is — "card-wide peak", "unified memory: not measured"… */
  vramNote?: string | null;
  costUsd?: number | null;
  /** Where the artifact landed on disk, for Labs that produce files. */
  outputPath?: string | null;
  /** A short excerpt or description of the output. */
  outputSummary?: string | null;
};

export type LabRun = Required<Omit<LabRunInput, "params">> & {
  id: string;
  host: string;
  params: Record<string, unknown>;
  createdAt: string;
};

type Row = {
  id: string;
  lab: string;
  capability: string;
  model: string;
  host: string;
  local: boolean;
  compare_group: string | null;
  input_summary: string;
  params: string;
  seed: number | bigint | null;
  status: "ok" | "error";
  error: string | null;
  latency_ms: number | null;
  peak_vram_gb: number | null;
  baseline_vram_gb: number | null;
  vram_note: string | null;
  cost_usd: number | null;
  output_path: string | null;
  output_summary: string | null;
  created_at: string;
};

const clip = (s: string | null | undefined, n: number) =>
  s == null ? null : s.length > n ? `${s.slice(0, n - 1)}…` : s;

function fromRow(r: Row): LabRun {
  let params: Record<string, unknown> = {};
  try {
    params = JSON.parse(r.params);
  } catch {
    /* keep {} */
  }
  return {
    id: r.id,
    lab: r.lab,
    capability: r.capability,
    model: r.model,
    host: r.host,
    local: !!r.local,
    compareGroup: r.compare_group,
    inputSummary: r.input_summary,
    params,
    // DuckDB returns BIGINT as bigint, which JSON.stringify refuses.
    seed: r.seed == null ? null : Number(r.seed),
    status: r.status,
    error: r.error,
    latencyMs: r.latency_ms,
    peakVramGb: r.peak_vram_gb,
    baselineVramGb: r.baseline_vram_gb,
    vramNote: r.vram_note,
    costUsd: r.cost_usd,
    outputPath: r.output_path,
    outputSummary: r.output_summary,
    createdAt: r.created_at,
  };
}

/**
 * Persist one run. Never throws: a Lab whose result could not be recorded
 * should still show the result, so failure is logged and returned as null.
 */
export async function recordLabRun(input: LabRunInput): Promise<LabRun | null> {
  const id = `run_${randomUUID()}`;
  const createdAt = new Date().toISOString();
  const host = getHost().id;
  try {
    const db = await getDb();
    await db.run(
      `INSERT INTO lab_runs (id, lab, capability, model, host, local, compare_group, input_summary, params, seed,
         status, error, latency_ms, peak_vram_gb, baseline_vram_gb, vram_note, cost_usd, output_path, output_summary, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.lab,
        input.capability,
        input.model,
        host,
        input.local,
        input.compareGroup ?? null,
        clip(input.inputSummary ?? "", 400),
        JSON.stringify(input.params ?? {}),
        input.seed ?? null,
        input.status,
        clip(input.error ?? null, 1000),
        input.latencyMs == null ? null : Math.round(input.latencyMs),
        input.peakVramGb ?? null,
        input.baselineVramGb ?? null,
        input.vramNote ?? null,
        input.costUsd ?? null,
        input.outputPath ?? null,
        clip(input.outputSummary ?? null, 600),
        createdAt,
      ],
    );
    const row = await db.get<Row>(`SELECT * FROM lab_runs WHERE id = ?`, [id]);
    return row ? fromRow(row) : null;
  } catch (err) {
    console.error("[lab-runs] could not record run:", err);
    return null;
  }
}

export async function listLabRuns(opts: { lab?: string; limit?: number } = {}): Promise<LabRun[]> {
  const limit = Math.max(1, Math.min(200, opts.limit ?? 30));
  const db = await getDb();
  const rows = opts.lab
    ? await db.all<Row>(`SELECT * FROM lab_runs WHERE lab = ? ORDER BY created_at DESC LIMIT ${limit}`, [opts.lab])
    : await db.all<Row>(`SELECT * FROM lab_runs ORDER BY created_at DESC LIMIT ${limit}`);
  return rows.map(fromRow);
}

// ── measurement ─────────────────────────────────────────────────────────────

export type RunMeasurement = {
  latencyMs: number;
  peakVramGb: number | null;
  baselineVramGb: number | null;
  vramNote: string;
};

const SAMPLE_MS = 500;

/**
 * Run `work`, timing it and sampling the card's memory while it runs.
 *
 * What the VRAM number is, honestly: the highest card-wide `memory.used`
 * nvidia-smi reported during the run, next to what it was just before. It is
 * not per-process — nvidia-smi on Windows (WDDM) does not report per-process
 * usage — so a concurrent job elsewhere on the card inflates it, and a model
 * that reserved its memory at start-up (vLLM) shows peak ≈ baseline. The delta
 * is the part this run added; the note says which case you are looking at.
 *
 * On a unified-memory host (B5) "VRAM" is system RAM and moves with everything
 * the machine does, so it is not recorded at all rather than recorded wrong.
 * A cloud run gets no reading either: the card has nothing to do with it.
 */
export async function measureRun<T>(
  work: () => Promise<T>,
  opts: { local: boolean },
): Promise<
  | { ok: true; result: T; measurement: RunMeasurement }
  // A failed run is still a run worth recording, with its latency — so the
  // error is returned alongside the measurement rather than thrown past it.
  | { ok: false; error: unknown; measurement: RunMeasurement }
> {
  const host = getHost();
  const sampleable = opts.local && host.gpu === "nvidia" && host.memory.kind === "discrete";

  let baseline: number | null = null;
  let peak: number | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const sample = async () => {
    try {
      const mb = (await gpuReading()).mem_used;
      const gb = mb / 1024;
      if (peak == null || gb > peak) peak = gb;
      return gb;
    } catch {
      return null;
    }
  };

  if (sampleable) {
    baseline = await sample();
    timer = setInterval(() => void sample(), SAMPLE_MS);
  }

  const started = Date.now();
  try {
    const result = await work();
    const latencyMs = Date.now() - started;
    if (sampleable) await sample();
    return { ok: true, result, measurement: finish(latencyMs) };
  } catch (error) {
    return { ok: false, error, measurement: finish(Date.now() - started) };
  } finally {
    if (timer) clearInterval(timer);
  }

  function finish(latencyMs: number): RunMeasurement {
    if (!opts.local) {
      return { latencyMs, peakVramGb: null, baselineVramGb: null, vramNote: "Cloud run — no local memory used." };
    }
    if (!sampleable) {
      return {
        latencyMs,
        peakVramGb: null,
        baselineVramGb: null,
        vramNote:
          host.memory.kind === "unified"
            ? "Unified memory — not measured, it moves with everything on the machine."
            : "No GPU probe on this host.",
      };
    }
    const round = (n: number | null) => (n == null ? null : Math.round(n * 100) / 100);
    return {
      latencyMs,
      peakVramGb: round(peak),
      baselineVramGb: round(baseline),
      vramNote: "Card-wide peak from nvidia-smi, sampled every 0.5 s; not per-process.",
    };
  }
}
