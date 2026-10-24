import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type Island = { id: string; name: string; repos: number; hidden?: boolean; custom?: boolean };
type Project = { id: string; family: string; hidden?: boolean; hiddenByIsland?: string; notes?: Record<string, unknown>; [key: string]: unknown };
export type WorldDocument = { repos: Project[]; families: Island[]; islands?: Island[]; stats?: Record<string, unknown>; [key: string]: unknown };
type Preferences = { version: 1; custom: Record<string, string>; hidden: Record<string, boolean>; assignments: Record<string, string>; reviewed?: Record<string, boolean> };
const empty = (): Preferences => ({ version: 1, custom: {}, hidden: {}, assignments: {}, reviewed: {} });
const owns = (value: object, key: string) => Object.hasOwn(value, key);

export class IslandInputError extends Error {}
export class IslandStorageError extends Error {}

/** Overlay only organization. Repository metadata and individual hiding stay intact. */
export function organizeWorld(doc: WorldDocument, prefs: Preferences): WorldDocument {
  const islands = new Map((doc.islands || doc.families).map(f => [f.id, { ...f, repos: 0 }]));
  for (const [id, name] of Object.entries(prefs.custom)) islands.set(id, { id, name, custom: true, repos: 0 });
  for (const [id, hidden] of Object.entries(prefs.hidden)) {
    const island = islands.get(id);
    if (island) island.hidden = hidden;
  }
  const repos = doc.repos.map(original => {
    const repo = { ...original };
    repo.organizationReviewed = !!(prefs.reviewed && owns(prefs.reviewed, repo.id) && prefs.reviewed[repo.id]);
    // Upstream island hiding is reversible separately from individual hiding.
    if (repo.hiddenByIsland) { repo.hidden = false; repo.family = repo.hiddenByIsland; delete repo.hiddenByIsland; }
    const assigned = owns(prefs.assignments, repo.id) ? prefs.assignments[repo.id] : undefined;
    if (assigned && islands.has(assigned)) {
      repo.family = assigned;
      repo.notes = { ...repo.notes, family: assigned };
    }
    const island = islands.get(repo.family);
    if (island) {
      island.repos++;
      if (island.hidden && !repo.hidden) { repo.hidden = true; repo.hiddenByIsland = island.id; }
    }
    return repo;
  });
  const all = [...islands.values()].sort((a, b) => b.repos - a.repos || a.name.localeCompare(b.name));
  return { ...doc, repos, islands: all, families: all.filter(f => !f.hidden),
    stats: { ...doc.stats, repos: repos.filter(r => !r.hidden).length, hidden: repos.filter(r => r.hidden).length } };
}

function change(doc: WorldDocument, previous: Preferences, raw: unknown): { preferences: Preferences; island?: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new IslandInputError("Choose an island action.");
  const body = raw as Record<string, unknown>;
  const preferences = structuredClone(previous);
  preferences.reviewed ||= {};
  const world = organizeWorld(doc, preferences);
  const islands = world.islands!;
  if (body.action === "create-island") {
    if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 60) throw new IslandInputError("Name the island (up to 60 characters).");
    const name = body.name.trim();
    if (islands.some(f => f.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new IslandInputError("An island already has that name.");
    if (Object.keys(preferences.custom).length >= 300) throw new IslandInputError("The maximum of 300 custom islands has been reached.");
    const island = `custom-${randomUUID()}`;
    preferences.custom[island] = name;
    return { preferences, island };
  }
  const island = typeof body.island === "string" ? islands.find(f => f.id === body.island) : undefined;
  if (body.action === "hide-island" || body.action === "restore-island") {
    if (!island) throw new IslandInputError("Choose an island from this world.");
    preferences.hidden[island.id] = body.action === "hide-island";
    return { preferences, island: island.id };
  }
  if (body.action === "assign-island") {
    if (!island || island.hidden) throw new IslandInputError("Choose a visible island.");
    if (!Array.isArray(body.repos) || !body.repos.length || body.repos.length > 300 || body.repos.some(id => typeof id !== "string" || !doc.repos.some(r => r.id === id))) throw new IslandInputError("Choose indexed projects to move.");
    for (const id of body.repos) {
      Object.defineProperty(preferences.assignments, id, { value: island.id, enumerable: true, writable: true, configurable: true });
      Object.defineProperty(preferences.reviewed, id, { value: true, enumerable: true, writable: true, configurable: true });
    }
    return { preferences, island: island.id };
  }
  if (body.action === "review-projects") {
    if (!Array.isArray(body.repos) || !body.repos.length || body.repos.length > 300 || body.repos.some(id => typeof id !== "string" || !doc.repos.some(r => r.id === id))) throw new IslandInputError("Choose indexed projects to review.");
    for (const id of body.repos) Object.defineProperty(preferences.reviewed, id, { value: true, enumerable: true, writable: true, configurable: true });
    return { preferences };
  }
  if (body.action === "reset-assignment") {
    if (typeof body.repo !== "string" || !doc.repos.some(r => r.id === body.repo)) throw new IslandInputError("Choose an indexed project.");
    delete preferences.assignments[body.repo];
    return { preferences };
  }
  throw new IslandInputError("Choose create, move, hide or restore.");
}

/** One writer per Hangar process, atomic disk replacement, no repository files. */
export function createIslandStore(file: string) {
  let queue = Promise.resolve();
  async function read(): Promise<Preferences> {
    let raw: unknown;
    try { raw = JSON.parse(await readFile(file, "utf8")); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return empty(); throw new IslandStorageError("Island preferences could not be read. The saved file has been left intact."); }
    const prefs = raw as Preferences;
    const recordOf = (value: unknown, kind: string) => !!value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every(v => typeof v === kind);
    if (!prefs || prefs.version !== 1 || !recordOf(prefs.custom, "string") || !recordOf(prefs.hidden, "boolean") || !recordOf(prefs.assignments, "string") || (prefs.reviewed !== undefined && !recordOf(prefs.reviewed, "boolean"))) throw new IslandStorageError("Island preferences use an unsupported format. The saved file has been left intact.");
    return prefs;
  }
  return {
    async apply(doc: WorldDocument) { return organizeWorld(doc, await read()); },
    async validate(doc: WorldDocument, body: unknown) { change(doc, await read(), body); },
    update(doc: WorldDocument, body: unknown) {
      const pending = queue.then(async () => {
        const result = change(doc, await read(), body);
        try {
          await mkdir(dirname(file), { recursive: true });
          const temp = `${file}.${randomUUID()}.tmp`;
          await writeFile(temp, JSON.stringify(result.preferences, null, 2), { mode: 0o600 });
          await rename(temp, file);
        } catch { throw new IslandStorageError("Island preferences could not be saved on this machine. Check that Hangar can write to its local storage, then retry."); }
        return { saved: true, island: result.island };
      });
      queue = pending.then(() => undefined, () => undefined);
      return pending;
    },
  };
}
