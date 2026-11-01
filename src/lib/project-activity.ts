/** Who changed what in one project: the engine's commit-to-session join, laid out as a day of two lanes. */
export type Agent = "claude" | "codex" | "unknown";
export type ActivityCommit = {
  sha: string; short: string; at: string; subject: string; files: string[]; fileCount: number; agent: Agent;
  trailer: string | null; session: string | null; evidence: "printed" | "seen" | "files" | "trailer" | null; why: string;
};
export type ActivitySession = { key: string; provider: "claude" | "codex"; id: string; title: string; commits: string[]; edits: number; spans: { from: string; to: string }[]; files: string[] };
export type ActivityOverlap = { from: string; to: string; sessions: string[]; agents: string[]; crossAgent: boolean; sharedFiles: string[] };
export type ActivityData = {
  available: boolean; reason?: string; repo: string; name: string; branch: string; days: number; from: string; to: string;
  commits: ActivityCommit[]; sessions: ActivitySession[]; overlaps: ActivityOverlap[]; truncated: boolean; basis: string;
};

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const PAD = 20 * MINUTE;        // room around a stretch of work
const QUIET = 90 * MINUTE;      // a longer quiet gap folds into a break; longer than the engine's one-hour stretch gap
const BREAK = 6;                // percent of the width a folded gap takes
const at = (iso: string) => Date.parse(iso);

/** Local calendar day, as YYYY-MM-DD. */
export function dayKey(t: number) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const dayStart = (key: string) => new Date(`${key}T00:00:00`).getTime();
// Local midnight to local midnight, so a daylight-saving day is 23 or 25 hours.
const dayEnd = (key: string) => { const d = new Date(`${key}T00:00:00`); d.setDate(d.getDate() + 1); return d.getTime(); };

export type DaySummary = { key: string; claude: number; codex: number; unknown: number; sessions: number; overlap: boolean; crossAgent: boolean };

/** One entry per day of the window, oldest first, ending today. */
export function windowDays(data: ActivityData, now = Date.now()): DaySummary[] {
  const out: DaySummary[] = [];
  const today = new Date(now); today.setHours(12, 0, 0, 0);
  for (let i = data.days - 1; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    const key = dayKey(d.getTime()), start = dayStart(key), end = dayEnd(key);
    const inside = (from: number, to: number) => from < end && to >= start;
    const commits = data.commits.filter(c => dayKey(at(c.at)) === key);
    const bands = data.overlaps.filter(o => inside(at(o.from), at(o.to)));
    out.push({ key, claude: commits.filter(c => c.agent === "claude").length, codex: commits.filter(c => c.agent === "codex").length,
      unknown: commits.filter(c => c.agent === "unknown").length,
      sessions: data.sessions.filter(s => s.spans.some(p => inside(at(p.from), at(p.to)))).length,
      overlap: bands.length > 0, crossAgent: bands.some(o => o.crossAgent) });
  }
  return out;
}

/** The day to open on: the latest with two agents at once, else the latest with anything, else today. */
export function defaultDay(days: DaySummary[]) {
  return [...days].reverse().find(d => d.crossAgent)?.key ?? [...days].reverse().find(d => d.claude + d.codex + d.unknown + d.sessions > 0)?.key ?? days.at(-1)?.key ?? "";
}

type Segment = { from: number; to: number; left: number; width: number };
export type Row = { session: ActivitySession | null; agent: Agent; bars: { left: number; width: number }[]; commits: { commit: ActivityCommit; left: number }[] };
export type DayView = {
  segments: Segment[]; breaks: { left: number; width: number; minutes: number }[]; ticks: { left: number; label: string }[];
  lanes: { agent: Agent; rows: Row[] }[]; bands: { left: number; width: number; overlap: ActivityOverlap }[]; x: (t: number) => number;
};

