// Browser regression: all organization writes are intercepted, never persisted.
import { pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT_CORE ? pathToFileURL(process.env.PLAYWRIGHT_CORE).href : "playwright-core");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
const errors = []; page.on("pageerror", error => errors.push(error.message));
const doc = {
  generatedAt: "2026-01-01T00:00:00Z", apps: [], stats: { toCommit: 0, toPush: 0, toPull: 0, openPRs: 0 },
  families: [{ id: "studio", name: "Studio", repos: 2 }, { id: "tools", name: "Tools", repos: 1 }],
  repos: ["Alpha", "Beta", "Gamma"].map((name, index) => ({ id: name.toLowerCase(), name, family: index < 2 ? "studio" : "tools", stage: "tower", sizeKB: 20000, recency: "live", onMachine: false, notes: {}, meaning: {}, sites: [], risks: [], createdAt: "2025-01-01T00:00:00Z" })),
};
const catalog = () => ({ ...doc, islands: doc.families, families: doc.families.map(f => ({ ...f, repos: doc.repos.filter(r => r.family === f.id && !r.hidden).length })).filter(f => f.repos) });
let notes = 0;
await page.route("**/api/**", async route => {
  const path = new URL(route.request().url()).pathname;
  const reply = json => route.fulfill({ json });
  if (/\/proxy\/atlas$/.test(path)) return reply(catalog());
  if (/\/proxy\/status$/.test(path)) return reply({ scanning: false, generatedAt: doc.generatedAt });
  if (/\/proxy\/apps$/.test(path)) return reply({ apps: [] });
  if (/\/proxy\/work$/.test(path)) return reply({ jobs: [] });
  if (/\/proxy\/sessions\/library$/.test(path)) return reply({ sessions: [], groups: [], sections: [], providers: [] });
  if (/\/proxy\/notes$/.test(path) && route.request().method() === "POST") {
    const body = route.request().postDataJSON(); notes++;
    Object.assign(doc.repos.find(r => r.id === body.repo), body.fields);
    return reply({ ok: true });
  }
  // No unexpected mutation from a test may reach a real service.
  if (!["GET", "HEAD"].includes(route.request().method())) return reply({ ok: true });
  await route.continue();
});
try {
  await page.goto(`${process.env.HANGAR_URL || "http://127.0.0.1:8003"}/#world`, { waitUntil: "domcontentloaded" });
  const element = page.locator('iframe[title^="Hangar project world"]');
  await element.waitFor({ timeout: 60000 });
  const frame = await (await element.elementHandle()).contentFrame();
  await frame.waitForFunction(() => window.atlas?.buildings.every(b => b.onMap === true), null, { timeout: 60000 });
  const send = data => page.evaluate(data => document.querySelector('iframe[title^="Hangar project world"]').contentWindow.postMessage({ source: "hangar", ...data }, location.origin), data);
  const snapshot = () => frame.evaluate(() => ({
    camera: atlas.world.camera.position.toArray(), target: atlas.world.controls.target.toArray(),
    buildings: atlas.buildings.map(b => ({ id: b.repo.id, uuid: b.group.uuid, x: b.cell.x, z: b.cell.z, visible: b.group.visible })),
    islands: atlas.islands.map(i => ({ id: i.spot.id, uuid: i.group.uuid, terrain: i.rock.geometry.uuid, x: i.spot.x, z: i.spot.z, visible: i.group.visible })),
  }));
  await page.locator('.cw-project-row').filter({ hasText: "Alpha" }).click();
  await page.waitForTimeout(2000);
  const before = await snapshot();
  await page.getByRole("button", { name: "More actions for Alpha", exact: true }).click();
  await page.getByRole("menuitem", { name: "Off the map · not relevant…", exact: true }).click();
  await page.getByRole("button", { name: "Remove from world", exact: true }).click();
  await frame.waitForFunction(() => atlas.buildings.find(b => b.repo.id === "alpha").onMap === false);
  await page.waitForTimeout(500);
  const after = await snapshot();
  assert.equal(notes, 1);
  assert.deepEqual(after.camera, before.camera, "hide must not reset the camera");
  assert.deepEqual(after.target, before.target);
  assert.deepEqual(after.islands, before.islands, "islands and terrain must survive hide unchanged");
  assert.equal(after.buildings[0].uuid, before.buildings[0].uuid);
  assert.equal(after.buildings.find(b => b.id === "alpha").visible, false);
  await mkdir("var/world-update-qa", { recursive: true });
  await page.screenshot({ path: "var/world-update-qa/after-hide.png" });
  // A lens/night/replay update must never resurrect hidden buildings.
  await send({ type: "lens", lens: "activity" });
  await send({ type: "theme", night: true });
  await frame.evaluate(() => { atlas.setTime(Date.parse("2024-01-01")); atlas.setTime(null); });
  await page.waitForTimeout(500);
  assert.equal((await snapshot()).buildings.find(b => b.id === "alpha").visible, false);
  // Whole island hide, restore, rename, move, and discovery use the same live channel.
  doc.repos[1].hidden = true;
  await send({ type: "catalog", doc: catalog() });
  await frame.waitForFunction(() => !atlas.islands.find(i => i.spot.id === "studio").group.visible);
  doc.repos[0].hidden = doc.repos[1].hidden = false;
  doc.families[0].name = "Creative studio";
  await send({ type: "catalog", doc: catalog() });
  await frame.waitForFunction(() => atlas.islands.find(i => i.spot.id === "studio").group.visible);
  assert.deepEqual((await snapshot()).buildings.map(b => [b.id, b.uuid, b.x, b.z]), before.buildings.map(b => [b.id, b.uuid, b.x, b.z]));
  assert.equal(await frame.locator('.district-label[data-island="studio"] b').textContent(), "Creative studio");
  doc.families.push({ id: "new", name: "New category", repos: 1 }); doc.repos[0].family = "new";
  await send({ type: "catalog", doc: catalog() });
  await frame.waitForFunction(() => atlas.buildings.find(b => b.repo.id === "alpha").island.spot.id === "new");
  assert.equal((await snapshot()).buildings.find(b => b.id === "alpha").uuid, before.buildings.find(b => b.id === "alpha").uuid);
  doc.repos.push({ ...doc.repos[0], id: "delta", name: "Delta" });
  await send({ type: "catalog", doc: catalog() });
  await frame.waitForFunction(() => atlas.buildings.some(b => b.repo.id === "delta" && b.group.visible));
  const beforeScan = await snapshot();
  doc.repos.find(r => r.id === "delta").stage = "skyscraper";
  await send({ type: "catalog", doc: catalog() });
  await frame.waitForFunction(() => atlas.buildings.find(b => b.repo.id === "delta").height > 20);
  const afterScan = await snapshot();
  assert.notEqual(afterScan.buildings.find(b => b.id === "delta").uuid, beforeScan.buildings.find(b => b.id === "delta").uuid);
  assert.deepEqual(afterScan.buildings.filter(b => b.id !== "delta"), beforeScan.buildings.filter(b => b.id !== "delta"), "scan replaces only the changed building");
  await page.setViewportSize({ width: 900, height: 900 });
  await page.waitForTimeout(500);
  assert.deepEqual((await snapshot()).camera, before.camera, "pane/window resize must preserve viewpoint");
  assert.deepEqual(errors, []);
  console.log("PASS: actual hide UI retains iframe, terrain, buildings and camera; hide/restore island, lens/replay, rename, move, discovery, scan and resize. No real writes.");
} finally { await browser.close(); }
