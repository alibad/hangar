/**
 * Claude Code usage aggregation.
 *
 * Parses the local JSONL transcripts under ~/.claude/projects and rolls usage up
 * at any granularity (hour → year). Cost is computed from a static price table
 * rather than shelling out to a CLI, so a live console can refresh cheaply.
 *
 * Two details are load-bearing and were verified against ccusage to the cent:
 *  - Dedupe by `messageId:requestId` keeping the copy with the MOST output
 *    tokens. Streaming appends the same message repeatedly as it grows, so the
 *    first copy is a partial; taking it undercounts output by up to 55%.
 *  - Cache writes are split 5m vs 1h, which bill at 1.25x and 2x input.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const PROJECTS_DIR = join(homedir(), ".claude", "projects");

/** USD per million tokens: [input, output]. */
const PRICES: Record<string, [number, number]> = {
  "claude-opus-5": [5, 25],
  "claude-opus-4-8": [5, 25],
  "claude-opus-4-7": [5, 25],
  "claude-opus-4-6": [5, 25],
  "claude-opus-4-5": [5, 25],
  "claude-fable-5": [10, 50],
  "claude-mythos-5": [10, 50],
  "claude-sonnet-5": [3, 15],
  "claude-sonnet-4-6": [3, 15],
  "claude-sonnet-4-5": [3, 15],
  "claude-haiku-4-5": [1, 5],
};
// Cache multipliers, relative to the model's input price.
const CACHE_READ = 0.1;
const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2;

function priceFor(model: string): [number, number] {
  const base = model.replace(/-\d{8}$/, "");
  const hit = PRICES[model] ?? PRICES[base];
  if (hit) return hit;
  // Unknown model — fall back to its tier so cost is never silently zero.
  if (base.includes("opus")) return [5, 25];
  if (base.includes("sonnet")) return [3, 15];
  if (base.includes("haiku")) return [1, 5];
  return [5, 25];
}

export type Granularity = "hour" | "day" | "week" | "month" | "quarter" | "year";
export const GRANULARITIES: Granularity[] = ["hour", "day", "week", "month", "quarter", "year"];

export type Bucket = {
  period: string;
  label: string;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  totalTokens: number;
  cost: number;
  messages: number;
};

export type UsageSnapshot = {
  generatedAt: string;
  granularities: Record<Granularity, Bucket[]>;
  models: Array<{ model: string; totalTokens: number; cost: number; messages: number }>;
  projects: Array<{ project: string; totalTokens: number; cost: number; messages: number; sessions: number }>;
  sessions: Array<{ session: string; project: string; last: number; totalTokens: number; cost: number; messages: number }>;
  totals: { cost: number; totalTokens: number; messages: number };
  span: { earliest: string | null; latest: string | null; activeDays: number; files: number };
};

type Event = {
  t: number;
  model: string;
  project: string;
  session: string;
  input: number;
  output: number;
  cw5m: number;
  cw1h: number;
  cacheRead: number;
  cost: number;
};

// ---- incremental cache: only re-read files whose mtime/size changed ----
type CacheEntry = { mtimeMs: number; size: number; events: Array<Event & { key: string }> };
const fileCache = new Map<string, CacheEntry>();