function clock(t: number) {
  return new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

/** Stretches of the day with work in them, quiet gaps folded, every time mapped to a percent across. */
export function dayView(data: ActivityData, key: string): DayView {
  const start = dayStart(key), end = dayEnd(key);
  const clip = (t: number) => Math.min(end, Math.max(start, t));
  const touches = (from: number, to: number) => from < end && to >= start;
  const commits = data.commits.filter(c => { const t = at(c.at); return t >= start && t < end; });
  const sessions = data.sessions.filter(s => s.spans.some(p => touches(at(p.from), at(p.to))) || commits.some(c => c.session === s.key));
  const bandsToday = data.overlaps.filter(o => touches(at(o.from), at(o.to)));
  const times = [...commits.map(c => at(c.at)), ...sessions.flatMap(s => s.spans.filter(p => touches(at(p.from), at(p.to))).flatMap(p => [clip(at(p.from)), clip(at(p.to))]))].sort((a, b) => a - b);
  const stretches: [number, number][] = [];
  for (const t of times) {
    const last = stretches.at(-1);
    if (last && t - last[1] <= QUIET) last[1] = t; else stretches.push([t, t]);
  }
  const padded = stretches.map(([a, b]) => [Math.max(start, a - PAD), Math.min(end, b + PAD)] as [number, number]);
  const weight = padded.map(([a, b]) => Math.max(b - a, HOUR));
  const room = 100 - BREAK * Math.max(0, padded.length - 1);
  const total = weight.reduce((n, w) => n + w, 0) || 1;
  const segments: Segment[] = [];
  let left = 0;
  padded.forEach(([from, to], i) => {
    const width = weight[i] / total * room;
    segments.push({ from, to, left, width });
    left += width + BREAK;
  });
  const breaks = segments.slice(1).map((s, i) => ({ left: segments[i].left + segments[i].width, width: BREAK, minutes: Math.round((s.from - segments[i].to) / MINUTE) }));
  const x = (t: number) => {
    if (!segments.length) return 0;
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      if (t <= s.to) {
        if (t >= s.from) return s.left + (t - s.from) / Math.max(1, s.to - s.from) * s.width;
        if (i === 0) return 0;
        const prev = segments[i - 1], gap = breaks[i - 1];
        return gap.left + (t - prev.to) / Math.max(1, s.from - prev.to) * gap.width;
      }
    }
    const last = segments.at(-1)!;
    return last.left + last.width;
  };
  const ticks: { left: number; label: string }[] = [];
  for (const s of segments) {
    const span = s.to - s.from;
    const step = [15, 30, 60, 120, 180, 360].map(m => m * MINUTE).find(m => span / m <= Math.max(2, Math.round(s.width / 14))) ?? 6 * HOUR;
    for (let t = Math.ceil(s.from / step) * step; t <= s.to; t += step) ticks.push({ left: x(t), label: clock(t) });
  }
  const rowFor = (session: ActivitySession | null, agent: Agent): Row => {
    const mine = commits.filter(c => session ? c.session === session.key : !c.session && c.agent === agent);
    return {
      session, agent,
      bars: (session?.spans || []).filter(p => touches(at(p.from), at(p.to))).map(p => { const a = x(clip(at(p.from))), b = x(clip(at(p.to))); return { left: a, width: Math.max(1.2, b - a) }; }),
      commits: mine.map(c => ({ commit: c, left: x(at(c.at)) })),
    };
  };
  const firstTime = (s: ActivitySession) => Math.min(...s.spans.map(p => at(p.from)), ...commits.filter(c => c.session === s.key).map(c => at(c.at)));
  const lanes = (["claude", "codex", "unknown"] as Agent[]).map(agent => {
    const rows = agent === "unknown" ? [] : sessions.filter(s => s.provider === agent).sort((a, b) => firstTime(a) - firstTime(b)).map(s => rowFor(s, agent));
    if (commits.some(c => !c.session && c.agent === agent)) rows.push(rowFor(null, agent));
    return { agent, rows };
  }).filter(l => l.rows.length || l.agent !== "unknown");
  const bands = bandsToday.map(o => { const a = x(clip(at(o.from))), b = x(clip(at(o.to))); return { left: a, width: Math.max(1.5, b - a), overlap: o }; });
  return { segments, breaks, ticks, lanes, bands, x };
}
