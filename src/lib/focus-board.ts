// Focus: the few products that matter now, each with its own goals, and the weekly numbers Hangar can't read on its own
// (posts about a product and the visits they brought). Pure rules here; the file lives in var/focus.json (focus-store.ts).
// People, feedback and releases come from the Products report, commits and unsaved work from each product's repositories.

export const METRICS = ["posts", "visits"] as const;
export type Metric = typeof METRICS[number];
export type FocusGoal = { id: string; product: string; text: string; done: boolean };
export type WeekNumbers = Partial<Record<Metric, number>>;
/** starred: product ids, in the order you starred them. weeks[product][isoWeek]: that week's typed numbers. */
export type FocusData = { starred: string[]; goals: FocusGoal[]; weeks: Record<string, Record<string, WeekNumbers>> };
export type FocusAction =
  | { action: "star"; product: string; on: boolean }
  | { action: "add-goal"; product: string; text: string }
  | { action: "update-goal"; id: string; text?: string; done?: boolean }
  | { action: "remove-goal"; id: string }
  | { action: "set-number"; product: string; week: string; metric: Metric; value: number | null };

/** More than this and it stops being a focus. */
export const MAX_FOCUS = 5;
/** Goals per product. */
export const MAX_GOALS = 5;
const MAX_TEXT = 140;
const MAX_VALUE = 1_000_000_000;
// Product ids from the Products report: a Vercel project, a repository name, a feedback label, or one from products.local.json.
const PRODUCT_ID = /^(?!.*\.\.)[A-Za-z0-9_][A-Za-z0-9_.:@=+/-]{0,119}$/;
const GOAL_ID = /^[a-z0-9-]{1,40}$/;
const WEEK = /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/;

export class FocusInputError extends Error {}
export const emptyFocus = (): FocusData => ({ starred: [], goals: [], weeks: {} });

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
const product = (value: unknown) => {
  if (typeof value !== "string" || !PRODUCT_ID.test(value)) throw new FocusInputError("Choose a product from the board.");
  return value;
};

/** A stored file read back: anything malformed is dropped, so a hand edit can't break the board. */
export function normalizeFocus(raw: unknown): FocusData {
  const data = emptyFocus();
  if (!raw || typeof raw !== "object") return data;
  const { starred, goals, weeks } = raw as { starred?: unknown; goals?: unknown; weeks?: unknown };
  if (Array.isArray(starred)) for (const id of starred) {
    if (typeof id === "string" && PRODUCT_ID.test(id) && !data.starred.includes(id) && data.starred.length < MAX_FOCUS) data.starred.push(id);
  }
  if (Array.isArray(goals)) for (const g of goals) {
    if (!g || typeof g !== "object") continue;
    const { id, product: of, text: words, done } = g as Record<string, unknown>;
    if (typeof id !== "string" || !GOAL_ID.test(id) || typeof of !== "string" || !PRODUCT_ID.test(of) || typeof words !== "string" || !words.trim()) continue;
    if (data.goals.filter(x => x.product === of).length >= MAX_GOALS) continue;
    data.goals.push({ id, product: of, text: words.trim().slice(0, MAX_TEXT), done: done === true });
  }
  if (weeks && typeof weeks === "object") for (const [of, byWeek] of Object.entries(weeks)) {
    if (!PRODUCT_ID.test(of) || !byWeek || typeof byWeek !== "object") continue;
    for (const [week, numbers] of Object.entries(byWeek)) {
      if (!WEEK.test(week) || !numbers || typeof numbers !== "object") continue;
      const kept: WeekNumbers = {};
      for (const metric of METRICS) {
        const value = (numbers as Record<string, unknown>)[metric];
        if (Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_VALUE) kept[metric] = value as number;
      }
      if (Object.keys(kept).length) (data.weeks[of] ??= {})[week] = kept;
    }
  }
  return data;
}

/** One change to the board. Returns a new board; throws FocusInputError for anything it won't store. */
export function applyFocus(current: FocusData, input: unknown, newId: () => string): FocusData {
  if (!input || typeof input !== "object") throw new FocusInputError("Send a Focus action.");
  const body = input as Record<string, unknown>;
  const next: FocusData = { starred: [...current.starred], goals: current.goals.map(g => ({ ...g })), weeks: structuredClone(current.weeks) };
  const goal = () => {
    const found = next.goals.find(g => g.id === body.id);
    if (!found) throw new FocusInputError("That goal is gone. Refresh and try again.");
    return found;
  };
  switch (body.action) {
    case "star": {
      const id = product(body.product);
      if (typeof body.on !== "boolean") throw new FocusInputError("Star is on or off.");
      if (!body.on) { next.starred = next.starred.filter(x => x !== id); return next; }
      if (next.starred.includes(id)) return next;
      if (next.starred.length >= MAX_FOCUS) throw new FocusInputError(`${MAX_FOCUS} products is the most that stays a focus. Unstar one first.`);
      next.starred.push(id);
      return next;
    }
    case "add-goal": {
      const id = product(body.product);
      if (next.goals.filter(g => g.product === id).length >= MAX_GOALS) throw new FocusInputError(`${MAX_GOALS} goals is the most for one product. Tick one off or remove one first.`);
      next.goals.push({ id: newId(), product: id, text: text(body.text), done: false });
      return next;
    }
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
      const id = product(body.product);
      const { week, metric, value } = body;
      if (typeof week !== "string" || !WEEK.test(week)) throw new FocusInputError("Choose a week like 2026-W45.");
      if (!METRICS.includes(metric as Metric)) throw new FocusInputError("Choose posts or visits.");
      if (value !== null && !(Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_VALUE)) throw new FocusInputError("Use a whole number, 0 or more.");
      const byWeek = next.weeks[id] ??= {};
      const numbers = byWeek[week] ??= {};
      if (value === null) delete numbers[metric as Metric]; else numbers[metric as Metric] = value as number;
      if (!Object.keys(numbers).length) delete byWeek[week];
      if (!Object.keys(byWeek).length) delete next.weeks[id];
      return next;
    }
    default:
      throw new FocusInputError("Unknown Focus action.");
  }
}
