import { NextRequest, NextResponse } from "next/server";
import { CLOUD_DECISION_MODELS, DEFAULT_DECIDE_MODEL, normalizeDecideRequest } from "@/lib/decide";
import { decide, hostDecisionModels } from "@/lib/decide-server";

export const dynamic = "force-dynamic";
/** An LLM compared through here can be a cold local model. Laya answers in tens of ms. */
export const maxDuration = 900;

/**
 * POST /api/decide — one typed decision.
 *
 *   { question, choices, type?, context, model? }
 *   → { choice, probabilities, confidence, latencyMs, model, local, ... }
 *
 * The contract is src/lib/decide.ts and docs/decide-api.md. The default model
 * is Laya, the decision model on this box; pass a router chat alias
 * ("claude-haiku", "local-gemma4") to ask an LLM the same question in the same
 * shape. Callers: the Decision Lab, the MCP `decide` tool, the BPMN gateways.
 *
 * Deliberately NOT recorded in the Lab runs record — a process engine calling
 * this per token would bury the Lab's history. The Lab records through
 * /api/labs/decide/run. X-Source tags the call for the Requests view as usual.
 *
 * Status codes: 400 bad request, 404 unknown decision model, 503 service not
 * running or still loading, 409 resource coordinator refused (LLM path; the
 * body has resourceBlocked: true), 502 the model failed.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const n = normalizeDecideRequest(body);
  if (!n.ok) return NextResponse.json({ error: n.error }, { status: 400 });

  const source = req.headers.get("x-source") || "console-decide";
  const out = await decide(n.req, {
    source,
    owner: `decide:${source}:${n.req.model}`,
    signal: req.signal,
    timeoutMs: maxDuration * 1000,
  });
  return NextResponse.json(out.body, { status: out.status });
}

/** GET /api/decide — what this host can decide with, and the request shape. */
export async function GET() {
  return NextResponse.json({
    defaultModel: DEFAULT_DECIDE_MODEL,
    decisionModels: hostDecisionModels(),
    cloudDecisionModels: Object.entries(CLOUD_DECISION_MODELS).map(([model, m]) => ({
      model,
      name: m.name,
      ready: !!process.env[m.keyEnv],
      costPerMTokIn: m.costPerMTokIn,
    })),
    llms: "Any router chat alias (see /api/providers) — asked the same question and parsed to the same shape.",
    request: {
      question: "string (required)",
      choices: "string[] | { label: description } (2-64; ignored for yesno)",
      type: '"choice" (default) | "yesno" | "score" (choices ordered low → high)',
      context: "string | object — what the decision is about",
      model: `"${DEFAULT_DECIDE_MODEL}" (default) | a decision model above | a cloud decision model above | a router chat alias`,
    },
    response: {
      choice: "the chosen label",
      probabilities: "{ label: p } over every label, summing to 1",
      confidence: "p of the chosen label",
      latencyMs: "wall-clock for the call",
      modelLatencyMs: "decision models: the forward pass alone",
      model: "what answered",
      local: "whether it ran on this machine",
      costUsd: "router cost for a cloud LLM; null when not metered",
      parsed: "LLMs only: false if the reply was not the requested JSON and the distribution is a fallback",
    },
    docs: "docs/decide-api.md",
  });
}
