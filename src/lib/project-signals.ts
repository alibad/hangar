/**
 * What waits on you across Hangar, where each project was left, and an island for each unsorted project.
 * Pure functions over the world document and the session library, so the page and the tests share one rule each.
 */

export type SignalSession = {
  key: string; id: string; provider: string; title: string; summary?: string; activityAt: string;
  archived: boolean; probe?: boolean; unread: boolean | null;
  /** The Claude app's one-line status of the last turn, when it is current. */
  status?: { category: string; detail: string; needsAction: string } | null;
  projects: { id: string; name: string; evidence: string }[];
};
export type SignalSite = { role: string; rel: string; root?: string };
export type SignalRepo = {
  id: string; name: string; family: string; hidden?: boolean; organizationReviewed?: boolean;
  sites: SignalSite[]; risks?: { id: string; text: string }[]; meaning?: { next?: string };
};
export type SignalIsland = { id: string; name: string; hidden?: boolean };

export type TurnKind = "ask" | "review" | "unread" | "push";
export type TurnItem = { kind: TurnKind; key: string; text: string; at: string; project?: { id: string; name: string }; session?: SignalSession };
export type YourTurn = Record<TurnKind, TurnItem[]>;

const live = (s: SignalSession) => !s.archived && !s.probe;
const firstLine = (text = "") => text.split(/\r?\n/).map(line => line.trim()).find(Boolean) || "";
const time = (value: string) => Date.parse(value) || 0;
/** A title that is only the project's name (the library's fallback) says nothing about the work. */
const said = (s: SignalSession) => {
  const title = s.title?.trim() || "";
  return title && title !== "Unmatched session" && title !== s.projects.map(p => p.name).join(" · ") ? title : firstLine(s.summary);
};

/**
 * Everything that waits on you, one list per kind: a session that stopped to ask you something, a session ready for
 * your review, a reply you have not opened, and a project whose commits are not on GitHub. Newest first.
 */
export function yourTurn(repos: SignalRepo[], sessions: SignalSession[]): YourTurn {
  const shown = new Set(repos.filter(r => !r.hidden).map(r => r.id));
  const out: YourTurn = { ask: [], review: [], unread: [], push: [] };
  for (const s of sessions) {
    if (!live(s)) continue;
    const p = s.projects.find(x => shown.has(x.id) && x.evidence === "edit-tool") || s.projects.find(x => shown.has(x.id));
    const base = { key: s.key, at: s.activityAt, session: s, project: p && { id: p.id, name: p.name } };
    if (s.status?.category === "blocked") out.ask.push({ ...base, kind: "ask", text: firstLine(s.status.needsAction) || firstLine(s.status.detail) || said(s) });
    else if (s.status?.category === "review_ready") out.review.push({ ...base, kind: "review", text: firstLine(s.status.detail) || said(s) });
    else if (s.unread === true) out.unread.push({ ...base, kind: "unread", text: said(s) || "A reply you haven't opened" });
  }
  for (const r of repos) {
    if (r.hidden) continue;
    const risk = r.risks?.find(k => k.id === "unpushed") || r.risks?.find(k => k.id === "offmap");
    if (risk) out.push.push({ kind: "push", key: `repo:${r.id}`, text: risk.text, at: "", project: { id: r.id, name: r.name } });
  }
  for (const kind of ["ask", "review", "unread"] as const) out[kind].sort((a, b) => time(b.at) - time(a.at));
  out.push.sort((a, b) => a.project!.name.localeCompare(b.project!.name));
  return out;
}

export type LeftOff<S extends SignalSession = SignalSession> = { text: string; at: string; tone: "next" | "ask" | "status" | "title"; session?: S };

/** A session that touched more projects than this was a sweep across them, and its last line is about the sweep. */
const FOCUSED = 3;

/**
 * Where you left a project: your own "next" note when there is one, otherwise what its latest session ended on. A
 * session that worked on this project (and at most two others) wins over a newer sweep across many projects.
 */
export function leftOff<S extends SignalSession>(repo: SignalRepo, sessions: S[]): LeftOff<S> | null {
  const note = repo.meaning?.next?.trim();
  if (note) return { text: firstLine(note), at: "", tone: "next" };
  let last: S | undefined, sweep: S | undefined;
  for (const s of sessions) {
    if (!live(s) || !s.projects.some(p => p.id === repo.id)) continue;
    if (s.projects.length > FOCUSED) { if (!sweep || time(s.activityAt) > time(sweep.activityAt)) sweep = s; }
    else if (!last || time(s.activityAt) > time(last.activityAt)) last = s;
  }
  last ||= sweep;
  if (!last) return null;
  const status = last.status;
  if (status?.category === "blocked") return { text: firstLine(status.needsAction) || firstLine(status.detail) || said(last), at: last.activityAt, tone: "ask", session: last };
  if (firstLine(status?.detail)) return { text: firstLine(status!.detail), at: last.activityAt, tone: "status", session: last };
  const text = said(last);
  return text ? { text, at: last.activityAt, tone: "title", session: last } : null;
}

export type IslandSuggestion = { island: string; name: string; folder: string; root: string; agree: number; sorted: number; repos: string[] };

const MAIN_ROLES = ["canonical", "orphan", "vendor"];
const mainFolder = (r: SignalRepo) => {
  const site = r.sites.find(s => MAIN_ROLES.includes(s.role)) || r.sites[0];
  return site ? { root: site.root || "", rel: site.rel.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "") } : null;
};
const parentOf = (folder: string) => folder.includes("/") ? folder.slice(0, folder.lastIndexOf("/")) : "";

/**
 * An island for each unsorted project from where it sits: the island most sorted projects in the same folder are on.
 * The nearest folder with at least two sorted projects decides; it must agree at least `share` of the time, or there is
 * no suggestion. Projects only on GitHub have no folder, and a project you reviewed and left unsorted stays as it is.
 */
export function suggestIslands(repos: SignalRepo[], islands: SignalIsland[], share = 0.6): IslandSuggestion[] {
  const names = new Map(islands.filter(i => !i.hidden && i.id !== "uncategorized").map(i => [i.id, i.name]));
  const counts = new Map<string, Map<string, number>>();
  for (const r of repos) {
    const where = !r.hidden && names.has(r.family) && mainFolder(r);
    if (!where) continue;
    const key = `${where.root}|${parentOf(where.rel)}`;
    const tally = counts.get(key) || new Map<string, number>();
    tally.set(r.family, (tally.get(r.family) || 0) + 1);
    counts.set(key, tally);
  }
  const groups = new Map<string, IslandSuggestion>();
  for (const r of repos) {
    const where = !r.hidden && r.family === "uncategorized" && !r.organizationReviewed && mainFolder(r);
    if (!where) continue;
    for (let folder = parentOf(where.rel); ; folder = parentOf(folder)) {
      const tally = counts.get(`${where.root}|${folder}`);
      const sorted = tally ? [...tally.values()].reduce((a, b) => a + b, 0) : 0;
      if (sorted >= 2) {
        const [island, agree] = [...tally!.entries()].sort((a, b) => b[1] - a[1])[0];
        if (agree >= 2 && agree / sorted >= share) {
          const key = `${island}|${where.root}|${folder}`;
          const group = groups.get(key) || { island, name: names.get(island)!, folder, root: where.root, agree, sorted, repos: [] };
          group.repos.push(r.id);
          groups.set(key, group);
        }
        break;
      }
      if (!folder) break;
    }
  }
  return [...groups.values()].sort((a, b) => b.repos.length - a.repos.length || a.name.localeCompare(b.name));
}
