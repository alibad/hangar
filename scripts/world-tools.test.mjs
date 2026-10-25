import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { worldTools } from "./world-tools.mjs";

const NOW = Date.parse("2026-10-25T20:00:00Z");
const at = (minutesAgo) => new Date(NOW - minutesAgo * 60_000).toISOString();
const DOC = {
  generatedAt: at(5),
  machine: { id: "m1", os: "win32", scannedAt: at(12), roots: ["CODE"] },
  github: { fetchedAt: at(130), owners: ["alibad"] },
  families: [{ id: "ailab", name: "AI lab", repos: 3 }],
  apps: [{ id: "claude", name: "Claude Code", kind: "agent" }, { id: "code", name: "VS Code", kind: "editor" }],
  repos: [
    { id: "R1", name: "football-ai-lab", fullName: "alibad/football-ai-lab", url: "https://github.com/alibad/football-ai-lab", description: "Coach app", kind: "mine", family: "ailab", stage: "midrise", recency: "live", attention: null, hidden: false, openPRs: 0, openIssues: 2, onMachine: true, lastActivity: at(60 * 24),
      meaning: { purpose: "Open the hosted coach app.", next: "Push the fifteen commits", blockers: "" },
      risks: [{ id: "unpushed", level: "high", text: "The main folder is 15 commits ahead of origin/main (as of its last fetch)" }, { id: "uncommitted", level: "medium", text: "18 uncommitted changes" }],
      sites: [{ root: "CODE", rel: "AI/football-ai-lab", role: "canonical", branch: "main", ahead: 15, behind: 0, dirty: 18, lastCommit: at(60 * 21), commits: [{ sha: "81d68eb", at: at(60 * 21), subject: "Merge remote-tracking branch 'origin/main'" }] }] },
    { id: "R2", name: "ComfyUI", fullName: "comfyanonymous/ComfyUI", url: "https://github.com/comfyanonymous/ComfyUI", kind: "vendor", family: "ailab", hidden: false, openPRs: 0, onMachine: true, meaning: {},
      risks: [{ id: "uncommitted", level: "medium", text: "2 uncommitted changes" }], sites: [{ root: "CODE", rel: "AI/creative-lab/image/ComfyUI", role: "vendor", branch: "master", dirty: 2 }] },
    { id: "R3", name: "secret-thing", fullName: "alibad/secret-thing", kind: "mine", family: "ailab", hidden: true, openPRs: 3, risks: [], sites: [], meaning: {} },
    { id: "R4", name: "hypotheses", fullName: "alibad/hypotheses", url: "https://github.com/alibad/hypotheses", kind: "mine", family: "ailab", hidden: false, openPRs: 9, onMachine: false, risks: [{ id: "prs", level: "low", text: "9 open pull requests" }], sites: [], meaning: {} },
  ],
};
const LIBRARY = { idleDays: 7, groups: [], sessions: [
  { id: "s-claude", key: "claude:s-claude", provider: "claude", title: "Fix video analysis", projects: [{ id: "R1", name: "football-ai-lab", files: ["a.ts"], evidence: "edit-tool" }], activityAt: at(60 * 26), updatedAt: at(60 * 26), idleDays: 1, unread: null, archived: false, opensIn: "app" },
  { id: "s-codex", key: "codex:s-codex", provider: "codex", title: "Reply with the single word ready.", projects: [], activityAt: at(60 * 24 * 30), updatedAt: at(60 * 24 * 30), idleDays: 30, unread: true, archived: false, opensIn: "app" },
  { id: "s-old", key: "claude:s-old", provider: "claude", title: "Archived one", projects: [{ id: "R1", name: "football-ai-lab", files: [], evidence: "working-directory" }], activityAt: at(60), updatedAt: at(60), idleDays: 0, unread: null, archived: true },
] };
const JOBS = { limit: 2, jobs: [{ id: "job1234567abc", repo: "R1", project: "football-ai-lab", provider: "claude", kind: "code", state: "failed", prompt: "Review this project", startedAt: at(50), endedAt: at(49), exitCode: 1, session: null,
  output: [{ at: at(50), text: "Started claude-opus-5-5" }, { at: at(49), text: "API Error: 401 OAuth access token is invalid. The agent's command-line sign-in has expired." }] }] };

