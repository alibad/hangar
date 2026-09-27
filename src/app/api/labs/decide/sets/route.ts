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
 * scripts/decide-bench.mjs. Per-item predictions stay in the full results file
 * and are not sent to the browser.
 */
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
    }
  }
  return NextResponse.json({ sets, summary });
}
