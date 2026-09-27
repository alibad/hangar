/**
 * The decision contract: one typed question, a context, a distribution back.
 *
 *   POST /api/decide
 *     { question: "Should this go to a cloud model?",
 *       choices: ["local", "cloud"] | { local: "what counts", cloud: "..." },
 *       type?: "choice" | "yesno" | "score",      // default "choice"
 *       context: "text" | { any: "json" },
 *       model?: "laya" | "laya-english" | "laya-multilingual" | "laya-typed-decisions"
 *              | <any router chat alias, e.g. "claude-haiku", "local-gemma4"> }
 *   → { choice, probabilities: { label: p }, confidence, latencyMs, model, local,
 *       checkpoint?, costUsd?, parsed? }
 *
 * The same shape whether a decision model or an LLM answered, so a caller (the
 * Decision Lab, the MCP tool, a BPMN gateway) can swap one for the other and
 * compare. `probabilities` always has every label, sums to 1, and for "yesno"
 * the labels are exactly "yes" and "no".
 *
 * Pure — no imports — so the Next route, scripts/decide-bench.mjs and the node
 * test runner all use this one file. docs/decide-api.md is the written contract.
 */

export type DecideType = "choice" | "yesno" | "score";

export type DecideRequest = {
  question: string;
  type: DecideType;
  /** Label → description. For a bare list, each label is its own description. */
  choices: Record<string, string>;
  /** What the decision is about. A string, or an object serialised for LLMs. */
  context: string | Record<string, unknown>;
  model: string;
};

export type DecideResult = {
  choice: string;
  probabilities: Record<string, number>;
  /** Probability of the chosen label: the number calibration is measured on. */
  confidence: number;
  /** Wall-clock for the whole call, as the caller experiences it. */
  latencyMs: number;
  /** Decision models only: the forward pass alone, as the service timed it. */
  modelLatencyMs?: number | null;
  model: string;
  local: boolean;
  /** Which Laya checkpoint answered, when a Laya model did. */
  checkpoint?: string | null;
  routingReason?: string | null;
  /** Decision models only: "cpu" or "cuda", as the service reports it. */
  device?: string | null;
  costUsd?: number | null;
  /**
   * For LLMs: whether the answer parsed as the requested JSON. false means the
   * distribution is a fallback (one-hot on a label found in the text, or
   * uniform) — reported rather than hidden, because it is a real failure mode.
   */
  parsed?: boolean;
  /** Expected level for "score" questions (0-based), Laya only. */
  score?: number;
};

/** Decision models served by the Laya service. Anything else is a router alias. */
export const LAYA_MODELS = ["laya", "laya-english", "laya-multilingual", "laya-typed-decisions"] as const;

export function isLayaModel(model: string): boolean {
  return (LAYA_MODELS as readonly string[]).includes(model);
}

export const DEFAULT_DECIDE_MODEL = "laya";

/** Validate an untrusted body. Returns the normalised request or a sentence saying what is wrong. */
export function normalizeDecideRequest(body: unknown): { ok: true; req: DecideRequest } | { ok: false; error: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const question = typeof b.question === "string" ? b.question.trim() : "";
  if (!question) return { ok: false, error: "question is required" };

  const type = (b.type ?? "choice") as DecideType;
  if (type !== "choice" && type !== "yesno" && type !== "score") {
    return { ok: false, error: `type must be "choice", "yesno" or "score", not "${String(b.type)}"` };
  }

  let choices: Record<string, string> = {};
  if (type === "yesno") {
    choices = { yes: "yes", no: "no" };
  } else if (Array.isArray(b.choices)) {
    for (const c of b.choices) {
      const label = typeof c === "string" ? c.trim() : "";
      if (label) choices[label] = label;
    }
  } else if (b.choices && typeof b.choices === "object") {
    for (const [k, v] of Object.entries(b.choices as Record<string, unknown>)) {
      const label = k.trim();
      if (label) choices[label] = typeof v === "string" && v.trim() ? v.trim() : label;
    }
  }
  if (type !== "yesno" && Object.keys(choices).length < 2) {
    return { ok: false, error: "choices needs at least two distinct options" };
  }
  if (Object.keys(choices).length > 64) {
    return { ok: false, error: "at most 64 choices (Laya's accuracy falls off well before that — see the experiment doc)" };
  }

  let context: string | Record<string, unknown> = "";
  if (typeof b.context === "string") context = b.context;
  else if (b.context && typeof b.context === "object" && !Array.isArray(b.context)) context = b.context as Record<string, unknown>;
  else if (b.context != null) return { ok: false, error: "context must be a string or an object" };

  const model = typeof b.model === "string" && b.model.trim() ? b.model.trim() : DEFAULT_DECIDE_MODEL;
  return { ok: true, req: { question, type, choices, context, model } };
}

