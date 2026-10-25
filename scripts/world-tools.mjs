// Hangar's project world, for coding agents.
//
// What is waiting on the owner (uncommitted, not pushed, a pull needed, pull requests), one project's brief, the
// recent Claude and Codex sessions, the coding jobs Hangar runs, and the small set of actions the World offers
// (focus / park / hide, a note, open a folder in an agent, rescan). Every tool reads the bundled project engine on
// 127.0.0.1:7789 — the same engine World and Sessions read — so an agent and the owner see one answer.
//
// Nothing here touches a repo: the engine resolves folders by project id through its private roots file, and the
// only writes are Hangar's own metadata (spine notes, islands) and the jobs the owner asked for.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KINDS = ["commit", "push", "pull", "prs"];
const TITLES = { commit: "To commit", push: "To push", pull: "To pull", prs: "Pull requests" };
const APPS = ["claude", "codex", "code", "cursor", "folder"];
const STATES = ["focus", "parked", "hidden", "none"];
const REPO = { type: "string", description: "A project name (move-quest), owner/name, or Hangar project id." };
const DAY = 86_400_000;

export class WorldError extends Error {}

/** Start the bundled engine the way the console does: detached, so it outlives this helper. */
function startEngine() {
  const child = spawn(process.execPath, [path.join(HERE, "start-engine.mjs")], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

export function worldTools({
  engine = process.env.HANGAR_ENGINE_URL ?? `http://127.0.0.1:${process.env.HANGAR_ENGINE_PORT || 7789}`,
  fetch: fetchImpl = (url, init) => globalThis.fetch(url, init),
  start = startEngine,
  dataDir = process.env.HANGAR_ENGINE_DATA_DIR || path.join(HERE, "..", "var", "engine"),
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  // ── the engine ─────────────────────────────────────────────────────────────
  async function request(p, body, timeoutMs) {
    const init = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json", "X-Hangar": "1" }, body: JSON.stringify(body) };
    const res = await fetchImpl(`${engine}${p}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  }

  let woke = false;
  async function wake() {
    woke = true;
    try { start(); } catch { return false; }
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      try {
        const { data } = await request("/api/status", undefined, 2000);
        if (data.protocol === "hangar-engine-v1") return true;
      } catch { /* not up yet */ }
    }
    return false;
  }

  /** GET (no body) or POST (a body) one engine route; starts the engine once if nothing answers. */
  async function api(p, body, timeoutMs = 120_000) {
    let out;
    try {
      out = await request(p, body, timeoutMs);
    } catch (e) {
      if (woke || !(await wake())) {
        throw new WorldError(`Hangar's project engine on ${engine} is not running and could not be started (${e.message}). Open World in Hangar once, or run "node scripts/start-engine.mjs" in the Hangar repo.`);
      }
      out = await request(p, body, timeoutMs);
    }
    if (!out.res.ok) throw new WorldError(out.data.error || `The project engine answered ${out.res.status} for ${p}.`);
    return out.data;
  }

  const doc = () => api("/api/atlas");

  // ── reading the map ────────────────────────────────────────────────────────
  let rootsCache;
  function roots() {
    if (rootsCache === undefined) {
      try { rootsCache = JSON.parse(fs.readFileSync(path.join(dataDir, "roots.json"), "utf8")).roots || {}; } catch { rootsCache = {}; }
    }
    return rootsCache;
  }
  const folderOf = (site) => (site && roots()[site.root] ? path.join(roots()[site.root], site.rel || "") : null);
  const sites = (r) => r.sites || [];
  const mainSite = (r) => sites(r).find((s) => s.role === "canonical") || sites(r)[0] || null;
  const siteIndex = (r) => Math.max(0, sites(r).findIndex((s) => s.role === "canonical"));
  const label = (r) => r.fullName || r.name;
  const visible = (d) => d.repos.filter((r) => !r.hidden);
  const own = (r) => r.kind !== "vendor" && r.kind !== "fork";
  const island = (d, r) => (d.families || []).find((f) => f.id === r.family)?.name || r.family || "";

  function pendingOf(r) {
    const risk = (ids) => (r.risks || []).find((k) => ids.includes(k.id))?.text || null;
    return { commit: sites(r).reduce((n, s) => n + (s.dirty || 0), 0), push: risk(["unpushed", "offmap"]), pull: risk(["pull"]), prs: r.openPRs || 0 };
  }

  function ago(iso) {
    const t = iso ? Date.parse(iso) : NaN;
    if (!Number.isFinite(t)) return "never";
    const mins = Math.max(0, Math.round((now() - t) / 60_000));
    return mins < 90 ? `${mins} min ago` : mins < 48 * 60 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} days ago`;
  }

  function resolve(d, ref) {
    ref = (ref || "").trim();
    if (!ref) throw new WorldError("Say which project.");
    const low = ref.toLowerCase();
    for (const test of [(r) => r.id === ref, (r) => (r.fullName || "").toLowerCase() === low, (r) => r.name.toLowerCase() === low]) {
      const hits = d.repos.filter(test);
      if (hits.length === 1) return hits[0];
      if (hits.length) {
        const mine = hits.filter((r) => r.kind === "mine");
        const here = mine.length ? mine : hits.filter((r) => r.onMachine);
        if (here.length === 1) return here[0];
        throw new WorldError("More than one project matches: " + hits.map(label).join(", "));
      }
    }
    const hits = d.repos.filter((r) => r.name.toLowerCase().includes(low));
    if (hits.length === 1) return hits[0];
    if (hits.length) throw new WorldError("Did you mean: " + hits.slice(0, 10).map(label).join(", ") + "?");
    throw new WorldError(`No project called ${ref} on the map.`);
  }

  const waiting = (p) => [p.commit && `${p.commit} uncommitted`, p.push && "to push", p.pull && "to pull", p.prs && `${p.prs} PRs`].filter(Boolean).join(", ") || "nothing waiting";

  // ── tools ──────────────────────────────────────────────────────────────────
  async function pending({ kind, scope = "mine" } = {}) {
    if (kind && !KINDS.includes(kind)) throw new WorldError("kind is one of commit, push, pull, prs.");
    if (!["mine", "all"].includes(scope)) throw new WorldError("scope is mine or all.");
    const d = await doc();
    const shown = visible(d).filter((r) => scope === "all" || own(r));
    const skipped = visible(d).length - shown.length;
    const groups = Object.fromEntries(KINDS.map((k) => [k, []]));
    for (const r of shown) {
      const p = pendingOf(r);
      for (const k of KINDS) if (p[k]) groups[k].push({ repo: label(r), kind: r.kind, detail: p[k], folder: folderOf(mainSite(r)), focus: r.attention === "focus" });
    }
    const lines = [`This machine checked ${ago(d.machine?.scannedAt)}, GitHub ${ago(d.github?.fetchedAt)}.` +
      (scope === "mine" ? ` Your own repos; ${skipped} vendor ${skipped === 1 ? "copy or fork" : "copies and forks"} left out (scope all shows them).` : " Every visible repo, vendor copies and forks included.")];
    lines.push(KINDS.map((k) => `${groups[k].length} ${TITLES[k].toLowerCase()}`).join(" · "));
    for (const k of KINDS) {
      if (kind && k !== kind) continue;
      const rows = groups[k].sort((a, b) => Number(b.focus) - Number(a.focus) || (typeof b.detail === "number" ? b.detail - a.detail : 0) || a.repo.localeCompare(b.repo));
      lines.push(`\n${TITLES[k]} (${rows.length})`);
      for (const x of rows) {
        const what = k === "commit" ? `${x.detail} uncommitted` : k === "prs" ? `${x.detail} open` : x.detail;
        lines.push(`- ${x.repo}${x.focus ? " [focus]" : ""}${x.kind !== "mine" ? ` (${x.kind})` : ""}: ${what}${x.folder && k !== "prs" ? ` — ${x.folder}` : ""}`);
      }
      if (!rows.length) lines.push("- nothing");
    }
    return lines.join("\n");
  }

  async function find({ query } = {}) {
    const q = (query || "").trim().toLowerCase();
    if (!q) throw new WorldError("Say what to look for.");
    const d = await doc();
    const score = (r) => (r.name.toLowerCase() === q ? 3 : r.name.toLowerCase().startsWith(q) ? 2 : r.name.toLowerCase().includes(q) ? 1.5 : (r.description || "").toLowerCase().includes(q) ? 1 : 0);
    const hits = d.repos.filter(score).sort((a, b) => score(b) - score(a)).slice(0, 8);
    if (!hits.length) return `No project matches ${q}.`;
    return hits.map((r) => {
      const where = sites(r).map((s) => `\n  folder: ${folderOf(s) || `${s.root}/${s.rel}`} (${s.role}, ${s.branch || "detached"})`).join("");
      const state = r.hidden ? "off the map" : r.attention || "";
      return `- ${label(r)} (${island(d, r)}${state ? `, ${state}` : ""}${r.kind !== "mine" ? `, ${r.kind}` : ""}): ${(r.description || "").slice(0, 120)}\n  ${r.url || "no GitHub repo"} · ${waiting(pendingOf(r))}${where}`;
    }).join("\n");
  }

  async function brief({ repo } = {}) {
    const d = await doc();
    const r = resolve(d, repo);
    const [sess, work, apps, plans] = await Promise.all([
      api(`/api/sessions?repo=${encodeURIComponent(r.id)}`).catch(() => ({ sessions: [] })),
      api("/api/work").catch(() => ({ jobs: [] })),
      api("/api/apps").catch(() => ({ apps: [] })),
      api("/api/plans").catch(() => ({ links: {} })),
    ]);
    const m = r.meaning || {};
    const lines = [`${label(r)} — ${[island(d, r), r.kind, r.recency, r.stage].filter(Boolean).join(" · ")}${r.attention ? ` · ${r.attention}` : ""}${r.hidden ? " · off the map" : ""}`];
    if (m.purpose) lines.push(m.purpose);
    if (r.url) lines.push(`${r.url} · ${r.openPRs || 0} open PRs · ${r.openIssues || 0} open issues · last activity ${ago(r.lastActivity)}`);
    if (m.next || m.blockers) lines.push(`Where you left it:${m.next ? ` next: ${m.next}` : ""}${m.blockers ? ` · blocked: ${m.blockers}` : ""}`);
    if ((r.risks || []).length) lines.push("Needs you: " + r.risks.map((k) => k.text).join("; "));
    if (!sites(r).length) lines.push("Not on this machine.");
    for (const s of sites(r)) {
      lines.push(`Folder: ${folderOf(s) || `${s.root}/${s.rel}`} (${s.role}, on ${s.branch || "detached"}${s.dirty ? `, ${s.dirty} uncommitted` : ""}${s.ahead ? `, ${s.ahead} ahead` : ""}${s.behind ? `, ${s.behind} behind` : ""}; last commit ${ago(s.lastCommit)})`);
    }
    const commits = (mainSite(r)?.commits || []).slice(0, 5);
    if (commits.length) lines.push("Recent commits:" + commits.map((c) => `\n  ${c.sha} ${c.subject} (${ago(c.at)})`).join(""));
    const app = (apps.apps || []).find((a) => a.repo === r.id);
    if (app) {
      const kinds = (app.apps || []).map((a) => `${a.label}${a.targets?.length ? ` [${a.targets.map((t) => `${t.label}${t.ok ? "" : `: ${t.why}`}`).join(", ")}]` : ""}`).join("; ");
      lines.push(app.running?.length ? `Running now: ${app.running.map((x) => `:${x.port} (${x.by === "atlas" ? "started by Hangar" : "started elsewhere"})`).join(", ")}${kinds ? ` — ${kinds}` : ""}` : kinds ? `App: ${kinds} (not running)` : "No app detected.");
    }
    const jobs = (work.jobs || []).filter((j) => j.repo === r.id).slice(0, 3);
    if (jobs.length) lines.push("Hangar jobs:" + jobs.map((j) => `\n  ${j.id.slice(0, 8)} ${j.provider} · ${j.kind || "code"} · ${j.state} · ${ago(j.startedAt)}${lastLine(j)}`).join(""));
    const recent = (sess.sessions || []).slice(0, 6);
    lines.push(recent.length ? "Recent sessions (evidence of past work, not of a running process):" + recent.map((s) => `\n  ${s.provider} · ${s.title || s.summary} · ${ago(s.lastEventAt || s.updatedAt)}${s.state && s.state !== "unknown" ? ` · ${s.state}` : ""} · ${s.id}`).join("") : "No indexed Claude or Codex sessions for this project.");
    const link = plans.links?.[r.id];
    if (link) lines.push(`PlanQuest plan: ${typeof link === "string" ? link : JSON.stringify(link)}`);
    return lines.join("\n");
  }

  const lastLine = (j) => { const o = (j.output || []).at(-1); return o ? `\n    ${String(o.text).slice(0, 200)}` : ""; };

  async function sessionsTool({ repo, provider, days = 14, limit = 20 } = {}) {
    if (provider && !["claude", "codex"].includes(provider)) throw new WorldError("provider is claude or codex.");
    days = Math.min(Math.max(Number(days) || 14, 1), 365);
    limit = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const lib = await api("/api/sessions/library");
    let rows = (lib.sessions || []).filter((s) => !s.archived);
    let scope = "every project";
    if (repo) {
      const r = resolve(await doc(), repo);
      rows = rows.filter((s) => (s.projects || []).some((p) => p.id === r.id));
      scope = label(r);
    }
    if (provider) rows = rows.filter((s) => s.provider === provider);
    rows = rows.filter((s) => now() - Date.parse(s.activityAt || s.updatedAt) <= days * DAY);
    rows.sort((a, b) => Date.parse(b.activityAt || b.updatedAt) - Date.parse(a.activityAt || a.updatedAt));
    const claude = rows.filter((s) => s.provider === "claude").length;
    const lines = [`${rows.length} session${rows.length === 1 ? "" : "s"} in ${scope} over the last ${days} days: ${claude} Claude Code, ${rows.length - claude} Codex.${rows.length > limit ? ` Showing ${limit}.` : ""}`];
    for (const s of rows.slice(0, limit)) {
      const projects = (s.projects || []).map((p) => p.name).join(", ") || "no project";
      lines.push(`- ${s.provider === "codex" ? "CX" : "CL"} ${s.title} — ${projects} · ${s.idleDays === 0 ? "today" : `${s.idleDays ?? "?"}d idle`}${s.unread === true ? " · unread" : ""}${s.opensIn ? ` · opens in ${s.opensIn}` : ""} · ${s.id}`);
    }
    return lines.join("\n");
  }

  async function jobs({ id } = {}) {
    const work = await api("/api/work");
    const all = work.jobs || [];
    if (id) {
      const j = all.find((x) => x.id === id || x.id.startsWith(id));
      if (!j) throw new WorldError(`No Hangar job starts with ${id}.`);
      const head = `${j.project} · ${j.provider} · ${j.kind || "code"} · ${j.state} · started ${ago(j.startedAt)}${j.endedAt ? `, ended ${ago(j.endedAt)} (exit ${j.exitCode})` : ""}${j.session ? ` · continues session ${j.session}` : ""}`;
      return [head, `Task: ${String(j.prompt || "").slice(0, 600)}`, "Output:", ...(j.output || []).map((o) => `  ${o.text}`)].join("\n");
    }
    const agents = await api("/api/agents").catch(() => null);
    const running = all.filter((j) => ["running", "stopping", "unobserved"].includes(j.state)).length;
    const lines = [`${running} running of ${work.limit ?? 2} allowed.`];
    for (const a of agents?.agents || []) lines.push(`${a.name}: ${!a.installed ? "not installed" : a.signedIn === false ? `not signed in (${a.reason})` : "signed in"}`);
    if (!all.length) lines.push("No Hangar jobs yet.");
    for (const j of all.slice(0, 10)) lines.push(`- ${j.id.slice(0, 8)} ${j.project} · ${j.provider} · ${j.kind || "code"} · ${j.state} · ${ago(j.startedAt)}${lastLine(j)}`);
    return lines.join("\n");
  }

  async function job({ action, repo, provider, prompt, session, id } = {}) {
    if (action === "start") {
      if (!["claude", "codex"].includes(provider)) throw new WorldError("provider is claude or codex.");
      if (typeof prompt !== "string" || !prompt.trim()) throw new WorldError("Give the job a task.");
      const r = resolve(await doc(), repo);
      const out = await api("/api/work", { action: "start", repo: r.id, provider, prompt: prompt.trim(), ...(session ? { session } : {}) });
      const started = out.job || out;
      return `Started ${provider} in ${label(r)} as job ${started.id || "?"}. Read its steps with hangar_jobs id=${(started.id || "").slice(0, 8)}; it keeps running after this call.`;
    }
    if (action === "stop" || action === "acknowledge") {
      if (!id) throw new WorldError("Which job? Use hangar_jobs for ids.");
      const full = (await api("/api/work")).jobs?.find((x) => x.id === id || x.id.startsWith(id));
      await api("/api/work", { action, id: full?.id || id });
      return action === "stop" ? `Stop requested for job ${id}.` : `Job ${id} acknowledged; its checkout is free for a new job.`;
    }
    throw new WorldError("action is start, stop or acknowledge.");
  }

  async function open({ repo, app, intent } = {}) {
    if (!APPS.includes(app)) throw new WorldError(`app is one of ${APPS.join(", ")}.`);
    if (intent && !KINDS.includes(intent)) throw new WorldError("intent is one of commit, push, pull, prs.");
    const r = resolve(await doc(), repo);
    if (!sites(r).length) throw new WorldError(`${label(r)} is not on this machine.`);
    const out = await api("/api/open", { repo: r.id, site: siteIndex(r), with: app, ...(intent ? { intent } : {}) });
    return `Opened ${label(r)} in ${out.app || app}.`;
  }

  async function note({ repo, state, next, purpose } = {}) {
    if (state && !STATES.includes(state)) throw new WorldError(`state is one of ${STATES.join(", ")}.`);
    const fields = {};
    if (state) Object.assign(fields, { focus: state === "focus", parked: state === "parked", hidden: state === "hidden" });
    if (typeof next === "string") fields.next = next;
    if (typeof purpose === "string") fields.purpose = purpose;
    if (!Object.keys(fields).length) throw new WorldError("Give a state, a next step or a purpose to save.");
    const r = resolve(await doc(), repo);
    await api("/api/notes", { repo: r.id, fields });
    const did = [state && (state === "none" ? "back on its island" : state), typeof next === "string" && "next step saved", typeof purpose === "string" && "purpose saved"].filter(Boolean).join(", ");
    return `${label(r)}: ${did}. Saved in Hangar only; the repo is untouched.`;
  }

  async function rescan({ github = false } = {}) {
    const out = await api("/api/rescan", { github: !!github });
    return out.started ? `Rescan started (this machine${github ? " and GitHub" : ""}); the map updates when it finishes.` : "A scan is already running.";
  }

  async function appsTool({ repo } = {}) {
    const data = await api("/api/apps");
    const m = data.machine || {};
    const can = `This machine: Node ${m.node ? "yes" : "no"}, Flutter ${m.flutter ? "yes" : "no"}, Android SDK ${m.androidSdk ? "yes" : "no"}, Xcode ${m.xcode ? "yes" : "no"}.`;
    if (repo) {
      const r = resolve(await doc(), repo);
      const a = (data.apps || []).find((x) => x.repo === r.id);
      if (!a) return `${label(r)}: no app detected. ${can}`;
      const lines = [`${label(r)}: ${a.running?.length ? "running on " + a.running.map((x) => `:${x.port}`).join(", ") : "not running"}.`];
      for (const app of a.apps || []) lines.push(`- ${app.label}${app.dir ? ` in ${app.dir}` : ""}: ${(app.targets || []).map((t) => `${t.label} ${t.ok ? "can run here" : `cannot run here (${t.why})`}`).join("; ")}`);
      lines.push(can);
      return lines.join("\n");
    }
    const live = (data.apps || []).filter((a) => a.running?.length);
    return [`${live.length} projects have an app running. ${can}`, ...live.map((a) => `- ${a.name}: ${a.running.map((x) => `:${x.port} (${x.by === "atlas" ? "started by Hangar" : "started elsewhere"})`).join(", ")}`)].join("\n");
  }

  // The dispatcher wants { text } or { error }; engine and validation failures are errors, anything else is a bug.
  const guard = (fn) => async (args) => {
    try { return { text: await fn(args || {}) }; }
    catch (e) { if (e instanceof WorldError) return { error: e.message }; throw e; }
  };
  const read = { readOnlyHint: true, openWorldHint: false };

  return [
    { name: "hangar_pending", description: "What is waiting on the user across their projects: uncommitted changes, commits on no remote branch, a pull needed, open pull requests. Start here when they ask what needs doing. Counts come from the last scan and say how old they are. kind narrows to one list; scope all adds vendor copies and forks.", inputSchema: { type: "object", properties: { kind: { type: "string", enum: KINDS }, scope: { type: "string", enum: ["mine", "all"], description: "mine (default) leaves out vendor copies and forks." } } }, annotations: read, run: guard(pending) },
    { name: "hangar_brief", description: "What an agent should know before working in a project: purpose, island, what needs the user, the folder on this machine with its branch state, recent commits, whether its app is running, Hangar jobs, and recent Claude Code and Codex sessions. Session history is evidence of past work, never proof that something is running or finished.", inputSchema: { type: "object", properties: { repo: REPO }, required: ["repo"] }, annotations: read, run: guard(brief) },
    { name: "hangar_find", description: "Find projects by name or description: GitHub address, island, folders on this machine and what is waiting on each.", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }, annotations: read, run: guard(find) },
    { name: "hangar_sessions", description: "Recent Claude Code and Codex sessions indexed on this machine, newest first, with the project each touched and whether its desktop app can open it. Filter by project, agent and days. Use it to find the conversation to continue rather than starting over.", inputSchema: { type: "object", properties: { repo: REPO, provider: { type: "string", enum: ["claude", "codex"] }, days: { type: "number", description: "Look back this many days (default 14)." }, limit: { type: "number", description: "At most this many rows (default 20)." } } }, annotations: read, run: guard(sessionsTool) },
    { name: "hangar_jobs", description: "The coding jobs Hangar itself ran (an agent started from Hangar in a project folder): state, when, and the last thing it said, plus whether Claude Code and Codex are signed in for the next one. With id, the full step-by-step output of one job.", inputSchema: { type: "object", properties: { id: { type: "string", description: "A job id or its first characters." } } }, annotations: read, run: guard(jobs) },
    { name: "hangar_job", description: "start: run Claude Code or Codex on a task in a project's main folder as a Hangar job (at most two at once, one per checkout; the agent's own permissions apply; optionally continue an indexed session). stop: end a running job. acknowledge: clear a job the engine lost track of. Ask the user before starting work on their behalf.", inputSchema: { type: "object", properties: { action: { type: "string", enum: ["start", "stop", "acknowledge"] }, repo: REPO, provider: { type: "string", enum: ["claude", "codex"] }, prompt: { type: "string", description: "start: the task, up to 8,000 characters." }, session: { type: "string", description: "start: a session id from hangar_sessions to continue." }, id: { type: "string", description: "stop / acknowledge: the job id." } }, required: ["action"] }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, run: guard(job) },
    { name: "hangar_open", description: "Open a project's main folder on this machine in claude (a new Claude Code session), codex (a new Codex thread), code (VS Code), cursor, or folder (the file manager). intent gives the new session a starting question about what is waiting: commit, push, pull or prs. Ask the user before opening apps for them.", inputSchema: { type: "object", properties: { repo: REPO, app: { type: "string", enum: APPS }, intent: { type: "string", enum: KINDS } }, required: ["repo", "app"] }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, run: guard(open) },
    { name: "hangar_note", description: "Remember something about a project in Hangar: state focus (centre of the map), parked (the edge), hidden (off the map and out of every count) or none (back on its island); next, the next step in the user's words; purpose, one line on what it is. Written to Hangar's own notes, never into the repo.", inputSchema: { type: "object", properties: { repo: REPO, state: { type: "string", enum: STATES }, next: { type: "string", maxLength: 400 }, purpose: { type: "string", maxLength: 400 } }, required: ["repo"] }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, run: guard(note) },
    { name: "hangar_apps", description: "Which projects have an app running on this machine and on which ports, so you do not clash with them; for one project, what kind of app it is and which targets this machine can run.", inputSchema: { type: "object", properties: { repo: REPO } }, annotations: read, run: guard(appsTool) },
    { name: "hangar_rescan", description: "Rescan this machine's folders now (under a minute), and GitHub too when github is true (a minute or two). The map refreshes itself every 15 minutes while someone is using it, so this is for right after a commit or clone.", inputSchema: { type: "object", properties: { github: { type: "boolean" } } }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }, run: guard(rescan) },
  ];
}
