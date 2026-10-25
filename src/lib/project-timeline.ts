export type TimelineCommit = { sha: string; at: string; subject: string };
export type TimelineData = {
  chapters: { month: string; count: number; themes: string[]; highlights: TimelineCommit[] }[];
  tags: { name: string; at: string }[];
  commits: number; truncated: boolean; basis: string; createdAt?: string;
};
export type TimelinePeriod = { id: string; end: string; count: number; highlights: TimelineCommit[]; tags: TimelineData["tags"]; themes: string[] };

function monthIndex(value: string) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])(?:$|-)/.exec(value);
  return match ? Number(match[1]) * 12 + Number(match[2]) - 1 : null;
}
const monthKey = (index: number) => `${Math.floor(index / 12).toString().padStart(4, "0")}-${(index % 12 + 1).toString().padStart(2, "0")}`;

/** Equal calendar intervals, including quiet months. Bound the number of marks
 * for long histories without dropping old activity or manufacturing milestones. */
export function timelinePeriods(data: TimelineData): { periods: TimelinePeriod[]; monthsPerPeriod: number } {
  const chapters = data.chapters.filter(c => monthIndex(c.month) !== null);
  const tags = data.tags.filter(t => monthIndex(t.at) !== null);
  const dates = [...chapters.map(c => monthIndex(c.month)!), ...tags.map(t => monthIndex(t.at)!)];
  if (!dates.length) return { periods: [], monthsPerPeriod: 1 };
  const first = Math.min(...dates), last = Math.max(...dates);
  const monthsPerPeriod = Math.max(1, Math.ceil((last - first + 1) / 120));
  const periods: TimelinePeriod[] = [];
  for (let start = first; start <= last; start += monthsPerPeriod) periods.push({ id: monthKey(start), end: monthKey(Math.min(last, start + monthsPerPeriod - 1)), count: 0, highlights: [], tags: [], themes: [] });
  for (const chapter of chapters) {
    const period = periods[Math.floor((monthIndex(chapter.month)! - first) / monthsPerPeriod)];
    period.count += chapter.count;
    period.highlights.push(...chapter.highlights);
    period.themes.push(...chapter.themes);
  }
  for (const tag of tags) periods[Math.floor((monthIndex(tag.at)! - first) / monthsPerPeriod)].tags.push(tag);
  for (const period of periods) {
    period.highlights.sort((a, b) => b.at.localeCompare(a.at));
    period.highlights = [...new Map(period.highlights.map(c => [c.sha, c])).values()].slice(0, 8);
    period.tags.sort((a, b) => a.at.localeCompare(b.at));
    period.themes = [...new Set(period.themes)].filter(t => t !== "other").slice(0, 4);
  }
  return { periods, monthsPerPeriod };
}

export function monthLabel(value: string, short = false) {
  return new Date(`${value}-01T12:00:00Z`).toLocaleDateString(undefined, { month: short ? "short" : "long", year: "numeric", timeZone: "UTC" });
}

export function periodLabel(period: TimelinePeriod) {
  return period.id === period.end ? monthLabel(period.id) : `${monthLabel(period.id, true)} – ${monthLabel(period.end, true)}`;
}
