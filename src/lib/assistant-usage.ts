import { loadEvents } from "./claude-usage";
import { readCodexUsage } from "./codex-usage";
import { estimateCodexCost, PRICING_DATE } from "./codex-pricing";
import { ensureProjectEngine } from "./project-engine";
import type { AssistantSnapshot, UsagePlace, UsageRow } from "./assistant-usage-data";

/** Which project each working folder belongs to, from Hangar's engine, which alone knows where projects live on this
 *  machine. Usage still loads without it: folders then show as folders. */
async function readPlaces(paths: string[]): Promise<Record<string, UsagePlace>> {
  const base = await ensureProjectEngine();
  const places: Record<string, UsagePlace> = {};
  // The engine reads at most 64 KB a request; a few hundred folders fit in one.
  for (let i = 0; i < paths.length; i += 300) {
    const response = await fetch(`${base}/api/usage/places`, {
      method: "POST", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { "Content-Type": "application/json", "X-Hangar": "1" },
      body: JSON.stringify({ paths: paths.slice(i, i + 300) }),
    });
    if (!response.ok) throw new Error(`The project engine answered ${response.status}.`);
    Object.assign(places, (await response.json()).places);
  }
  return places;
}

let cached: AssistantSnapshot | null = null;
let inflight: Promise<AssistantSnapshot> | null = null;
export function buildAssistantUsage(): Promise<AssistantSnapshot> {
  if (inflight) return inflight;
  if (cached && Date.now() - Date.parse(cached.generatedAt) < 15_000)
    return Promise.resolve(cached);
  inflight = build()
    .then((data) => {
      cached = data;
      return data;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
async function build(): Promise<AssistantSnapshot> {
  const [codex, claude] = await Promise.allSettled([
    readCodexUsage(),
    loadEvents(),
  ]);
  const rows = new Map<string, UsageRow>();
  const add = (row: UsageRow) => {
    row.project = row.project.replace(/\\/g, "/").replace(/\/+$/, "");
    const key = JSON.stringify([
      row.source,
      row.day,
      row.model,
      row.project,
      row.session,
    ]);
    const prev = rows.get(key);
    if (!prev) {
      rows.set(key, row);
      return;
    }
    for (const field of [
      "input",
      "cached",
      "cacheWrite",
      "output",
      "reasoning",
      "totalTokens",
      "calls",
      "estimatedCost",
      "unpricedTokens",
    ] as const)
      prev[field] += row[field];
    prev.last = Math.max(prev.last, row.last);
  };
  if (codex.status === "fulfilled")
    for (const e of codex.value.events) {
      const cost = estimateCodexCost(e);
      add({
        source: "codex",
        day: new Date(e.timestamp).toISOString().slice(0, 10),
        model: e.model,
        project: e.project,
        session: e.session,
        input: e.input,
        cached: e.cached,
        cacheWrite: e.cacheWrite,
        output: e.output,
        reasoning: e.reasoning,
        totalTokens: e.input + e.output,
        calls: 1,
        estimatedCost: cost ?? 0,
        unpricedTokens: cost === null ? e.input + e.output : 0,
        last: e.timestamp,
      });
    }
  if (claude.status === "fulfilled")
    for (const e of claude.value) {
      const input = e.input + e.cacheRead + e.cw5m + e.cw1h;
      add({
        source: "claude",
        day: new Date(e.t).toISOString().slice(0, 10),
        model: e.model,
        project: e.projectPath || e.project || "(unknown)",
        session: e.session,
        input,
        cached: e.cacheRead,
        cacheWrite: e.cw5m + e.cw1h,
        output: e.output,
        reasoning: 0,
        totalTokens: input + e.output,
        calls: 1,
        estimatedCost: e.cost,
        unpricedTokens: 0,
        last: e.t,
      });
    }
  const all = [...rows.values()];
  const places = await readPlaces([...new Set(all.map((r) => r.project))]).catch(
    (error: unknown) => error instanceof Error ? error : new Error(String(error)),
  );
  return {
    generatedAt: new Date().toISOString(),
    rows: all,
    places: places instanceof Error ? {} : places,
    pricingDate: PRICING_DATE,
    warnings: [
      ...(codex.status === "fulfilled" ? codex.value.warnings : []),
      ...(places instanceof Error ? [`Projects are shown as folders: ${places.message}`] : []),
    ],
    sources: {
      codex:
        codex.status === "fulfilled"
          ? { available: true, files: codex.value.files }
          : { available: false, error: String(codex.reason) },
      claude:
        claude.status === "fulfilled"
          ? { available: true }
          : { available: false, error: String(claude.reason) },
    },
  };
}