async function listJsonl(dir: string, out: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    // Subagent/workflow transcripts nest deeper than the session files.
    if (e.isDirectory()) await listJsonl(full, out);
    else if (e.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

function parseFile(text: string): Array<Event & { key: string }> {
  const rows: Array<Event & { key: string }> = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    let j: Record<string, any>;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (j.type !== "assistant") continue;
    const u = j.message?.usage;
    const model: string | undefined = j.message?.model;
    if (!u || !model || model === "<synthetic>") continue;

    const input = u.input_tokens || 0;
    const output = u.output_tokens || 0;
    const cw = u.cache_creation_input_tokens || 0;
    const cw1h = u.cache_creation?.ephemeral_1h_input_tokens || 0;
    const cacheRead = u.cache_read_input_tokens || 0;
    if (!(input || output || cw || cacheRead)) continue;
    const t = Date.parse(j.timestamp);
    if (!t) continue;

    const cw5m = Math.max(0, cw - cw1h);
    const [pin, pout] = priceFor(model);
    const cost =
      (input * pin +
        output * pout +
        cacheRead * pin * CACHE_READ +
        cw5m * pin * CACHE_WRITE_5M +
        cw1h * pin * CACHE_WRITE_1H) /
      1e6;

    let project = "";
    if (j.cwd) {
      const parts = String(j.cwd).replace(/[\\/]+$/, "").split(/[\\/]/);
      project = parts[parts.length - 1] || "";
    }

    rows.push({
      key: `${j.message?.id ?? ""}:${j.requestId ?? ""}`,
      t,
      model,
      project,
      session: j.sessionId || "",
      input,
      output,
      cw5m,
      cw1h,
      cacheRead,
      cost,
    });
  }
  return rows;
}

async function loadEvents(): Promise<Event[]> {
  const paths = await listJsonl(PROJECTS_DIR);
  const live = new Set(paths);
  for (const k of fileCache.keys()) if (!live.has(k)) fileCache.delete(k);

  await Promise.all(
    paths.map(async (p) => {
      let st;
      try {
        st = await stat(p);
      } catch {
        return;
      }
      const hit = fileCache.get(p);
      if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return;
      try {
        fileCache.set(p, { mtimeMs: st.mtimeMs, size: st.size, events: parseFile(await readFile(p, "utf8")) });
      } catch {
        /* unreadable file — skip */
      }
    }),
  );

  // Keep the copy with the most output tokens per message (see file header).
  const best = new Map<string, Event>();
  const loose: Event[] = [];
  for (const { events } of fileCache.values()) {
    for (const e of events) {
      if (e.key === ":") {
        loose.push(e);
        continue;
      }
      const prev = best.get(e.key);
      if (!prev || e.output > prev.output) best.set(e.key, e);
    }
  }
  return loose.concat([...best.values()]);
}

// ---- period keys ----
const p2 = (n: number) => String(n).padStart(2, "0");

function isoWeek(d: Date): [number, number] {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = (x.getDay() + 6) % 7; // Mon = 0
  x.setDate(x.getDate() - day + 3); // Thursday of this week
  const firstThu = new Date(x.getFullYear(), 0, 4);
  const week =
    1 + Math.round(((x.getTime() - firstThu.getTime()) / 86400000 - 3 + ((firstThu.getDay() + 6) % 7)) / 7);
  return [x.getFullYear(), week];
}

const KEYERS: Record<Granularity, (d: Date) => [string, string]> = {
  hour: (d) => [
    `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}`,
    `${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:00`,
  ],
  day: (d) => [
    `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`,
    `${p2(d.getMonth() + 1)}-${p2(d.getDate())}`,
  ],
  week: (d) => {
    const [y, w] = isoWeek(d);
    return [`${y}-W${p2(w)}`, `${y} W${p2(w)}`];
  },
  month: (d) => {
    const k = `${d.getFullYear()}-${p2(d.getMonth() + 1)}`;
    return [k, k];
  },
  quarter: (d) => {
    const q = Math.floor(d.getMonth() / 3) + 1;
    return [`${d.getFullYear()}-Q${q}`, `${d.getFullYear()} Q${q}`];
  },
  year: (d) => [String(d.getFullYear()), String(d.getFullYear())],
};

function rollup(events: Event[], gran: Granularity): Bucket[] {
  const keyer = KEYERS[gran];
  const map = new Map<string, Bucket>();
  for (const e of events) {
    const [period, label] = keyer(new Date(e.t));
    let b = map.get(period);
    if (!b) {
      b = {
        period,
        label,
        input: 0,
        output: 0,
        cacheWrite: 0,
        cacheRead: 0,
        totalTokens: 0,
        cost: 0,
        messages: 0,
      };
      map.set(period, b);
    }
    b.input += e.input;
    b.output += e.output;
    b.cacheWrite += e.cw5m + e.cw1h;
    b.cacheRead += e.cacheRead;
    b.totalTokens += e.input + e.output + e.cw5m + e.cw1h + e.cacheRead;
    b.cost += e.cost;
    b.messages += 1;
  }
  return [...map.values()].sort((a, b) => (a.period < b.period ? -1 : 1));
}

export async function buildUsageSnapshot(): Promise<UsageSnapshot> {
  const events = await loadEvents();

  const granularities = {} as Record<Granularity, Bucket[]>;
  for (const g of GRANULARITIES) granularities[g] = rollup(events, g);

  const models = new Map<string, { model: string; totalTokens: number; cost: number; messages: number }>();
  const projects = new Map<
    string,
    { project: string; totalTokens: number; cost: number; messages: number; sessions: Set<string> }
  >();
  const sessions = new Map<
    string,
    { session: string; project: string; last: number; totalTokens: number; cost: number; messages: number }
  >();

  let cost = 0;
  let totalTokens = 0;
  let earliest = Infinity;
  let latest = -Infinity;
  const days = new Set<string>();

  for (const e of events) {
    const tokens = e.input + e.output + e.cw5m + e.cw1h + e.cacheRead;
    cost += e.cost;
    totalTokens += tokens;
    if (e.t < earliest) earliest = e.t;
    if (e.t > latest) latest = e.t;
    days.add(KEYERS.day(new Date(e.t))[0]);

    const m = models.get(e.model) ?? { model: e.model, totalTokens: 0, cost: 0, messages: 0 };
    m.totalTokens += tokens;
    m.cost += e.cost;
    m.messages += 1;
    models.set(e.model, m);

    const pkey = e.project || "(unknown)";
    const p =
      projects.get(pkey) ?? { project: pkey, totalTokens: 0, cost: 0, messages: 0, sessions: new Set<string>() };
    p.totalTokens += tokens;
    p.cost += e.cost;
    p.messages += 1;
    if (e.session) p.sessions.add(e.session);
    projects.set(pkey, p);

    const s =
      sessions.get(e.session) ??
      { session: e.session, project: e.project, last: e.t, totalTokens: 0, cost: 0, messages: 0 };
    s.totalTokens += tokens;
    s.cost += e.cost;
    s.messages += 1;
    if (e.t > s.last) s.last = e.t;
    sessions.set(e.session, s);
  }

  return {
    generatedAt: new Date().toISOString(),
    granularities,
    models: [...models.values()].sort((a, b) => b.cost - a.cost),
    projects: [...projects.values()]
      .map((p) => ({ ...p, sessions: p.sessions.size }))
      .sort((a, b) => b.cost - a.cost),
    sessions: [...sessions.values()].sort((a, b) => b.cost - a.cost).slice(0, 40),
    totals: { cost, totalTokens, messages: events.length },
    span: {
      earliest: earliest === Infinity ? null : new Date(earliest).toISOString(),
      latest: latest === -Infinity ? null : new Date(latest).toISOString(),
      activeDays: days.size,
      files: fileCache.size,
    },
  };
}
