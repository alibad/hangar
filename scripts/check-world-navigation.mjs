import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT_CORE ? pathToFileURL(process.env.PLAYWRIGHT_CORE).href : "playwright-core");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = []; page.on("pageerror", e => errors.push(String(e)));
try {
  await page.goto(`${process.env.HANGAR_URL || "http://127.0.0.1:8003"}/#world`, { waitUntil: "domcontentloaded" });
  const element = page.locator('iframe[title^="Hangar project world"]');
  await element.waitFor({ timeout: 60000 });
  const frame = await (await element.elementHandle()).contentFrame();
  await frame.waitForFunction(() => !!window.atlas, { timeout: 60000 });
  await page.getByRole("button", { name: "Show all islands", exact: true }).click();
  const first = await frame.evaluate(() => ({ id: window.atlas.buildings[0].repo.id, name: window.atlas.buildings[0].repo.name, family: window.atlas.buildings[0].repo.family }));
  await page.locator('.cw-inspector input[type="search"]').fill(first.name);
  await frame.waitForFunction(id => window.atlas.buildings.some(b => b.repo.id !== id && b.target.dim >= 0.9), first.id);
  assert.equal(await page.locator('.cw-inspector input[type="search"]').inputValue(), first.name, "Home must not erase a newer search");
  await page.getByRole("button", { name: "Show all islands", exact: true }).click();
  await page.locator('.cw-island-picker button').nth(1).click();
  assert.ok(await page.locator('.cw-island-picker button[aria-pressed="true"]').count() === 1);
  await page.getByRole("button", { name: "Show all islands", exact: true }).click();
  await page.getByRole("button", { name: "Live work", exact: true }).click();
  // Presentation-only synthetic work; no API call, real agent or session mutation.
  await page.evaluate(id => document.querySelector('iframe[title^="Hangar project world"]').contentWindow.postMessage({ source: "hangar", type: "work", jobs: [{ id: "visual-fixture", repo: id, provider: "codex", state: "running" }] }, location.origin), first.id);
  await frame.waitForFunction(id => window.atlas.buildings.find(b => b.repo.id === id).target.glow === 1, first.id);
  assert.equal(await frame.locator('.district-label.has-work').count(), 1);
  await page.evaluate(() => document.querySelector('iframe[title^="Hangar project world"]').contentWindow.postMessage({ source: "hangar", type: "work", jobs: [] }, location.origin));
  await frame.waitForFunction(() => !document.querySelector('.district-label.has-work'));
  await page.getByRole("button", { name: "Expand world", exact: true }).click();
  assert.equal(await page.locator('.connected-workspace.is-expanded').count(), 1);
  await page.getByRole("button", { name: "Exit expanded world", exact: true }).click();
  await page.locator('.cw-lenses button').first().click();
  await page.locator('.cw-island-picker button').nth(1).click();
  await page.waitForTimeout(1800);
  await page.screenshot({ path: 'var/fleet-qa/final-focused-world.png', fullPage: true });
  await page.getByRole("button", { name: "Show all islands", exact: true }).click();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.waitForTimeout(1200);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    assert.equal(await page.locator('select:visible').count(), 0);
    await page.screenshot({ path: `var/fleet-qa/refined-world-${width}.png`, fullPage: true });
  }
  assert.deepEqual(errors, []);
  console.log("PASS: search dims the world, island focus/home, actual-job presentation, warm beacons, expanded stage, responsive layouts; no real session mutations.");
} finally { await browser.close(); }
