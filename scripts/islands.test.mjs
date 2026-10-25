import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createIslandStore } from "../src/lib/islands.ts";
import { workspaceResponse } from "../src/lib/workspace-response.ts";

const document = () => ({ families: [{ id: "product", name: "Product", repos: 2 }], repos: [
  { id: "one", name: "First project", family: "product", sites: [{ role: "canonical" }], notes: { purpose: "Keep this" }, plan: "preserved" },
  { id: "two", name: "Individually hidden", family: "product", hidden: true },
] });

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "hangar-islands-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "islands.json");
  return { file, store: createIslandStore(file) };
}

test("create, assign, hide, restore persists without changing source projects", async t => {
  const { file, store } = await fixture(t);
  const doc = document(), before = structuredClone(doc);
  const { island } = await store.update(doc, { action: "create-island", name: "Useful work" });
  assert.equal((await store.apply(doc)).islands.find(f => f.id === island).repos, 0);
  await store.update(doc, { action: "assign-island", island, repos: ["one", "two"] });
  await store.update(doc, { action: "hide-island", island });
  let world = await createIslandStore(file).apply(doc);
  assert.equal(world.families.some(f => f.id === island), false);
  assert.equal(world.repos[0].hiddenByIsland, island);
  assert.equal(world.repos[1].hiddenByIsland, undefined);
  await store.update(doc, { action: "restore-island", island });
  world = await store.apply(doc);
  assert.equal(world.repos[0].family, island);
  assert.equal(Boolean(world.repos[0].hidden), false);
  assert.equal(world.repos[1].hidden, true);
  assert.equal(world.repos[0].notes.purpose, "Keep this");
  assert.equal(world.repos[0].plan, "preserved");
  assert.deepEqual(world.repos[0].sites, before.repos[0].sites);
  assert.deepEqual(doc, before);
  assert.equal(world.stats.hidden, 1);
});

test("existing scanner islands can be hidden and restored without a workspace endpoint", async t => {
  const { store } = await fixture(t), doc = document();
  await store.update(doc, { action: "hide-island", island: "product" });
  assert.equal((await store.apply(doc)).repos.every(r => r.hidden), true);
  await store.update(doc, { action: "restore-island", island: "product" });
  assert.equal(Boolean((await store.apply(doc)).repos[0].hidden), false);
  assert.equal((await store.apply(doc)).repos[1].hidden, true);
});

test("can restore an island previously hidden by the scanner", async t => {
  const { store } = await fixture(t), doc = document();
  doc.islands = [{ ...doc.families[0], hidden: true }]; doc.families = [];
  doc.repos[0].hidden = true; doc.repos[0].hiddenByIsland = "product";
  await store.update(doc, { action: "restore-island", island: "product" });
  const world = await store.apply(doc);
  assert.equal(world.repos[0].hidden, false);
  assert.equal(world.repos[1].hidden, true);
  assert.equal(world.families.length, 1);
});

test("invalid actions and mixed unknown project batches leave storage untouched", async t => {
  const { store, file } = await fixture(t), doc = document();
  const { island } = await store.update(doc, { action: "create-island", name: "Work" });
  const before = await readFile(file, "utf8");
  for (const body of [null, [], { action: "create-island", name: " work " }, { action: "create-island", name: " " },
    { action: "hide-island", island: "missing" }, { action: "assign-island", island, repos: ["one", "missing"] },
    { action: "delete-island", island }]) await assert.rejects(store.update(doc, body));
  assert.equal(await readFile(file, "utf8"), before);
});

test("concurrent creations do not lose updates, duplicate names are rejected", async t => {
  const { store } = await fixture(t), doc = document();
  const results = await Promise.allSettled(["Build", "Research", "Build"].map(name => store.update(doc, { action: "create-island", name })));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 2);
  assert.equal((await store.apply(doc)).islands.length, 3);
});

test("corrupt preferences are preserved, not silently replaced", async t => {
  const { store, file } = await fixture(t);
  await writeFile(file, "broken");
  await assert.rejects(store.update(document(), { action: "create-island", name: "New" }), /left intact/);
  assert.equal(await readFile(file, "utf8"), "broken");
});

test("resetting a custom assignment restores source grouping", async t => {
  const { store } = await fixture(t), doc = document();
  const { island } = await store.update(doc, { action: "create-island", name: "Build" });
  await store.update(doc, { action: "assign-island", island, repos: ["one"] });
  await store.update(doc, { action: "reset-assignment", repo: "one" });
  assert.equal((await store.apply(doc)).repos[0].family, "product");
});

