// Isolated browser scenarios: synthetic catalogs and no service writes.
import { pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT_CORE ? pathToFileURL(process.env.PLAYWRIGHT_CORE).href : "playwright-core");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const url = process.env.HANGAR_URL || "http://127.0.0.1:8003";
const doc = { generatedAt: "2026-01-01T00:00:00Z", apps: [], stats: { toCommit: 0, toPush: 0, toPull: 0, openPRs: 0 }, families: [{ id: "studio", name: "Studio", repos: 1 }], repos: [{ id: "alpha", name: "Alpha", family: "studio", stage: "tower", sizeKB: 20000, recency: "live", onMachine: false, notes: {}, meaning: {}, sites: [], risks: [] }] };
async function fixture() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (!["GET", "HEAD"].includes(route.request().method())) return route.fulfill({ json: { ok: true } });
    if (/\/proxy\/atlas$/.test(path)) return route.fulfill({ json: doc });
    if (/\/proxy\/status$/.test(path)) return route.fulfill({ json: { scanning: false, generatedAt: doc.generatedAt } });
    if (/\/proxy\/apps$/.test(path)) return route.fulfill({ json: { apps: [] } });
    if (/\/proxy\/work$/.test(path)) return route.fulfill({ json: { jobs: [] } });
    if (/\/proxy\/sessions\/library$/.test(path)) return route.fulfill({ json: { sessions: [], groups: [], sections: [], providers: [] } });
    return route.continue();
  });
  return page;
}
const world = page => page.locator('iframe[title^="Hangar project world"]');
const status = page => page.getByRole("status", { name: "Map loading status" });
try {
  // Simulate the host missing the viewer's original ready event.
  const missed = await fixture();
  await missed.addInitScript(() => {
    window.addEventListener("message", event => {
      if (window === top && event.data?.source === "atlas" && event.data.type === "ready" && !window.droppedReady) {
        window.droppedReady = true; event.stopImmediatePropagation();
      }
    }, true);
  });
  let navigations = 0;
  missed.on("framenavigated", frame => { if (frame.url().includes("/view/index.html")) navigations++; });
  await missed.goto(`${url}/#world`);
  await world(missed).waitFor({ timeout: 60000 });
  await missed.waitForFunction(() => window.droppedReady);
  await status(missed).waitFor({ state: "hidden", timeout: 10000 });
  assert.equal(navigations, 1, "lost ready event recovers without reloading the viewer");
  await missed.close();

  const delayed = await fixture();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await delayed.route("**/view/js/main.js", async route => { await gate; await route.continue(); });
  await delayed.goto(`${url}/#world`, { waitUntil: "domcontentloaded" });
  await world(delayed).waitFor({ timeout: 60000 });
  await status(delayed).getByText("Still loading the map…", { exact: true }).waitFor({ timeout: 25000 });
  assert.equal(await delayed.getByText("Map unavailable", { exact: true }).count(), 0, "delay is not an error");
  const box = await status(delayed).boundingBox();
  assert.ok(box.width <= 420 && box.height < 160, "slow loading notice must stay compact");
  assert.equal(await status(delayed).locator("img").count(), 0);
  assert.ok(await delayed.getByRole("combobox", { name: "Find a project", exact: true }).isEnabled());
  const frame = await (await world(delayed).elementHandle()).contentFrame();
  assert.equal(await frame.locator("#loading").isVisible(), false, "embedded viewer must not put another splash over the map");
  await mkdir("var/world-loading-qa", { recursive: true });
  await delayed.screenshot({ path: "var/world-loading-qa/slow-desktop.png" });
  if (await delayed.getByRole("button", { name: "Switch to light mode", exact: true }).count()) await delayed.getByRole("button", { name: "Switch to light mode", exact: true }).click();
  await delayed.setViewportSize({ width: 390, height: 844 });
  await delayed.waitForFunction(() => document.querySelector('.cw-world-status')?.getBoundingClientRect().width > 200);
  const narrow = await status(delayed).boundingBox();
  await delayed.screenshot({ path: "var/world-loading-qa/slow-mobile-light.png", fullPage: true });
  assert.ok(narrow.width < 350 && narrow.height < 180, JSON.stringify(narrow));
  assert.ok(await delayed.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  release();
  await status(delayed).waitFor({ state: "hidden", timeout: 15000 });
  await delayed.close();

  const broken = await fixture();
  let imports = 0;
  await broken.route("**/view/js/main.js", route => ++imports === 1 ? route.abort("failed") : route.continue());
  await broken.goto(`${url}/#world`);
  await status(broken).getByText("Map unavailable", { exact: true }).waitFor({ timeout: 15000 });
  await status(broken).getByText("Details", { exact: true }).click();
  assert.match(await status(broken).textContent(), /module|fetch|import/i);
  await status(broken).getByRole("button", { name: "Retry map", exact: true }).click();
  await status(broken).waitFor({ state: "hidden", timeout: 15000 });
  assert.equal(imports, 2);
  await broken.close();
  console.log("PASS: lost-ready recovery without reload; delayed boot stays compact and usable at desktop/mobile widths; module failures report immediately and retry recovers. No real writes.");
} finally { await browser.close(); }
