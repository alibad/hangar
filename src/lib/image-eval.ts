// Shared shapes and arithmetic for the image evaluation suite
// (experiments/image-eval). Kept free of React and Node so the runner script,
// the API route, the Eval view and the tests all agree on what a cell is.

export type EvalCell = {
  study: "suite" | "resolution" | "edit" | "edit-source";
  model: string;
  promptId: string;
  seed?: number;
  variant?: string;
  ok: boolean;
  latencyMs?: number;
  /** Cloud only: what the router's cost log says this call cost. */
  costUsd?: number;
  peakMiB?: number;
  baselineMiB?: number;
  savedPath?: string | null;
  requested?: string;
  kind?: string;
  error?: string;
  coordinator?: unknown;
};

/** Verdicts keyed by cellKey, then by check text (or PICK). */
export type Verdicts = Record<string, Record<string, boolean>>;

export const PICK = "__pick";

export function cellKey(c: Pick<EvalCell, "study" | "model" | "promptId" | "seed" | "variant">): string {
  return [c.study, c.model, c.promptId, c.seed ?? "", c.variant ?? ""].join("|");
}

export type ModelSummary = {
  model: string;
  images: number;
  failures: number;
  /** Objective checks the user has judged, and how many passed. */
  judged: number;
  passed: number;
  /** Times the user picked this model's image as the one they prefer. */
  picks: number;
  medianLatencyMs: number | null;
  maxPeakMiB: number | null;
  /** Mean cost per successful image, when the cells carry one (cloud). */
  meanCostUsd: number | null;
};

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/**
 * Per-model totals for one study. Pass rates count only checks someone has
 * actually judged — an unjudged check is unknown, not a failure.
 */
export function summarize(cells: EvalCell[], verdicts: Verdicts, study: EvalCell["study"] = "suite"): ModelSummary[] {
  const by = new Map<string, EvalCell[]>();
  for (const c of cells) {
    if (c.study !== study) continue;
    by.set(c.model, [...(by.get(c.model) ?? []), c]);
  }
  return [...by.entries()].map(([model, cs]) => {
    let judged = 0, passed = 0, picks = 0;
    for (const c of cs) {
      const v = verdicts[cellKey(c)] ?? {};
      for (const [check, value] of Object.entries(v)) {
        if (check === PICK) { if (value) picks++; continue; }
        judged++;
        if (value) passed++;
      }
    }
    const ok = cs.filter((c) => c.ok);
    return {
      model,
      images: ok.length,
      failures: cs.length - ok.length,
      judged,
      passed,
      picks,
      medianLatencyMs: median(ok.map((c) => c.latencyMs ?? NaN).filter(Number.isFinite)),
      maxPeakMiB: ok.some((c) => c.peakMiB != null) ? Math.max(...ok.map((c) => c.peakMiB ?? 0)) : null,
      meanCostUsd: ok.some((c) => c.costUsd != null) ? ok.reduce((s, c) => s + (c.costUsd ?? 0), 0) / ok.length : null,
    };
  });
}
