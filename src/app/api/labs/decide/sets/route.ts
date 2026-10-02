import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

const SETS_DIR = path.join(process.cwd(), "experiments", "decide", "sets");
const RESULTS_DIR = path.join(process.cwd(), "experiments", "decide", "results");

/**
 * GET /api/labs/decide/sets — the labelled sets (as Decision Lab presets) and
 * the latest benchmark summary over them.
 *
 * The sets are experiments/decide/sets/*.json; the summary is the newest
 * experiments/decide/results/*.summary.json written by
 * scripts/decide-bench.mjs. From the full results file beside it, only what
 * each headline model answered per item is sent (`recorded`): enough for the
 * Lab to show "what each said when we tested it" with nothing running.
 */
const RECORDED_MODELS = ["laya", "jev", "local-gemma4", "claude-haiku"];

type Prediction = { choice?: string; probabilities?: Record<string, number>; latencyMs?: number | null; costUsd?: number | null; error?: string };

function recorded(summaryFile: string) {
  const full = path.join(RESULTS_DIR, summaryFile.replace(/\.summary\.json$/, ".json"));
  if (!fs.existsSync(full)) return null;
  try {
    const { predictions } = JSON.parse(fs.readFileSync(full, "utf8")) as {
      predictions: Record<string, Record<string, Record<string, Prediction>>>;
    };
    const answers: Record<string, Record<string, Record<string, { choice: string; confidence: number; latencyMs: number | null; costUsd: number | null }>>> = {};
    for (const [setId, byModel] of Object.entries(predictions ?? {})) {
      for (const model of RECORDED_MODELS) {
        for (const [itemId, p] of Object.entries(byModel[model] ?? {})) {
          if (!p?.choice || p.error) continue;
          const conf = p.probabilities?.[p.choice] ?? Math.max(0, ...Object.values(p.probabilities ?? {}));
          ((answers[setId] ??= {})[itemId] ??= {})[model] = {
            choice: p.choice,
            confidence: conf,
            latencyMs: p.latencyMs ?? null,
            costUsd: p.costUsd ?? null,
          };
        }
      }
    }
    return { models: RECORDED_MODELS, answers };
  } catch {
    return null;
  }
}

export async function GET() {
  const sets = fs.existsSync(SETS_DIR)
    ? fs
        .readdirSync(SETS_DIR)
        .filter((f) => f.endsWith(".json"))
        .sort()
        .map((f) => {
          try {
            const s = JSON.parse(fs.readFileSync(path.join(SETS_DIR, f), "utf8"));
            return {
              id: s.id,
              title: s.title,
              question: s.question,
              type: s.type ?? "choice",
              choices: s.choices,
              products: s.products,
              items: (s.items ?? []).map((i: Record<string, unknown>) => ({
                id: i.id,
                label: i.label,
                context: i.context ?? null,
                product: i.product,
                title: i.title,
                body: i.body,
                subreddit: i.subreddit,
              })),
            };
          } catch {
            return null;
          }
        })
        .filter(Boolean)
    : [];

  let summary: unknown = null;
  let answers: ReturnType<typeof recorded> = null;
  if (fs.existsSync(RESULTS_DIR)) {
    const latest = fs
      .readdirSync(RESULTS_DIR)
      .filter((f) => f.endsWith(".summary.json"))
      .sort()
      .pop();
    if (latest) {
      try {
        summary = { file: `experiments/decide/results/${latest}`, ...JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, latest), "utf8")) };
      } catch {
        summary = null;
      }
      answers = recorded(latest);
    }
  }
  return NextResponse.json({ sets, summary, recorded: answers });
}
