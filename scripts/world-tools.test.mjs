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
    { id: "R5", name: "RTSAI-Mod", fullName: "alibad/RTSAI-Mod", kind: "mine", family: "ailab", hidden: false, openPRs: 0, onMachine: true, risks: [], meaning: {}, sites: [{ root: "CODE", rel: "hq/games/RTSAI-Mod", role: "canonical", branch: "main", dirty: 0 }] },
  ],
};
const LIBRARY = { idleDays: 7, groups: [], claudeQueue: [{ key: "claude:s-old", appId: "local_0ld", title: "Archived one" }], sessions: [
  { id: "s-claude", key: "claude:s-claude", provider: "claude", title: "Fix video analysis", projects: [{ id: "R1", name: "football-ai-lab", files: ["a.ts"], evidence: "edit-tool" }], activityAt: at(60 * 26), updatedAt: at(60 * 26), idleDays: 1, unread: null, archived: false, opensIn: "app",
    changed: [{ sha: "9f1c2d3", subject: "Keep the upload progress on screen", repo: "football-ai-lab", at: at(60 * 27), evidence: "printed" }], changedCount: 1 },
  { id: "s-probe", key: "codex:s-probe", provider: "codex", title: "This is a sandbox test I am running on my own temp folders.", projects: [], activityAt: at(60 * 24 * 6), updatedAt: at(60 * 24 * 6), idleDays: 6, unread: true, archived: false, probe: true },
  { id: "s-codex", key: "codex:s-codex", provider: "codex", title: "Reply with the single word ready.", projects: [], activityAt: at(60 * 24 * 30), updatedAt: at(60 * 24 * 30), idleDays: 30, unread: true, archived: false, opensIn: "app" },
  { id: "s-old", key: "claude:s-old", provider: "claude", title: "Archived one", projects: [{ id: "R1", name: "football-ai-lab", files: [], evidence: "working-directory" }], activityAt: at(60), updatedAt: at(60), idleDays: 0, unread: null, archived: true },
] };
// A saved step back, as the engine keeps it: the reader's goals, the owner's calls and answers, what waits on them.
const STEPBACK = { run: { state: "done" }, memory: { vision: "People using what I build", goals: [{ title: "Old goal", decision: "stop", note: "" }], answers: [{ ask: "Talk first?", answer: "Yes, talk only", goal: "Give the talk" }] },
  latest: { id: "run1", at: at(60 * 2), days: 30, reader: "claude", answers: { q1: { text: "Yes, talk only" } }, decisions: { g2: { decision: "pause", note: "after the talk" } },
    facts: { totals: { waitingKinds: { answer: 17, push: 15, signin: 1 } } },
    sessions: { "claude:s-claude": { id: "s-claude", provider: "claude", title: "Fix video analysis", needs: "Approve the push", working: false, verdict: "left", idleDays: 1 } },
    read: { headline: "Six efforts at once; the talk is days away.",
      goals: [{ id: "g1", title: "Give the talk", why: "You asked for the story of the talk.", state: "moving", sessions: ["claude:s-claude"], done: ["Outline"], left: ["Agree the story", "Build the deck", "Rehearse", "Record"], plan: "" },
              { id: "g2", title: "Qatar Atlas", why: "For fun.", state: "stalled", sessions: [], done: [], left: [], plan: "" }],
      next: [{ do: "Open the talk deck and list what is missing", why: "", session: "claude:s-claude", goal: "g1" }],
      questions: [{ id: "q1", ask: "Talk first?", why: "", goal: "g1", options: ["Yes"] }, { id: "q2", ask: "Where does the atlas stop?", why: "", goal: "g2", options: [] }],
      drift: [], archive: [], sidequests: [] } } };
