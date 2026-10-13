/**
 * Scoring for the decision experiment: accuracy, and whether the probabilities
 * mean what they say.
 *
 * Calibration is the reason a decision model is interesting at all — a 30B
 * LLM's "confidence" is a number it wrote, not a probability — so it is
 * measured three ways: expected calibration error (ECE, 10 equal-width bins on
 * the top-label probability, the usual definition and the one Laya's card
 * quotes), the reliability table it is computed from, and Brier / NLL, which
 * punish confident mistakes that ECE's binning can hide.
 *
 * Pure, no imports: the bench script, the Decision Lab's API and the node test
 * runner all use it.
 */

export type Prediction = {
  id: string;
  label: string;
  choice: string;
  probabilities: Record<string, number>;
  latencyMs?: number | null;
  costUsd?: number | null;
  parsed?: boolean;
  error?: string | null;
};

export type ReliabilityBin = { lo: number; hi: number; n: number; confidence: number; accuracy: number };

const EPS = 1e-6;

function topProb(p: Prediction): number {
  return p.probabilities[p.choice] ?? Math.max(0, ...Object.values(p.probabilities));
}

/** Predictions that produced an answer at all. Errors count against accuracy separately. */
function answered(preds: Prediction[]): Prediction[] {
  return preds.filter((p) => !p.error && Object.keys(p.probabilities).length > 0);
}

export function accuracy(preds: Prediction[]): number {
  if (!preds.length) return 0;
  // An errored call is a wrong answer: a caller replacing an LLM call gets nothing.
  return preds.filter((p) => !p.error && p.choice === p.label).length / preds.length;
}

export function macroF1(preds: Prediction[], labels: string[]): number {
  const ok = answered(preds);
  const f1s = labels.map((l) => {
    const tp = ok.filter((p) => p.choice === l && p.label === l).length;
    const fp = ok.filter((p) => p.choice === l && p.label !== l).length;
    const fn = preds.filter((p) => p.label === l && p.choice !== l).length;
    const prec = tp + fp ? tp / (tp + fp) : 0;
    const rec = tp + fn ? tp / (tp + fn) : 0;
    return prec + rec ? (2 * prec * rec) / (prec + rec) : 0;
  });
  return f1s.reduce((a, b) => a + b, 0) / (labels.length || 1);
}

export function reliability(preds: Prediction[], bins = 10): ReliabilityBin[] {
  const out: ReliabilityBin[] = Array.from({ length: bins }, (_, i) => ({
    lo: i / bins,
    hi: (i + 1) / bins,
    n: 0,
    confidence: 0,
    accuracy: 0,
  }));
  for (const p of answered(preds)) {
    const c = topProb(p);
    const i = Math.min(bins - 1, Math.floor(c * bins));
    out[i].n += 1;
    out[i].confidence += c;
    out[i].accuracy += p.choice === p.label ? 1 : 0;
  }
  for (const b of out) {
    if (b.n) {
      b.confidence /= b.n;
      b.accuracy /= b.n;
    }
  }
  return out;
}

/** Expected calibration error over answered predictions. 0 is perfect. */
export function ece(preds: Prediction[], bins = 10): number {
  const ok = answered(preds);
  if (!ok.length) return 0;
  return reliability(ok, bins).reduce((s, b) => s + (b.n / ok.length) * Math.abs(b.accuracy - b.confidence), 0);
}

/** Multi-class Brier score, summed over classes (0 perfect, 2 worst). */
export function brier(preds: Prediction[]): number {
  const ok = answered(preds);
  if (!ok.length) return 0;
  let s = 0;
  for (const p of ok) {
    for (const [l, v] of Object.entries(p.probabilities)) s += (v - (l === p.label ? 1 : 0)) ** 2;
    if (!(p.label in p.probabilities)) s += 1;
  }
  return s / ok.length;
}

/** Mean negative log-likelihood of the true label, floored so a zero is finite but loud. */
export function nll(preds: Prediction[]): number {
  const ok = answered(preds);
  if (!ok.length) return 0;
  return ok.reduce((s, p) => s - Math.log(Math.max(EPS, p.probabilities[p.label] ?? 0)), 0) / ok.length;
}

/** Share of answered predictions that gave the true label (near) zero probability. */
export function zeroOnTruth(preds: Prediction[], below = 0.01): number {
  const ok = answered(preds);
  if (!ok.length) return 0;
  return ok.filter((p) => (p.probabilities[p.label] ?? 0) < below).length / ok.length;
}

