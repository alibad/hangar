import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const scratch = await mkdtemp(path.join(tmpdir(), "hangar-signals-test-"));
const source = await readFile(new URL("../src/lib/project-signals.ts", import.meta.url), "utf8");
await writeFile(path.join(scratch, "project-signals.mjs"), ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
const { yourTurn, leftOff, suggestIslands } = await import(pathToFileURL(path.join(scratch, "project-signals.mjs")));
test.after(() => rm(scratch, { recursive: true, force: true }));

const session = (key, fields = {}) => ({ key, id: key, provider: "claude", title: `Work ${key}`, activityAt: "2026-11-01T10:00:00Z", archived: false, unread: false, status: null, projects: [{ id: "web", name: "web", evidence: "edit-tool" }], ...fields });
const repo = (id, family, rel, fields = {}) => ({ id, name: id, family, sites: rel === null ? [] : [{ role: "canonical", rel, root: "CODE" }], ...fields });

test("your turn: asks, reviews, unread replies and unpushed commits, newest first", () => {
  const repos = [repo("web", "quest", "hq/web", { risks: [{ id: "unpushed", text: "The main folder has 2 commits not on origin/main" }] }), repo("old", "quest", "hq/old", { hidden: true, risks: [{ id: "unpushed", text: "x" }] })];
  const turn = yourTurn(repos, [
    session("a", { status: { category: "blocked", detail: "four questions open", needsAction: "Answer the four questions\nthen continue" }, activityAt: "2026-11-01T10:00:00Z" }),
    session("b", { status: { category: "blocked", detail: "waiting", needsAction: "" }, activityAt: "2026-11-03T10:00:00Z" }),
    session("c", { status: { category: "review_ready", detail: "PR ready", needsAction: "" } }),
    session("d", { unread: true }),
    session("e", { unread: true, archived: true }),
    session("f", { status: { category: "blocked", detail: "probe", needsAction: "" }, probe: true }),
    session("g", { status: { category: "completed", detail: "pushed", needsAction: "" } }),
  ]);
  assert.deepEqual(turn.ask.map(i => i.key), ["b", "a"]);
  assert.equal(turn.ask[1].text, "Answer the four questions");
  assert.equal(turn.ask[0].text, "waiting");
  assert.deepEqual(turn.review.map(i => i.text), ["PR ready"]);
  assert.deepEqual(turn.unread.map(i => i.key), ["d"]);
  assert.deepEqual(turn.push.map(i => [i.project.id, i.text]), [["web", "The main folder has 2 commits not on origin/main"]]);
  assert.equal(turn.ask[0].project.id, "web");
});

test("left off: your next note first, then what the latest session ended on", () => {
  const web = repo("web", "quest", "hq/web");
  assert.equal(leftOff({ ...web, meaning: { next: "Ship the pricing page" } }, [session("a")]).tone, "next");
  assert.equal(leftOff(web, []), null);
  const older = session("a", { activityAt: "2026-10-01T00:00:00Z", status: { category: "completed", detail: "old", needsAction: "" } });
  const newer = session("b", { activityAt: "2026-11-02T00:00:00Z", status: { category: "blocked", detail: "waiting", needsAction: "Pick a site" } });
  assert.deepEqual([leftOff(web, [older, newer]).text, leftOff(web, [older, newer]).tone], ["Pick a site", "ask"]);
  assert.equal(leftOff(web, [older]).text, "old");
  assert.equal(leftOff(web, [session("c", { title: "Fix the login form" })]).text, "Fix the login form");
  // The library's fallback title (the project's own name) falls back to the session summary.
  assert.equal(leftOff(web, [session("d", { title: "web", summary: "Edited 3 files in web" })]).text, "Edited 3 files in web");
  assert.equal(leftOff(web, [session("e", { archived: true })]), null);
  // A newer sweep across many projects gives way to the last session that worked on this one, unless it is all there is.
  const many = ["web", "a", "b", "c"].map(id => ({ id, name: id, evidence: "edit-tool" }));
  const sweep = session("s", { activityAt: "2026-11-05T00:00:00Z", projects: many, status: { category: "completed", detail: "redesigned 25 sites", needsAction: "" } });
  assert.equal(leftOff(web, [older, sweep]).text, "old");
  assert.equal(leftOff(web, [sweep]).text, "redesigned 25 sites");
});

test("islands: the nearest folder with two sorted projects decides, and must mostly agree", () => {
  const islands = [{ id: "quest", name: "Human Quest" }, { id: "rts", name: "RTS AI" }, { id: "lab", name: "AI lab" }, { id: "uncategorized", name: "Uncategorized" }];
  const repos = [
    repo("q1", "quest", "hq/q1"), repo("q2", "quest", "hq/q2"), repo("q3", "quest", "hq/q3"), repo("g1", "rts", "hq/g1"),
    repo("r1", "rts", "hq/games/r1"), repo("r2", "rts", "hq/games/r2"),
    repo("l1", "lab", "a"), repo("x1", "quest", "b"), repo("y1", "rts", "c"),
    repo("new-quest", "uncategorized", "hq/new-quest"),
    repo("mod", "uncategorized", "hq/games/upstreams/mod"),
    repo("top", "uncategorized", "maze/top"),
    repo("cloud", "uncategorized", null),
    repo("kept", "uncategorized", "hq/kept", { organizationReviewed: true }),
    repo("gone", "uncategorized", "hq/gone", { hidden: true }),
  ];
  const groups = suggestIslands(repos, islands);
  assert.deepEqual(groups.map(g => [g.island, g.folder, g.agree, g.sorted, g.repos]), [
    ["quest", "hq", 3, 4, ["new-quest"]],
    ["rts", "hq/games", 2, 2, ["mod"]],
  ]);
  // A folder that disagrees stops the search: it does not climb past it to a folder that agrees.
  assert.deepEqual(suggestIslands([...repos, repo("q4", "rts", "hq/q4"), repo("q5", "rts", "hq/q5")], islands).map(g => g.island), ["rts"]);
});