async function engine(t) {
  const posts = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const send = (code, body) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.method === "POST") {
      if (req.headers["x-hangar"] !== "1") return send(403, { error: "forbidden" });
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        const body = JSON.parse(raw || "{}");
        posts.push({ path: url.pathname, body });
        if (url.pathname === "/api/work") {
          if (body.action === "start" && !body.prompt) return send(400, { error: "Choose an agent and enter a task (up to 8,000 characters)." });
          return send(202, body.action === "start" ? { id: "newjob0001", started: true } : { stopped: true });
        }
        if (url.pathname === "/api/notes") return send(200, { saved: true });
        if (url.pathname === "/api/open") return send(200, { opened: true, app: "Claude Code" });
        if (url.pathname === "/api/rescan") return send(202, { started: true });
        send(404, { error: "not found" });
      });
      return;
    }
    switch (url.pathname) {
      case "/api/status": return send(200, { protocol: "hangar-engine-v1" });
      case "/api/atlas": return send(200, DOC);
      case "/api/sessions": return send(200, { sessions: url.searchParams.get("repo") === "R1" ? [{ id: "s-claude", provider: "claude", title: "Fix video analysis", updatedAt: at(60 * 26), lastEventAt: at(60 * 26), state: "completed", summary: "Edited 1 files across 1 projects", canResume: true, projects: [{ id: "R1", name: "football-ai-lab", files: ["a.ts"], evidence: "edit-tool" }] }] : [] });
      case "/api/sessions/library": return send(200, LIBRARY);
      case "/api/work": return send(200, JOBS);
      case "/api/agents": return send(200, { agents: [{ id: "claude", name: "Claude Code", installed: true, signedIn: false, reason: "Claude Code's sign-in on this machine expired on 10 Jun 2026." }, { id: "codex", name: "Codex", installed: true, signedIn: true, reason: "" }] });
      case "/api/apps": return send(200, { machine: { os: "windows", node: true, flutter: false, androidSdk: false, xcode: false }, apps: [{ repo: "R1", name: "football-ai-lab", running: [{ port: 3100, pid: 1, by: "elsewhere" }], jobs: {}, apps: [{ kind: "next", label: "Next.js web app", dir: "web", targets: [{ id: "web", label: "Web", ok: true, why: "" }] }] }] });
      case "/api/plans": return send(200, { links: {} });
      default: return send(404, { error: "not found" });
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const dataDir = await mkdtemp(join(tmpdir(), "hangar-world-tools-"));
  await writeFile(join(dataDir, "roots.json"), JSON.stringify({ roots: { CODE: join(dataDir, "Code") } }));
  t.after(async () => { server.close(); await rm(dataDir, { recursive: true, force: true }); });
  const starts = [];
  const tools = worldTools({ engine: `http://127.0.0.1:${server.address().port}`, dataDir, now: () => NOW, start: () => starts.push(1), sleep: async () => {} });
  const call = (name, args) => tools.find((x) => x.name === name).run(args);
  return { tools, call, posts, starts, dataDir };
}

test("every world tool has a schema, a description and no engine secrets in its description", async (t) => {
  const { tools } = await engine(t);
  assert.equal(tools.length, 10);
  for (const tool of tools) {
    assert.match(tool.name, /^hangar_/);
    assert.ok(tool.description.length > 40);
    assert.equal(tool.inputSchema.type, "object");
    assert.doesNotMatch(tool.description, /7789|127\.0\.0\.1/);
  }
});

