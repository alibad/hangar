import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const scratch = await mkdtemp(path.join(tmpdir(), "hangar-products-test-"));
const source = await readFile(new URL("../src/lib/products-build.ts", import.meta.url), "utf8");
await writeFile(path.join(scratch, "products-build.mjs"), ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
const { buildProducts, primaryDomain, prettyName } = await import(pathToFileURL(path.join(scratch, "products-build.mjs")));
test.after(() => rm(scratch, { recursive: true, force: true }));

const NOW = Date.parse("2026-11-08T12:00:00Z");
const daysAgo = (n) => new Date(NOW - n * 86_400_000).toISOString();
const issue = (repo, n, days, open = true, labels = ["feedback"]) => ({ repo, number: n, title: `Report ${n}`, url: `https://github.com/${repo}/issues/${n}`, at: daysAgo(days), open, labels });
const project = (id, name, repo, domains, releasedDaysAgo = 3, state = "ready") => ({ id, name, repo, domains, production: { at: daysAgo(releasedDaysAgo), state, message: "Ship it" } });
const repo = (full, recent, extra = {}) => ({ repo: full, public: false, hasFeedback: true, open: recent.filter((i) => i.open).length, total: recent.length, recent, ...extra });
const config = (products = {}, extra = {}) => ({ vercelScope: "team", githubOwner: "me", sharedInbox: "me/inbox", hide: [], products, ...extra });
const base = { failures: [], releases: [], repos: [], properties: [], now: NOW };

test("primaryDomain prefers a custom domain without www", () => {
  assert.equal(primaryDomain(["www.coldclub.com", "coldclub.com", "cold-club.vercel.app"]), "coldclub.com");
  assert.equal(primaryDomain(["present.coldclub.com", "cc.vercel.app"]), "present.coldclub.com");
  assert.equal(primaryDomain(["only-this.vercel.app"]), "only-this.vercel.app");
  assert.equal(primaryDomain([]), null);
});

test("prettyName keeps names that are already cased", () => {
  assert.equal(prettyName("cold-club-web"), "Cold Club Web");
  assert.equal(prettyName("app:qatar-atlas"), "Qatar Atlas");
  assert.equal(prettyName("RTSAI-Web"), "RTSAI Web");
});

test("a configured product joins its sites and repositories, in the config's order", () => {
  const out = buildProducts({
    ...base,
    config: config({ rtsai: { name: "RTS AI", vercel: ["rtsai-web", "rtsai-play"], repos: ["RTSAI-Mod"] } }),
    projects: [project("p2", "rtsai-play", "me/RTSAI-WebGame", ["rtsai-play.vercel.app"]), project("p1", "rtsai-web", "me/RTSAI-Web", ["rtsai.net", "www.rtsai.net"])],
    repos: [repo("me/RTSAI-Web", [issue("me/RTSAI-Web", 1, 2)]), repo("me/RTSAI-Mod", [issue("me/RTSAI-Mod", 9, 20, false)])],
  });
  assert.equal(out.products.length, 1);
  const [p] = out.products;
  assert.equal(p.name, "RTS AI");
  assert.equal(p.domain, "rtsai.net");
  assert.deepEqual(p.sites.map((s) => s.project), ["rtsai-web", "rtsai-play"]);
  assert.deepEqual(p.repos.sort(), ["me/RTSAI-Mod", "me/RTSAI-Web", "me/RTSAI-WebGame"]);
  assert.equal(p.feedback.week, 1);
  assert.equal(p.feedback.open, 1);
  assert.equal(p.feedback.total, 2);
  assert.deepEqual(p.feedback.where.map((w) => [w.repo, w.open, w.total]), [["me/RTSAI-Web", 1, 1], ["me/RTSAI-Mod", 0, 1]]);
});

test("unlisted Vercel projects and feedback repositories become products of their own", () => {
  const out = buildProducts({
    ...base,
    config: config(),
    projects: [project("p1", "polytyper", "me/polytyper", ["polytyper.com"])],
    repos: [repo("me/ColdClubApp", [issue("me/ColdClubApp", 1, 1)]), repo("me/polytyper", [], { hasFeedback: false })],
  });
  assert.deepEqual(out.products.map((p) => p.id).sort(), ["coldclubapp", "polytyper"]);
  const poly = out.products.find((p) => p.id === "polytyper");
  assert.deepEqual(poly.feedback.where, [], "no feedback label means no feedback button sends there");
});

test("the shared inbox is split by app: label, never shown as a product itself", () => {
  const out = buildProducts({
    ...base,
    config: config({ atlas: { name: "Qatar Atlas", vercel: ["qatar-atlas"], feedbackLabel: "app:qatar-atlas" } }),
    projects: [project("p1", "qatar-atlas", "me/qatar-atlas", ["qatar.humanquest.net"])],
    repos: [repo("me/inbox", [issue("me/inbox", 1, 1), issue("me/inbox", 2, 3)], {
      byLabel: {
        "app:qatar-atlas": { open: 1, total: 1, recent: [issue("me/inbox", 1, 1, true, ["feedback", "app:qatar-atlas"])] },
        "app:rtsai": { open: 1, total: 1, recent: [issue("me/inbox", 2, 3, true, ["feedback", "app:rtsai"])] },
      },
    })],
  });
  assert.ok(!out.products.some((p) => p.id === "inbox"));
  const atlas = out.products.find((p) => p.id === "atlas");
  assert.equal(atlas.feedback.week, 1);
  assert.deepEqual(atlas.feedback.where, [{ repo: "me/inbox", label: "app:qatar-atlas", open: 1, total: 1, public: false }]);
  assert.ok(out.products.some((p) => p.id === "rtsai" && p.feedback.week === 1), "a label no product claims still shows up");
  assert.equal(out.inbox.length, 2);
});

test("failures sort first, public feedback repositories are flagged, old silent products are quiet", () => {
  const out = buildProducts({
    ...base,
    config: config({}, { hide: ["junk"] }),
    projects: [
      project("a", "calm-site", "me/calm", ["calm.app"], 2),
      project("b", "broken-site", "me/broken", ["broken.app"], 9),
      project("c", "old-site", "me/old", ["old.app"], 90),
      project("d", "junk", null, ["junk.vercel.app"], 1),
    ],
    failures: [{ projectId: "b", at: daysAgo(1), state: "error", target: "production" }],
    releases: [{ projectId: "a", at: daysAgo(2), state: "ready", target: "production" }],
    repos: [repo("me/calm", [], { public: true, open: 0, total: 0 })],
  });
  assert.deepEqual(out.products.map((p) => p.id), ["broken-site", "calm-site", "old-site"]);
  assert.equal(out.products[0].releases.failed, 1);
  assert.equal(out.products[0].releases.lastFailure.project, "broken-site");
  assert.deepEqual(out.products[1].publicRepos, ["me/calm"]);
  assert.equal(out.products[1].releases.week, 1);
  assert.equal(out.products[2].quiet, true);
  assert.equal(out.totals.failedWeek, 1);
});

test("Analytics properties join by their web stream's domain or by id, and weeks are summed", () => {
  const out = buildProducts({
    ...base,
    config: config({ cold: { name: "Cold Club", vercel: ["cold-club-web"], ga4: ["999"] } }),
    projects: [project("p1", "cold-club-web", "me/cold_club_web", ["www.coldclub.com", "coldclub.com"])],
    properties: [
      { id: "111", name: "coldclub.com", hosts: ["coldclub.com"], week: 120, previous: 100 },
      { id: "999", name: "Cold Club app", hosts: [], week: 30, previous: 50 },
      { id: "222", name: "Someone else", hosts: ["else.com"], week: 5, previous: 5 },
    ],
  });
  const [p] = out.products;
  assert.equal(p.usage.week, 150);
  assert.equal(p.usage.previous, 150);
  assert.deepEqual(p.usage.properties.map((x) => x.id).sort(), ["111", "999"]);
  assert.equal(out.totals.usersWeek, 150);
});

test("without Analytics the people numbers stay unknown, not zero", () => {
  const out = buildProducts({ ...base, config: config(), projects: [project("p1", "site", "me/site", ["site.com"])] });
  assert.equal(out.products[0].usage.week, null);
  assert.equal(out.totals.usersWeek, null);
});
