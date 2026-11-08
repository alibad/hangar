// The Focus board: the few projects that matter now, the quarter's goals, and the weekly numbers Hangar can't read
// from git (people using a product, posts about it). Pure rules here; the file lives in var/focus.json (focus-store.ts).

export const METRICS = ["users", "signups", "posts", "visits"] as const;
export type Metric = typeof METRICS[number];
export type FocusGoal = { id: string; text: string; done: boolean };
export type WeekNumbers = Partial<Record<Metric, number>>;
/** weeks[repo][isoWeek] holds that week's numbers for one project. */
export type FocusData = { goals: FocusGoal[]; weeks: Record<string, Record<string, WeekNumbers>> };
export type FocusAction =
  | { action: "add-goal"; text: string }
  | { action: "update-goal"; id: string; text?: string; done?: boolean }
  | { action: "remove-goal"; id: string }
  | { action: "set-number"; repo: string; week: string; metric: Metric; value: number | null };

/** More than this and it stops being a focus. */
export const MAX_FOCUS = 5;
export const MAX_GOALS = 7;
const MAX_TEXT = 140;
const MAX_VALUE = 1_000_000_000;
// Catalog ids: GitHub node ids (R_kg…, MDEw…==), local:<hash>, vendor:<owner>/<name>.
const REPO_ID = /^(?!.*\.\.)[A-Za-z0-9_][A-Za-z0-9_.:@=+/-]{0,199}$/;
const WEEK = /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/;

export class FocusInputError extends Error {}
export const emptyFocus = (): FocusData => ({ goals: [], weeks: {} });

/** The ISO week a date falls in, Monday to Sunday, as "2026-W45". */
export function isoWeek(date = new Date()): string {
  const day = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const year = day.getUTCFullYear();
  const week = Math.ceil(((day.getTime() - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}
/** The Monday that starts the week a date falls in, at local midnight. */
export function weekMonday(date = new Date()): Date {
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return monday;
}
export function lastWeek(date = new Date()): string {
  const before = new Date(date); before.setDate(before.getDate() - 7);
  return isoWeek(before);
}
/** Which quarter a date is in and how many weeks are left of it. */
export function quarter(date = new Date()): { label: string; weeksLeft: number } {
  const q = Math.floor(date.getMonth() / 3) + 1;
  const end = new Date(date.getFullYear(), q * 3, 1);
  return { label: `Q${q} ${date.getFullYear()}`, weeksLeft: Math.max(0, Math.ceil((end.getTime() - date.getTime()) / (7 * 86400000))) };
}

const text = (value: unknown) => {
  if (typeof value !== "string") throw new FocusInputError("Write the goal as text.");
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) throw new FocusInputError("Write the goal first.");
  if (clean.length > MAX_TEXT) throw new FocusInputError(`Keep a goal under ${MAX_TEXT} characters.`);
  return clean;
};

/** A stored file read back: anything malformed is dropped, so a hand edit can't break the board. */
export function normalizeFocus(raw: unknown): FocusData {
  const data = emptyFocus();
  if (!raw || typeof raw !== "object") return data;
  const { goals, weeks } = raw as { goals?: unknown; weeks?: unknown };
  if (Array.isArray(goals)) for (const g of goals.slice(0, MAX_GOALS)) {
    if (!g || typeof g !== "object") continue;
    const { id, text: words, done } = g as Record<string, unknown>;
    if (typeof id === "string" && /^[a-z0-9-]{1,40}$/.test(id) && typeof words === "string" && words.trim()) data.goals.push({ id, text: words.trim().slice(0, MAX_TEXT), done: done === true });
  }
  if (weeks && typeof weeks === "object") for (const [repo, byWeek] of Object.entries(weeks)) {
    if (!REPO_ID.test(repo) || !byWeek || typeof byWeek !== "object") continue;
    for (const [week, numbers] of Object.entries(byWeek)) {
      if (!WEEK.test(week) || !numbers || typeof numbers !== "object") continue;
      const kept: WeekNumbers = {};
      for (const metric of METRICS) {
        const value = (numbers as Record<string, unknown>)[metric];
        if (Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_VALUE) kept[metric] = value as number;
      }
      if (Object.keys(kept).length) (data.weeks[repo] ??= {})[week] = kept;
    }
  }
  return data;
}

/** One change to the board. Returns a new board; throws FocusInputError for anything it won't store. */
export function applyFocus(current: FocusData, input: unknown, newId: () => string): FocusData {
  if (!input || typeof input !== "object") throw new FocusInputError("Send a Focus action.");
  const body = input as Record<string, unknown>;
  const next: FocusData = { goals: current.goals.map(g => ({ ...g })), weeks: structuredClone(current.weeks) };
  const goal = () => {
    const found = next.goals.find(g => g.id === body.id);
    if (!found) throw new FocusInputError("That goal is gone. Refresh and try again.");
    return found;
  };
  switch (body.action) {
    case "add-goal":
      if (next.goals.length >= MAX_GOALS) throw new FocusInputError(`${MAX_GOALS} goals is the most that stays a focus. Tick one off or remove one first.`);
      next.goals.push({ id: newId(), text: text(body.text), done: false });
      return next;
    case "update-goal": {
      const found = goal();
      if (body.text !== undefined) found.text = text(body.text);
      if (body.done !== undefined) {
        if (typeof body.done !== "boolean") throw new FocusInputError("Done is yes or no.");
        found.done = body.done;
      }
      return next;
    }
    case "remove-goal":
      goal();
      next.goals = next.goals.filter(g => g.id !== body.id);
      return next;
    case "set-number": {
      const { repo, week, metric, value } = body;
      if (typeof repo !== "string" || !REPO_ID.test(repo)) throw new FocusInputError("Choose a project from the map.");
      if (typeof week !== "string" || !WEEK.test(week)) throw new FocusInputError("Choose a week like 2026-W45.");
      if (!METRICS.includes(metric as Metric)) throw new FocusInputError("Choose users, signups, posts or visits.");
      if (value !== null && !(Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_VALUE)) throw new FocusInputError("Use a whole number, 0 or more.");
      const byWeek = next.weeks[repo] ??= {};
      const numbers = byWeek[week] ??= {};
      if (value === null) delete numbers[metric as Metric]; else numbers[metric as Metric] = value as number;
      if (!Object.keys(numbers).length) delete byWeek[week];
      if (!Object.keys(byWeek).length) delete next.weeks[repo];
      return next;
    }
    default:
      throw new FocusInputError("Unknown Focus action.");
  }
}