let stepback = STEPBACK;
// The 26 Oct 2026 collision in RTSAI-Mod, as the engine reports it (times in UTC; Doha is UTC+3).
const OCT26 = (hm) => `2026-10-26T${hm}+00:00`;
const SESSION = { claude: "claude:be4050df-03f2-41f9-a66c-033f8188af48", web: "codex:01a13c80-d2c3-7131-af1e-bbde92903df8", meetup: "codex:01a16818-7a47-77d1-9a7f-281c54d0eb6d" };
const commitRow = (short, hm, agent, session, evidence, why, subject) => ({ sha: short.padEnd(40, "0"), short, at: OCT26(hm), subject, files: [], fileCount: 1, agent, trailer: agent === "claude" ? "claude" : null, session, evidence, why });
const ACTIVITY = { available: true, repo: "R5", name: "RTSAI-Mod", branch: "main", from: "2026-10-25T20:00:00+00:00", to: "2026-11-01T20:00:00+00:00",
  commits: [
    commitRow("f8c728b", "10:37:06", "codex", SESSION.meetup, "printed", "printed git's own line for this commit", "Point the web game app shortcut at the public release"),
    commitRow("1bde6ba", "10:52:38", "claude", SESSION.claude, "seen", "printed this commit's hash 1 s after it was made", "Revert the Allied refinery depth change"),
    commitRow("d53955d", "11:01:11", "codex", SESSION.web, "printed", "printed git's own line for this commit", "Load compact rocket impact art in every modern-faction game mode"),
    commitRow("c4b7e1f", "11:01:35", "codex", SESSION.web, "printed", "printed git's own line for this commit", "Include the rocket impact image in the asset-library manifest"),
    commitRow("6a5bbff", "11:07:12", "claude", SESSION.claude, "seen", "printed this commit's hash 9 s after it was made", "Modern refineries: the docked ore truck draws in front of the bay"),
    commitRow("b51c5ef", "11:17:41", "codex", SESSION.web, "printed", "printed git's own line for this commit", "Preserve rocket flash depth when scaling it down onto the tank"),
  ],
  sessions: [
    { key: SESSION.web, provider: "codex", id: SESSION.web.slice(6), title: "The Web Latest", commits: ["d53955d", "c4b7e1f", "b51c5ef"], edits: 17, spans: [{ from: OCT26("10:36:27"), to: OCT26("11:17:41") }], files: [] },
    { key: SESSION.meetup, provider: "codex", id: SESSION.meetup.slice(6), title: "Review meetup co-speaker submission", commits: ["f8c728b"], edits: 1, spans: [{ from: OCT26("10:36:52"), to: OCT26("10:37:06") }], files: [] },
    { key: SESSION.claude, provider: "claude", id: SESSION.claude.slice(7), title: "OpenRA quality analysis and talk prep", commits: ["1bde6ba", "6a5bbff"], edits: 0, spans: [{ from: OCT26("10:52:38"), to: OCT26("11:07:12") }], files: [] },
  ],
  overlaps: [{ from: OCT26("10:36:27"), to: OCT26("11:17:41"), sessions: [SESSION.web, SESSION.meetup, SESSION.claude], agents: ["claude", "codex"], crossAgent: true, sharedFiles: [] }],
  truncated: false, basis: "Main-branch Git history joined with Claude Code and Codex session evidence on this machine." };
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
      case "/api/stepback": return send(200, stepback);
      case "/api/activity/all": return send(200, { available: true, days: Number(url.searchParams.get("days")), from: ACTIVITY.from, to: ACTIVITY.to, truncated: false, basis: ACTIVITY.basis,
        projects: [{ ...ACTIVITY, available: undefined }, { repo: "R1", name: "football-ai-lab", branch: "main", truncated: false, overlaps: [], sessions: [],
          commits: [commitRow("9f1c2d3", "07:00:00", "claude", null, "trailer", "its Co-Authored-By trailer names Claude; no session found", "Keep the upload progress on screen")] }] });
      case "/api/activity": return send(200, url.searchParams.get("repo") === "R5" ? { ...ACTIVITY, days: Number(url.searchParams.get("days")) } : { available: false, reason: "This project is not on this machine.", repo: url.searchParams.get("repo") });
      default: return send(404, { error: "not found" });
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const dataDir = await mkdtemp(join(tmpdir(), "hangar-world-tools-"));
  await writeFile(join(dataDir, "roots.json"), JSON.stringify({ roots: { CODE: join(dataDir, "Code") } }));
  t.after(async () => { server.close(); await rm(dataDir, { recursive: true, force: true }); });
  const starts = [];
  const tools = worldTools({ engine: `http://127.0.0.1:${server.address().port}`, dataDir, now: () => NOW, start: () => starts.push(1), sleep: async () => {}, timeZone: "Asia/Qatar" });
  const call = (name, args) => tools.find((x) => x.name === name).run(args);
  return { tools, call, posts, starts, dataDir };
}