/** p ∝ p^(1/T): temperature scaling applied to probabilities (logits = log p). */
export function temper(probabilities: Record<string, number>, t: number): Record<string, number> {
  const labels = Object.keys(probabilities);
  const w = labels.map((l) => Math.exp(Math.log(Math.max(EPS, probabilities[l])) / t));
  const z = w.reduce((a, b) => a + b, 0);
  return Object.fromEntries(labels.map((l, i) => [l, w[i] / z]));
}

const T_GRID = Array.from({ length: 60 }, (_, i) => Math.exp(Math.log(0.2) + (i / 59) * Math.log(10 / 0.2)));

function fitT(preds: Prediction[]): number {
  let best = 1;
  let bestNll = Infinity;
  for (const t of T_GRID) {
    const v = nll(preds.map((p) => ({ ...p, probabilities: temper(p.probabilities, t) })));
    if (v < bestNll) {
      bestNll = v;
      best = t;
    }
  }
  return best;
}

/**
 * ECE after fitting ONE temperature per task, cross-fitted: fit on the even
 * items, score the odd ones, and vice versa. The vendor's 0.081 ECE is
 * "post-temperature"; this is the fair version of that number on our data —
 * a temperature fitted on the very items it is scored on would flatter anyone.
 * Temperature never changes the argmax, so accuracy is unaffected.
 */
export function eceAfterTemperature(preds: Prediction[], bins = 10): { ece: number; temperature: number } {
  const ok = answered(preds);
  if (ok.length < 4) return { ece: ece(ok, bins), temperature: 1 };
  const a = ok.filter((_, i) => i % 2 === 0);
  const b = ok.filter((_, i) => i % 2 === 1);
  const ta = fitT(a);
  const tb = fitT(b);
  const scored = [
    ...b.map((p) => ({ ...p, probabilities: temper(p.probabilities, ta) })),
    ...a.map((p) => ({ ...p, probabilities: temper(p.probabilities, tb) })),
  ];
  return { ece: ece(scored, bins), temperature: fitT(ok) };
}

export function percentile(values: number[], q: number): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const idx = Math.min(v.length - 1, Math.max(0, Math.ceil(q * v.length) - 1));
  return v[idx];
}

export function confusion(preds: Prediction[], labels: string[]): Record<string, Record<string, number>> {
  const m: Record<string, Record<string, number>> = {};
  for (const l of labels) m[l] = Object.fromEntries([...labels, "error"].map((c) => [c, 0]));
  for (const p of preds) {
    if (!m[p.label]) continue;
    const col = p.error ? "error" : p.choice in m[p.label] ? p.choice : "error";
    m[p.label][col] += 1;
  }
  return m;
}

export type SetScore = {
  n: number;
  accuracy: number;
  macroF1: number;
  ece: number;
  eceAfterTemperature: number;
  temperature: number;
  brier: number;
  nll: number;
  zeroOnTruth: number;
  errors: number;
  unparsed: number;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  /** Summed metered cost; null when nothing was metered (a local model). */
  costUsd: number | null;
  costPer1000Usd: number | null;
  reliability: ReliabilityBin[];
  confusion: Record<string, Record<string, number>>;
};

export function scoreSet(preds: Prediction[], labels: string[]): SetScore {
  const lat = preds.map((p) => p.latencyMs ?? NaN);
  const costs = preds.map((p) => p.costUsd).filter((c): c is number => typeof c === "number");
  const cost = costs.length ? costs.reduce((a, b) => a + b, 0) : null;
  const t = eceAfterTemperature(preds);
  return {
    n: preds.length,
    accuracy: accuracy(preds),
    macroF1: macroF1(preds, labels),
    ece: ece(preds),
    eceAfterTemperature: t.ece,
    temperature: t.temperature,
    brier: brier(preds),
    nll: nll(preds),
    zeroOnTruth: zeroOnTruth(preds),
    errors: preds.filter((p) => p.error).length,
    unparsed: preds.filter((p) => p.parsed === false).length,
    latencyP50Ms: percentile(lat, 0.5),
    latencyP95Ms: percentile(lat, 0.95),
    costUsd: cost,
    costPer1000Usd: cost != null && preds.length ? (cost / preds.length) * 1000 : null,
    reliability: reliability(preds),
    confusion: confusion(preds, labels),
  };
}
