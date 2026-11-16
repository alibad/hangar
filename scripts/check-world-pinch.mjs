// Trackpad regression: real camera + trusted Chromium wheel input, and Safari's
// GestureEvent contract dispatched through the same DOM path. Fictional catalog only.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { styleFixture, interceptWorld } from "./world-style-fixture.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_CORE ? pathToFileURL(process.env.PLAYWRIGHT_CORE).href : "playwright-core");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
const url = process.env.HANGAR_URL || "http://127.0.0.1:8003", errors = [];
page.on("pageerror", error => errors.push(error.message));
await interceptWorld(page, styleFixture());
try {
  await page.goto(`${url}/#world`, { waitUntil: "domcontentloaded" });
  const element = page.locator('iframe[title^="Hangar project world"]'); await element.waitFor({ timeout: 60000 });
  const frame = await (await element.elementHandle()).contentFrame();
  await frame.waitForFunction(() => !!window.atlas, null, { timeout: 60000 });
  await page.getByRole("status", { name: "Map loading status" }).waitFor({ state: "hidden" });
  const radius = () => frame.evaluate(() => atlas.world.camera.position.distanceTo(atlas.world.controls.target));
  const pageView = () => page.evaluate(() => [visualViewport.scale, devicePixelRatio, innerWidth, scrollX, scrollY]);
  const beforeView = await pageView();
  await frame.evaluate(() => { window.pinchEvents = []; window.addEventListener("wheel", event => pinchEvents.push(event), true); });
  const canvasBox = await frame.locator("#scene").boundingBox();
  const session = await page.context().newCDPSession(page);
  const center = { x: canvasBox.x + canvasBox.width / 2, y: canvasBox.y + canvasBox.height / 2 };
  let before = await radius();
  await session.send("Input.dispatchMouseEvent", { type: "mouseWheel", ...center, modifiers: 2, deltaX: 0, deltaY: -24 });
  await frame.waitForFunction(r => atlas.world.camera.position.distanceTo(atlas.world.controls.target) < r * 0.995, before);
  let after = await radius(); assert.ok(after < before);
  await session.send("Input.dispatchMouseEvent", { type: "mouseWheel", ...center, modifiers: 2, deltaX: 0, deltaY: 24 });
  await frame.waitForFunction(r => atlas.world.camera.position.distanceTo(atlas.world.controls.target) > r * 1.005, after);
  assert.deepEqual(await pageView(), beforeView, "trusted pinch input must not zoom or scroll the page");
  assert.ok(await frame.evaluate(() => pinchEvents.filter(e => e.ctrlKey && e.isTrusted).length >= 2));
  assert.ok(await frame.evaluate(() => pinchEvents.filter(e => e.ctrlKey).every(e => e.defaultPrevented)));

  const wheel = (context, selector, deltaY, ctrlKey = true) => context.evaluate(({ selector, deltaY, ctrlKey }) => {
    const target = document.querySelector(selector), rect = target.getBoundingClientRect();
    const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey, deltaY, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 });
    target.dispatchEvent(event); return event.defaultPrevented;
  }, { selector, deltaY, ctrlKey });
  before = await radius(); assert.equal(await wheel(frame, ".district-label", -5), true);
  assert.ok(await radius() < before, "HTML labels must route pinches to the camera");
  before = await radius(); assert.equal(await wheel(page, ".cw-size-switch", -5), true);
  await frame.waitForFunction(r => atlas.world.camera.position.distanceTo(atlas.world.controls.target) < r, before);

  const gesture = (context, selector, type, scale) => context.evaluate(({ selector, type, scale }) => {
    const target = document.querySelector(selector), scene = document.querySelector("#scene"), rect = (scene || target).getBoundingClientRect();
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, { scale: { value: scale }, clientX: { value: rect.x + rect.width / 2 }, clientY: { value: rect.y + rect.height / 2 } });
    target.dispatchEvent(event); return event.defaultPrevented;
  }, { selector, type, scale });
  assert.equal(await gesture(frame, "#scene", "gesturestart", 1), true);
  before = await radius(); assert.equal(await gesture(frame, "#scene", "gesturechange", 1.2), true);
  after = await radius(); assert.ok(after < before);
  // Some browsers expose wheel events alongside native gestures. Consume that
  // second source without applying the same magnification twice.
  assert.equal(await wheel(frame, "#scene", -10), true); assert.equal(await radius(), after);
  assert.equal(await gesture(frame, "#scene", "gesturechange", 1.1), true);
  assert.ok(await radius() > after, "Safari's cumulative scale must use incremental ratios");
  assert.equal(await gesture(frame, "#scene", "gesturechange", 0), true);
  assert.ok(Number.isFinite(await radius()));
  assert.equal(await gesture(frame, "#scene", "gestureend", 1.1), true);
  assert.equal(await gesture(page, ".cw-size-switch", "gesturestart", 1), true);
  before = await radius(); assert.equal(await gesture(page, ".cw-size-switch", "gesturechange", 0.9), true);
  await frame.waitForFunction(r => atlas.world.camera.position.distanceTo(atlas.world.controls.target) > r, before);
  assert.equal(await gesture(page, ".cw-size-switch", "gestureend", 0.9), true);

  before = await radius(); assert.equal(await wheel(page, ".cw-topbar", -4), false);
  assert.equal(await wheel(page, ".cw-size-switch", -4, false), false, "ordinary wheel behavior above controls stays unchanged");
  assert.equal(await radius(), before);
  assert.deepEqual(await pageView(), beforeView);

  // Native listener cleanup prevents duplicate gestures when a surface remounts.
  const cleanup = await page.evaluate(async () => {
    const { bindWorldPinch } = await import("/api/world/local/view/js/world-pinch.js");
    const surface = document.createElement("div"); document.body.append(surface); let calls = 0;
    const off = bindWorldPinch(surface, () => calls++);
    const event = () => new WheelEvent("wheel", { ctrlKey: true, deltaY: 1, cancelable: true });
    const first = event(); surface.dispatchEvent(first); off(); const second = event(); surface.dispatchEvent(second); surface.remove();
    return { calls, before: first.defaultPrevented, after: second.defaultPrevented };
  });
  assert.deepEqual(cleanup, { calls: 1, before: true, after: false });

  // The standalone world has the same pinch behavior, even mid camera flight.
  const standalone = await browser.newPage({ viewport: { width: 1000, height: 700 }, reducedMotion: "reduce" });
  await interceptWorld(standalone, styleFixture());
  await standalone.goto(`${url}/api/world/local/view/index.html?embed=hangar&quality=low&night=0`);
  await standalone.waitForFunction(() => !!window.atlas);
  const flight = await standalone.evaluate(() => {
    atlas.select(atlas.doc.repos[0], { fly: true }); const disabled = !atlas.world.controls.enabled;
    const event = new WheelEvent("wheel", { ctrlKey: true, deltaY: -5, bubbles: true, cancelable: true, clientX: innerWidth / 2, clientY: innerHeight / 2 });
    document.getElementById("scene").dispatchEvent(event);
    return { disabled, enabled: atlas.world.controls.enabled, prevented: event.defaultPrevented };
  });
  assert.deepEqual(flight, { disabled: true, enabled: true, prevented: true });
  await standalone.close(); assert.deepEqual(errors, []);
  console.log("PASS: trusted trackpad zoom in/out, unchanged page scale, labels and parent controls, Safari gesture ratios/deduplication, outside-world behavior, listener cleanup and flight interruption. Native Safari hardware acceptance is separate.");
} finally { await browser.close(); }
