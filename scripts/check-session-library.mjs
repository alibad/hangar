import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT_CORE ? pathToFileURL(process.env.PLAYWRIGHT_CORE).href : "playwright-core");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const fixture = process.env.SESSION_FIXTURE_URL || "http://127.0.0.1:7791";
const base = process.env.HANGAR_URL || "http://127.0.0.1:8004";
const errors = [];
page.on("pageerror", e => errors.push(String(e)));
try {
  // The real React view talks to Atlas's real HTTP handler and persistence in a
  // disposable fixture process. Native mutations update only fixture records.
  await page.route("**/api/world/local/proxy/sessions/library", async route => {
    const request = route.request();
    const result = await fetch(`${fixture}/api/sessions/library`, { method: request.method(),
      headers: { "Content-Type": "application/json", "X-Hangar": "1" }, body: request.postData() || undefined });
    await route.fulfill({ status: result.status, contentType: "application/json", body: await result.text() });
  });
  await page.goto(`${base}/#sessions`, { waitUntil: "domcontentloaded", timeout: 90000 });
  const library = page.getByRole("region", { name: "Session organization" });
  await library.getByRole("button", { name: "Review idle sessions" }).waitFor({ timeout: 90000 });
  await library.getByRole("button", { name: "Review idle sessions" }).click();
  await page.waitForFunction(() => document.querySelectorAll('.sl-session').length === 3);
  assert.match(await page.locator('.sl-session').first().innerText(), /fixture-unread/);
  assert.equal(await page.getByText("fixture-pin", { exact: true }).count(), 0);
  assert.equal(await page.getByText("fixture-running", { exact: true }).count(), 0);
  const unread = page.locator('.sl-session').filter({ hasText: 'fixture-unread' });
  await unread.getByRole('button', { name: 'Review archive', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByText('Codex marks this session unread.', { exact: false }).waitFor();
  await dialog.getByRole('button', { name: 'Archive in Codex too', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await library.getByRole('button', { name: 'Archived', exact: true }).click();
  await page.getByRole('button', { name: 'Restore in Codex', exact: true }).click();
  await library.getByText('Session restored;', { exact: false }).waitFor();
  await library.getByRole('button', { name: 'Active', exact: true }).click();
  const claude = page.locator('.sl-session').filter({ hasText: 'Read state unknown' }).filter({ hasText: '9d idle' });
  await claude.getByRole('button', { name: 'Accept group', exact: true }).click();
  await library.getByText('Grouped in Hangar.', { exact: false }).waitFor();
  await library.getByRole('button', { name: 'Groups & sections', exact: true }).click();
  assert.match(await page.locator('.sl-group').filter({ has: page.getByRole('heading', { name: 'Work', exact: true }) }).innerText(), /1 Claude/);
  await library.getByRole('textbox', { name: 'New group name' }).fill('Focus together');
  await library.getByRole('button', { name: 'Create group', exact: true }).click();
  await page.getByRole('heading', { name: 'Focus together', exact: true }).waitFor();
  await library.getByRole('button', { name: 'Active', exact: true }).click();
  const read = page.locator('.sl-session').filter({ hasText: 'fixture-read' });
  await read.getByRole('button', { name: 'Organize', exact: true }).click();
  await dialog.getByRole('radio', { name: 'Later Codex section', exact: true }).check();
  await dialog.getByRole('button', { name: 'Move in Codex too', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.match(await read.innerText(), /Later/);
  await read.getByRole('button', { name: 'Review archive', exact: true }).click();
  await dialog.getByRole('button', { name: 'Archive in Hangar', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await library.getByRole('button', { name: 'Archived', exact: true }).click();
  await page.getByRole('button', { name: 'Restore in Hangar', exact: true }).click();
  await library.getByText('Session restored;', { exact: false }).waitFor();
  await library.getByRole('button', { name: 'Review idle sessions' }).click();
  await page.getByRole('button', { name: 'Keep for 7 days', exact: true }).click();
  await page.getByRole('heading', { name: 'Nothing needs an archive decision.' }).waitFor();
  await library.getByRole('button', { name: '30d', exact: true }).click();
  await library.getByText('Review threshold set to 30 days.').waitFor();
  await library.getByRole('button', { name: 'Groups & sections', exact: true }).click();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `groups overflow at ${width}`);
    await library.getByRole('button', { name: 'Active', exact: true }).click();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `sessions overflow at ${width}`);
    await page.locator('.sl-session').filter({ hasText: 'fixture-read' }).getByRole('button', { name: 'Organize', exact: true }).click();
    await dialog.getByRole('radio', { name: 'Later Codex section', exact: true }).waitFor();
    assert.equal(await page.locator('select:visible').count(), 0);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `dialog overflow at ${width}`);
    await page.keyboard.press('Escape');
    await library.getByRole('button', { name: 'Groups & sections', exact: true }).click();
  }
  assert.deepEqual(errors, []);
  console.log('PASS: unread-first review, protection, native/archive restore, mixed-agent groups, suggestions, native section move, snooze, threshold, keyboard dialog and 320/390/1440 layouts. All writes stayed in the fixture.');
} finally { await browser.close(); }