export function contextText(context: DecideRequest["context"]): string {
  return typeof context === "string" ? context : JSON.stringify(context, null, 2);
}

// ── LLMs as deciders ────────────────────────────────────────────────────────

/**
 * The prompt an LLM gets for the same decision. Asks for a JSON distribution
 * because that is the most a chat API gives a caller: Claude exposes no token
 * log-probabilities, so a verbalised probability is the honest comparison —
 * it is what someone replacing an LLM call would actually have.
 */
export function buildLlmPrompt(req: DecideRequest): string {
  const labels = Object.keys(req.choices);
  const options = labels
    .map((l) => (req.choices[l] && req.choices[l] !== l ? `- ${l}: ${req.choices[l]}` : `- ${l}`))
    .join("\n");
  const ctx = contextText(req.context).trim();
  const kind = req.type === "score" ? " The options are ordered from lowest to highest." : "";
  return [
    "You are a classifier. Answer the question about the input by choosing exactly one option.",
    `Question: ${req.question}`,
    `Options:${kind}\n${options}`,
    ctx ? `Input:\n"""\n${ctx}\n"""` : "",
    "Reply with JSON only, no prose and no code fence, in exactly this shape:",
    `{"choice": "<one of: ${labels.join(", ")}>", "probabilities": {${labels.map((l) => `"${l}": <0-1>`).join(", ")}}}`,
    "The probabilities must cover every option, sum to 1, and reflect how confident you really are.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Normalise any non-negative weights over `labels` to a distribution; uniform if empty. */
export function normalizeDistribution(labels: string[], raw: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  let sum = 0;
  for (const l of labels) {
    const v = Number(raw[l]);
    out[l] = Number.isFinite(v) && v > 0 ? v : 0;
    sum += out[l];
  }
  for (const l of labels) out[l] = sum > 0 ? out[l] / sum : 1 / labels.length;
  return out;
}

function findLabel(labels: string[], s: unknown): string | null {
  if (typeof s !== "string") return null;
  const t = s.trim().toLowerCase();
  return labels.find((l) => l.toLowerCase() === t) ?? null;
}

/**
 * Parse an LLM's reply into a distribution over `labels`.
 *
 * Tolerates a code fence and prose around the JSON, case differences in labels,
 * probabilities given as percentages, and a missing or disagreeing `choice`
 * (the distribution wins: that is the number being evaluated). Never throws.
 */
export function parseLlmDecision(
  text: string,
  labels: string[],
): { choice: string; probabilities: Record<string, number>; parsed: boolean } {
  const fallback = (hit: string | null) => {
    const probs = Object.fromEntries(labels.map((l) => [l, hit ? (l === hit ? 1 : 0) : 1 / labels.length]));
    return { choice: hit ?? labels[0], probabilities: probs, parsed: false };
  };

  const match = text.match(/\{[\s\S]*\}/);
  let obj: Record<string, unknown> | null = null;
  if (match) {
    try {
      obj = JSON.parse(match[0]);
    } catch {
      obj = null;
    }
  }
  if (!obj) {
    // No JSON: take the first label mentioned as a whole word, one-hot.
    const lower = text.toLowerCase();
    const hit = labels
      .map((l) => ({ l, i: lower.search(new RegExp(`\\b${l.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`)) }))
      .filter((x) => x.i >= 0)
      .sort((a, b) => a.i - b.i)[0]?.l;
    return fallback(hit ?? null);
  }

  const rawProbs = (obj.probabilities && typeof obj.probabilities === "object" ? obj.probabilities : {}) as Record<string, unknown>;
  const weights: Record<string, number> = {};
  let any = false;
  for (const [k, v] of Object.entries(rawProbs)) {
    const label = findLabel(labels, k);
    const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
    if (label && Number.isFinite(n) && n >= 0) {
      weights[label] = (weights[label] ?? 0) + n;
      any = true;
    }
  }
  const choiceLabel = findLabel(labels, obj.choice);
  if (!any) return fallback(choiceLabel);

  // Percentages ("85") arrive as numbers > 1; normalising handles them the same.
  const probabilities = normalizeDistribution(labels, weights);
  const argmax = labels.reduce((a, b) => (probabilities[b] > probabilities[a] ? b : a), labels[0]);
  return { choice: argmax, probabilities, parsed: true };
}

export function argmax(probabilities: Record<string, number>): string {
  const labels = Object.keys(probabilities);
  return labels.reduce((a, b) => (probabilities[b] > probabilities[a] ? b : a), labels[0]);
}