test("review progress persists without moving projects or hiding them", async t => {
  const { store, file } = await fixture(t), doc = document();
  await store.update(doc, { action: "review-projects", repos: ["one"] });
  const world = await createIslandStore(file).apply(doc);
  assert.equal(world.repos[0].organizationReviewed, true);
  assert.equal(world.repos[1].organizationReviewed, false);
  assert.equal(world.repos[0].family, "product");
  assert.equal(world.repos[1].hidden, true);
  const before = await readFile(file, "utf8");
  await assert.rejects(store.update(doc, { action: "review-projects", repos: ["one", "missing"] }));
  assert.equal(await readFile(file, "utf8"), before);
});

test("workspace errors are actionable for text, HTML, malformed JSON and HTTP failures", async () => {
  await assert.rejects(workspaceResponse(new Response("not found", { status: 404 })), /does not support/);
  await assert.rejects(workspaceResponse(new Response("<html>gateway</html>", { status: 502 })), /502/);
  await assert.rejects(workspaceResponse(new Response("not found")), /unreadable response/);
  await assert.rejects(workspaceResponse(Response.json({ error: "Reconnect this machine" }, { status: 503 })), /Reconnect this machine/);
  assert.deepEqual(await workspaceResponse(Response.json({ islands: [] })), { islands: [] });
});

test("legacy age, origin and status buckets become uncategorized without hiding local code", async t => {
  const { store } = await fixture(t);
  const ids = ["attic", "workshop", "borrowed", "vendor", "offmap", "parked", "focus"];
  const doc = { families: ids.map(id => ({ id, name: id, repos: 1 })), repos: ids.map(id => ({ id, family: id, hidden: false, attention: id === "parked" ? "parked" : null })) };
  const world = await store.apply(doc);
  assert.deepEqual(world.families.map(f => f.id), ["uncategorized"]);
  assert.equal(world.families[0].repos, ids.length);
  assert.ok(world.repos.every(r => r.family === "uncategorized" && !r.hidden));
  assert.equal(world.repos.find(r => r.id === "parked").attention, "parked");
});

test("bulk visibility and status preserve category, files and each other across reloads", async t => {
  const { store, file } = await fixture(t), doc = document();
  const { island } = await store.update(doc, { action: "create-island", name: "Research" });
  await store.update(doc, { action: "assign-island", island, repos: ["one"] });
  await store.update(doc, { action: "set-project-state", repos: ["one"], attention: "parked" });
  await store.update(doc, { action: "set-project-state", repos: ["one"], hidden: true });
  let world = await createIslandStore(file).apply(doc);
  assert.equal(world.repos[0].family, island);
  assert.equal(world.repos[0].attention, "parked");
  assert.equal(world.repos[0].hidden, true);
  assert.equal(world.families.some(f => f.id === island), false);
  assert.deepEqual(world.repos[0].sites, doc.repos[0].sites);
  await store.update(doc, { action: "set-project-state", repos: ["one"], hidden: false });
  world = await store.apply(doc);
  assert.equal(world.repos[0].family, island);
  assert.equal(world.repos[0].attention, "parked");
  assert.equal(world.families.find(f => f.id === island).repos, 1);
  assert.equal(world.repos[1].hidden, true);
});

test("retiring a hidden legacy island does not make its projects visible again", async t => {
  const { store, file } = await fixture(t);
  const doc = { families: [], islands: [{ id: "attic", name: "Attic", hidden: true, repos: 1 }], repos: [{ id: "old", family: "attic", hidden: true, hiddenByIsland: "attic" }] };
  let world = await store.apply(doc);
  assert.equal(world.repos[0].hidden, true);
  assert.equal(world.repos[0].family, "uncategorized");
  assert.equal(world.repos[0].hiddenByIsland, undefined);
  assert.equal(world.families.length, 0);
  await store.update(doc, { action: "set-project-state", repos: ["old"], hidden: false });
  world = await createIslandStore(file).apply(doc);
  assert.equal(world.repos[0].hidden, false);
  assert.equal(world.families[0].id, "uncategorized");
});

test("hidden island cannot be bypassed and invalid batches are atomic", async t => {
  const { store, file } = await fixture(t), doc = document();
  await store.update(doc, { action: "hide-island", island: "product" });
  const before = await readFile(file, "utf8");
  for (const body of [
    { action: "set-project-state", repos: ["one"], hidden: false },
    { action: "set-project-state", repos: ["one", "unknown"], hidden: true },
    { action: "set-project-state", repos: ["one"], attention: "attic" },
    { action: "set-project-state", repos: ["one"], hidden: "true" },
  ]) await assert.rejects(store.update(doc, body));
  assert.equal(await readFile(file, "utf8"), before);
});