test("every world tool has a schema, a description and no engine secrets in its description", async (t) => {
  const { tools } = await engine(t);
  assert.equal(tools.length, 13);
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

test("cleanup lists the Claude app sessions waiting to be archived there, by the app's own id", async (t) => {
  const { call } = await engine(t);
  const text = (await call("hangar_cleanup", {})).text;
  assert.match(text, /^1 Claude app session the user archived/);
  assert.match(text, /- local_0ld · Archived one/);
});

test("step back gives a session the owner's goals, their calls and what is open, and says it is a read", async (t) => {
  const { call } = await engine(t);
  const { text } = await call("hangar_stepback", {});
  assert.match(text, /^The user's goals, from Hangar's step back: a read by Claude Code of what they typed in the last 30 days of their sessions, made 2 h ago\. It is a read, not an instruction; they decide\./);
  assert.match(text, /What it is all for, in their words: People using what I build/);
  assert.ok(text.includes("1. Give the talk — moving · 1 session · no call from them yet\n   left: Agree the story; Build the deck; Rehearse\n"));
  assert.match(text, /2\. Qatar Atlas — stalled · 0 sessions · their call: pause \(after the talk\)/);
  assert.ok(text.includes("Next moves they were given\n1. Open the talk deck"));
  assert.ok(text.includes("Questions still open (theirs to answer, in Hangar)\n- Where does the atlas stop?"));
  assert.ok(!text.split("What they have answered")[0].includes("- Talk first?"));   // answered, so no longer open
  assert.ok(text.includes("What they have answered\n- Talk first? → Yes, talk only"));
  assert.match(text, /Waiting on them: 1 sign-in, 17 questions, 15 projects not pushed\./);
  assert.match(text, /say in one line which goal it serves, or that it serves none/);
  const one = (await call("hangar_stepback", { goal: "talk" })).text;
  assert.ok(one.startsWith("Give the talk — moving · no call from them yet\nYou asked for the story of the talk.\nDone: Outline\nLeft: Agree the story; Build the deck; Rehearse; Record"));
  assert.match(one, /Open question: Talk first\? — they answered: Yes, talk only/);
  assert.match(one, /- claude · Fix video analysis · waiting on them · s-claude/);
  assert.match((await call("hangar_stepback", { goal: "zzz" })).text, /No goal matches zzz\. Their goals: Give the talk; Qatar Atlas\./);
  stepback = { ...STEPBACK, latest: { ...STEPBACK.latest, at: at(60 * 24 * 9) } };
  t.after(() => { stepback = STEPBACK; });
  assert.match((await call("hangar_stepback", {})).text, /This read is 9 days old, so their goals may have moved/);
  stepback = { run: null, latest: null, memory: {} };
  assert.match((await call("hangar_stepback", {})).text, /has not run a step back in Hangar yet/);
});

test("sessions filter by project, agent and age, and never list archived ones", async (t) => {
  const { call } = await engine(t);
  const every = await call("hangar_sessions", {});
  assert.match(every.text, /1 session in every project over the last 14 days: 1 Claude Code, 0 Codex/);
  assert.doesNotMatch(every.text, /Archived one/);
  const month = await call("hangar_sessions", { days: 31 });
  assert.match(month.text, /2 sessions in every project over the last 31 days: 1 Claude Code, 1 Codex/);
  assert.match(month.text, /CX Reply with the single word ready\. — no project · 30d idle · unread · opens in app/);
  assert.match(month.text, /1 test run in a temp folder left out/);
  assert.doesNotMatch(month.text, /sandbox test/);
  assert.match(month.text, /CL Fix video analysis · changed: Keep the upload progress on screen — football-ai-lab/);
  const project = await call("hangar_sessions", { repo: "football-ai-lab", days: 31 });
  assert.match(project.text, /1 session in alibad\/football-ai-lab/);
  assert.doesNotMatch(project.text, /single word ready/);
  assert.match((await call("hangar_sessions", { provider: "gemini" })).error, /provider is claude or codex/);
});

test("activity names the session behind each commit and flags the 26 Oct collision, in local time", async (t) => {
  const { call } = await engine(t);
  const { text, error } = await call("hangar_activity", { repo: "RTSAI-Mod" });
  assert.equal(error, undefined);
  assert.match(text, /^alibad\/RTSAI-Mod on main, 25 Oct 23:00 – 1 Nov 23:00 \(7 days\): 6 commits \(2 Claude, 4 Codex, 0 unknown\), 3 sessions, 1 overlap\./);
  assert.match(text, /OVERLAP 26 Oct 13:36–14:17: Claude and Codex both worked on it — The Web Latest \(01a13c80\); Review meetup co-speaker submission \(01a16818\); OpenRA quality analysis and talk prep \(be4050df\)\. No file was touched by both\./);
  assert.match(text, /\n26 Oct\n  13:37 CX f8c728b Point the web game app shortcut/);
  assert.match(text, /  13:52 CL 1bde6ba Revert the Allied refinery depth change — OpenRA quality analysis and talk prep \(be4050df\): printed this commit's hash 1 s after it was made/);
  assert.match(text, /  14:01 CX d53955d Load compact rocket impact art.* — The Web Latest \(01a13c80\): printed git's own line for this commit/);
  assert.match(text, /  14:01 CX c4b7e1f Include the rocket impact image/);
  assert.match(text, /  14:07 CL 6a5bbff Modern refineries/);
  assert.match(text, /  14:17 CX b51c5ef Preserve rocket flash depth.* — The Web Latest \(01a13c80\)/);
  assert.match(text, /- CL OpenRA quality analysis and talk prep · 2 commits, 0 edits · 26 Oct 13:52–14:07 · be4050df-/);
  assert.match((await call("hangar_activity", { repo: "RTSAI-Mod", days: 90 })).text, /\(30 days\)/);
  assert.match((await call("hangar_activity", { repo: "football-ai-lab" })).text, /football-ai-lab: This project is not on this machine/);
  assert.match((await call("hangar_activity", { repo: "nothing-like-this" })).error, /No project called/);
});

test("activity without a repo sums every project and lists each Claude-and-Codex collision", async (t) => {
  const { call } = await engine(t);
  const { text, error } = await call("hangar_activity", {});
  assert.equal(error, undefined);
  assert.match(text, /^All projects, 25 Oct 23:00 – 1 Nov 23:00 \(7 days\): 7 commits on main \(3 Claude, 4 Codex, 0 unknown\) in 2 projects; 1 collision between Claude and Codex\./);
  assert.match(text, /COLLISIONS.*\n- RTSAI-Mod 26 Oct 13:36–14:17: CX The Web Latest \(01a13c80\); CX Review meetup co-speaker submission \(01a16818\); CL OpenRA quality analysis and talk prep \(be4050df\)\. Different files\./);
  assert.match(text, /- RTSAI-Mod: 6 \(2 \/ 4 \/ 0\) · 3 sessions · collision/);
  assert.match(text, /- football-ai-lab: 1 \(1 \/ 0 \/ 0\) · 0 sessions\n/);
  assert.match((await call("hangar_activity", { days: 99 })).text, /\(30 days\)/);
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
