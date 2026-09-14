/** Shared presentation data. No filesystem or conversation content. */
export type Assistant = "codex" | "claude";
export type UsageRow = {
  source: Assistant;
  day: string;
  model: string;
  project: string;
  session: string;
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  totalTokens: number;
  calls: number;
  estimatedCost: number;
  unpricedTokens: number;
  last: number;
};
export type AssistantSnapshot = {
  generatedAt: string;
  rows: UsageRow[];
  sources: Record<
    Assistant,
    { available: boolean; error?: string; files?: number }
  >;
  warnings: string[];
  pricingDate: string;
};
export const sourceLabel = (source: Assistant) =>
  source === "codex" ? "Codex · GPT" : "Claude Code";
export const blankTotals = () => ({
  input: 0,
  cached: 0,
  cacheWrite: 0,
  output: 0,
  reasoning: 0,
  totalTokens: 0,
  calls: 0,
  estimatedCost: 0,
  unpricedTokens: 0,
});
export type UsageTotals = ReturnType<typeof blankTotals>;
export function sumUsage(rows: UsageRow[]): UsageTotals {
  const totals = blankTotals();
  for (const row of rows)
    for (const key of Object.keys(totals) as (keyof UsageTotals)[])
      totals[key] += row[key];
  return totals;
}
export function filterUsage(
  rows: UsageRow[],
  filters: {
    source?: string;
    from?: string;
    to?: string;
    model?: string;
    project?: string;
  },
) {
  return rows.filter(
    (r) =>
      (!filters.source || r.source === filters.source) &&
      (!filters.from || r.day >= filters.from) &&
      (!filters.to || r.day <= filters.to) &&
      (!filters.model || r.model === filters.model) &&
      (!filters.project || r.project === filters.project),
  );
}
export function groupUsage(
  rows: UsageRow[],
  by: "day" | "model" | "project" | "session" | "source",
) {
  const groups = new Map<string, UsageRow[]>();
  for (const row of rows) {
    const key = row[by];
    const group = groups.get(key) || [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups]
    .map(([key, values]) => ({
      key,
      ...sumUsage(values),
      sessions: new Set(values.map((r) => `${r.source}:${r.session}`)).size,
      last: Math.max(...values.map((r) => r.last)),
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
}

/** Shortest trailing path that tells each project apart from the others.
 * A bare folder name repeats often ("shots", "worktrees"), so a colliding
 * label grows leftwards one folder at a time until it is unambiguous. */
export function projectLabels(paths: string[]): Map<string, string> {
  const parts = new Map(
    paths.map((p) => [
      p,
      p
        .replace(/[\\/]+$/, "")
        .split(/[\\/]/)
        .filter(Boolean),
    ]),
  );
  const depth = new Map(paths.map((p) => [p, 1]));
  const labelOf = (p: string) => {
    const segments = parts.get(p) as string[];
    return segments.length ? segments.slice(-(depth.get(p) as number)).join("/") : p;
  };
  for (;;) {
    const byLabel = new Map<string, string[]>();
    for (const p of paths) {
      const label = labelOf(p);
      const group = byLabel.get(label) || [];
      group.push(p);
      byLabel.set(label, group);
    }
    let grew = false;
    for (const group of byLabel.values()) {
      if (group.length < 2) continue;
      for (const p of group) {
        const room = (parts.get(p) as string[]).length;
        const at = depth.get(p) as number;
        if (at < room) {
          depth.set(p, at + 1);
          grew = true;
        }
      }
    }
    if (!grew) break;
  }
  return new Map(paths.map((p) => [p, labelOf(p)]));
}