test("pending leaves out vendor copies and hidden repos by default, and names the folder", async (t) => {
  const { call, dataDir } = await engine(t);
  const { text } = await call("hangar_pending", {});
  assert.match(text, /This machine checked 12 min ago, GitHub 2 h ago/);
  assert.match(text, /1 vendor copy or fork left out/);
  assert.match(text, /1 to commit · 1 to push · 0 to pull · 1 pull requests/);
  assert.match(text, /alibad\/football-ai-lab: 18 uncommitted — .*football-ai-lab/);
  assert.ok(text.includes(join(dataDir, "Code", "AI", "football-ai-lab")));
  assert.doesNotMatch(text, /ComfyUI|secret-thing/);
  assert.match(text, /alibad\/hypotheses: 9 open/);
  const all = await call("hangar_pending", { scope: "all" });
  assert.match(all.text, /ComfyUI \(vendor\): 2 uncommitted/);
  assert.doesNotMatch(all.text, /secret-thing/);
  const one = await call("hangar_pending", { kind: "push" });
  assert.match(one.text, /To push \(1\)/);
  assert.doesNotMatch(one.text, /To commit \(/);
  assert.match((await call("hangar_pending", { kind: "everything" })).error, /kind is one of/);
});

test("brief gathers risks, folder, commits, the running app, jobs and sessions for one project", async (t) => {
  const { call } = await engine(t);
  const { text, error } = await call("hangar_brief", { repo: "football-ai-lab" });
  assert.equal(error, undefined);
  assert.match(text, /^alibad\/football-ai-lab — AI lab · mine · live · midrise/);
  assert.match(text, /Where you left it: next: Push the fifteen commits/);
  assert.match(text, /Needs you: The main folder is 15 commits ahead/);
  assert.match(text, /Folder: .*football-ai-lab \(canonical, on main, 18 uncommitted, 15 ahead; last commit 21 h ago\)/);
  assert.match(text, /81d68eb Merge remote-tracking branch/);
  assert.match(text, /Running now: :3100 \(started elsewhere\) — Next.js web app \[Web\]/);
  assert.match(text, /Hangar jobs:\n  job12345 claude · code · failed/);
  assert.match(text, /Recent sessions \(evidence of past work.*\n  claude · Fix video analysis · 26 h ago · completed · s-claude/);
  assert.match((await call("hangar_brief", { repo: "nothing-like-this" })).error, /No project called nothing-like-this/);
  assert.match((await call("hangar_brief", { repo: "" })).error, /Say which project/);
});

test("find matches by name and shows what is waiting", async (t) => {
  const { call } = await engine(t);
  const { text } = await call("hangar_find", { query: "foot" });
  assert.match(text, /alibad\/football-ai-lab \(AI lab\): Coach app/);
  assert.match(text, /18 uncommitted, to push/);
  assert.match(text, /folder: .*football-ai-lab \(canonical, main\)/);
  assert.equal((await call("hangar_find", { query: "zzz" })).text, "No project matches zzz.");
});

test("sessions filter by project, agent and age, and never list archived ones", async (t) => {
  const { call } = await engine(t);
  const every = await call("hangar_sessions", {});
  assert.match(every.text, /1 session in every project over the last 14 days: 1 Claude Code, 0 Codex/);
  assert.doesNotMatch(every.text, /Archived one/);
  const month = await call("hangar_sessions", { days: 31 });
  assert.match(month.text, /2 sessions in every project over the last 31 days: 1 Claude Code, 1 Codex/);
  assert.match(month.text, /CX Reply with the single word ready\. — no project · 30d idle · unread · opens in app/);
  const project = await call("hangar_sessions", { repo: "football-ai-lab", days: 31 });
  assert.match(project.text, /1 session in alibad\/football-ai-lab/);
  assert.doesNotMatch(project.text, /single word ready/);
  assert.match((await call("hangar_sessions", { provider: "gemini" })).error, /provider is claude or codex/);
});

test("jobs show sign-in state and the last line; one job shows every step", async (t) => {
  const { call } = await engine(t);
  const { text } = await call("hangar_jobs", {});
  assert.match(text, /0 running of 2 allowed/);
  assert.match(text, /Claude Code: not signed in \(Claude Code's sign-in on this machine expired/);
  assert.match(text, /Codex: signed in/);
  assert.match(text, /- job12345 football-ai-lab · claude · code · failed · 50 min ago\n    API Error: 401/);
  const one = await call("hangar_jobs", { id: "job1234" });
  assert.match(one.text, /^football-ai-lab · claude · code · failed · started 50 min ago, ended 49 min ago \(exit 1\)/);
  assert.match(one.text, /Task: Review this project\nOutput:\n  Started claude-opus-5-5\n  API Error/);
  assert.match((await call("hangar_jobs", { id: "nope" })).error, /No Hangar job starts with nope/);
});

test("starting a job posts the resolved project id with the engine's header, and passes its refusals through", async (t) => {
  const { call, posts } = await engine(t);
  const { text } = await call("hangar_job", { action: "start", repo: "football-ai-lab", provider: "codex", prompt: "  Review the uncommitted changes  " });
  assert.match(text, /Started codex in alibad\/football-ai-lab as job newjob0001/);
  assert.deepEqual(posts.at(-1), { path: "/api/work", body: { action: "start", repo: "R1", provider: "codex", prompt: "Review the uncommitted changes" } });
  assert.match((await call("hangar_job", { action: "start", repo: "football-ai-lab", provider: "codex", prompt: "" })).error, /Give the job a task/);
  assert.match((await call("hangar_job", { action: "start", repo: "football-ai-lab", provider: "gpt", prompt: "x" })).error, /provider is claude or codex/);
  assert.match((await call("hangar_job", { action: "stop" })).error, /Which job/);
  await call("hangar_job", { action: "stop", id: "job1234" });
  assert.deepEqual(posts.at(-1), { path: "/api/work", body: { action: "stop", id: "job1234567abc" } });
});

test("open and note write through the engine with the canonical folder and Hangar's note fields", async (t) => {
  const { call, posts } = await engine(t);
  assert.equal((await call("hangar_open", { repo: "football-ai-lab", app: "claude", intent: "commit" })).text, "Opened alibad/football-ai-lab in Claude Code.");
  assert.deepEqual(posts.at(-1), { path: "/api/open", body: { repo: "R1", site: 0, with: "claude", intent: "commit" } });
  assert.match((await call("hangar_open", { repo: "hypotheses", app: "code" })).error, /not on this machine/);
  assert.match((await call("hangar_open", { repo: "football-ai-lab", app: "vim" })).error, /app is one of/);
  const noted = await call("hangar_note", { repo: "football-ai-lab", state: "focus", next: "Push, then open the PR" });
  assert.match(noted.text, /focus, next step saved\. Saved in Hangar only/);
  assert.deepEqual(posts.at(-1), { path: "/api/notes", body: { repo: "R1", fields: { focus: true, parked: false, hidden: false, next: "Push, then open the PR" } } });
  assert.match((await call("hangar_note", { repo: "football-ai-lab" })).error, /Give a state, a next step or a purpose/);
  assert.match((await call("hangar_rescan", { github: true })).text, /Rescan started \(this machine and GitHub\)/);
  assert.deepEqual(posts.at(-1), { path: "/api/rescan", body: { github: true } });
});

test("apps list running ports and what this machine can run", async (t) => {
  const { call } = await engine(t);
  assert.match((await call("hangar_apps", {})).text, /1 projects have an app running\. This machine: Node yes, Flutter no.*\n- football-ai-lab: :3100 \(started elsewhere\)/);
  assert.match((await call("hangar_apps", { repo: "football-ai-lab" })).text, /running on :3100\.\n- Next.js web app in web: Web can run here/);
});

test("a dead engine is started once, then reported plainly when it still does not answer", async () => {
  const starts = [];
  const tools = worldTools({ engine: "http://127.0.0.1:9", start: () => starts.push(1), sleep: async () => {}, now: () => NOW });
  const out = await tools.find((x) => x.name === "hangar_pending").run({});
  assert.match(out.error, /not running and could not be started/);
  assert.match(out.error, /start-engine\.mjs/);
  assert.equal(starts.length, 1);
  await tools.find((x) => x.name === "hangar_jobs").run({});
  assert.equal(starts.length, 1, "the engine is started at most once per helper");
});
