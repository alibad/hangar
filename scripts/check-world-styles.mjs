// End-to-end worlds: real chooser + renderer, synthetic catalog, no service writes.
import { pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
import { WORLD_STYLES } from "../engine/world/js/world-styles.js";
import { styleFixture, interceptWorld } from "./world-style-fixture.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_CORE ? pathToFileURL(process.env.PLAYWRIGHT_CORE).href : "playwright-core");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
const errors = []; page.on("pageerror", error => errors.push(error.message));
page.on("console", message => { if (message.type() === "error") console.error("console:", message.text()); });
const doc = styleFixture();
doc.repos.find(repo => repo.id === "halo").commitCount = null;
const work = { jobs: [] };
await interceptWorld(page, doc, work);
const url = process.env.HANGAR_URL || "http://127.0.0.1:8003";
try {
  await page.goto(`${url}/#world`, { waitUntil: "domcontentloaded" });
  console.log("Host loaded");
  const element = page.locator('iframe[title^="Hangar project world"]');
  await element.waitFor({ timeout: 60000 });
  const frame = await (await element.elementHandle()).contentFrame();
  await frame.waitForFunction(() => !!window.atlas && atlas.buildings.every(b => b.onMap !== false), null, { timeout: 60000, polling: 150 });
  await page.getByRole("status", { name: "Map loading status" }).waitFor({ state: "hidden" });
  console.log("Viewer ready");
  await frame.evaluate(() => atlas.select(atlas.doc.repos.find(repo => repo.id === "halo"), { fly: true }));
  await page.getByText(/^Commit count unavailable/).waitFor();
  await page.getByRole("button", { name: "MB", exact: true }).click();
  await page.getByText("34.18 MB", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Commits", exact: true }).click();
  await page.getByText(/^Commit count unavailable/).waitFor();
  await frame.evaluate(() => atlas.select(atlas.doc.repos[0], { fly: true }));
  await page.waitForTimeout(800);
  const canonical = () => frame.evaluate(() => atlas.buildings.map(b => [b.repo.id, b.cell.x, b.cell.z]));
  const before = await canonical();
  const trigger = page.getByRole("button", { name: /^World style:/ });
  const dialog = page.getByRole("dialog", { name: "View as" });
  const layouts = new Set();
  for (const style of WORLD_STYLES) {
    await trigger.click(); await dialog.waitFor();
    assert.equal(await dialog.getByRole("button", { name: /^Explore / }).count(), 0);
    await dialog.getByRole("button", { name: new RegExp(`^${style.name} `) }).click();
    await dialog.waitFor({ state: "hidden" });
    await frame.waitForFunction(id => atlas.style === id && atlas.buildings.every(b => b.style === id), style.id);
    await frame.waitForFunction(() => atlas.world.controls.enabled, null, { polling: 100 });
    assert.deepEqual(await canonical(), before, `${style.id}: visualization must not reorganize projects`);
    assert.equal(await frame.locator(".selected-tag").textContent(), "Aurora");
    assert.ok(await frame.evaluate(() => {
      const b = atlas.buildings.find(item => item.repo.id === "aurora");
      const center = b.group.localToWorld(b.modelBounds.getCenter(new atlas.world.THREE.Vector3())).project(atlas.world.camera);
      return Math.abs(center.x) < .35 && Math.abs(center.y) < .35;
    }), `${style.id}: the selected subject stays in focus`);
    const info = await frame.evaluate(() => ({
      positions: atlas.buildings.map(b => [b.repo.id, ...b.group.position.toArray()]),
      valid: atlas.buildings.every(b => b.pickables.every(m => m.matrixWorld.elements.every(Number.isFinite)) && (!b.marker || b.marker.position.y > b.height)),
      terrain: atlas.islands.some(i => i.rock.visible || i.plots.visible),
      environment: atlas.environment.name,
      aircraft: atlas.buildings.every(b => b.pickables[0].geometry.type === "LatheGeometry"),
      orbit: atlas.world.controls.mouseButtons.LEFT === atlas.world.THREE.MOUSE.ROTATE,
      touchOrbit: atlas.world.controls.touches.ONE === atlas.world.THREE.TOUCH.ROTATE,
    }));
    assert.ok(info.valid); assert.equal(info.terrain, style.id === "buildings");
    if (style.id === "airplanes") assert.ok(info.aircraft, "the fuselage must remain the aircraft's primary pickable");
    const spatial = ["galaxy", "fleet", "constellation", "neural"].includes(style.id);
    assert.equal(info.orbit, spatial); assert.equal(info.touchOrbit, spatial);
    assert.equal(info.environment, `environment:${style.id}`);
    layouts.add(JSON.stringify(info.positions));
    assert.ok(await trigger.evaluate(el => el === document.activeElement), "one-click choice returns focus to the view button");
    console.log(`PASS one-click view: ${style.id}`);
  }
  assert.equal(layouts.size, 12, "worlds must have distinct spatial arrangements");
  // A filter, arrival replay, and active work survive a form change.
  const send = data => page.evaluate(data => document.querySelector('iframe[title^="Hangar project world"]').contentWindow.postMessage({ source: "hangar", ...data }, location.origin), data);
  await send({ type: "filter", repos: ["aurora"] });
  work.jobs = [{ id: "fixture", repo: "aurora", provider: "codex", state: "running" }];
  await send({ type: "work", jobs: work.jobs });
  await send({ type: "style", style: "forest" });
  await frame.waitForFunction(() => atlas.style === "forest" && atlas.buildings.find(b => b.repo.id === "bloom").target.dim >= 0.9);
  assert.equal(await frame.locator(".work-mark").textContent(), "Codex · working");
  console.log("PASS working badge and filter survive a style change");
  await frame.evaluate(() => { atlas.setTime(Date.parse("2024-01-01")); atlas.setStyle("reef"); });
  await frame.waitForFunction(() => atlas.buildings.every(b => !b.group.visible));
  await frame.evaluate(() => atlas.setTime(null));
  await frame.waitForFunction(() => atlas.buildings.every(b => b.group.visible));
  // Catalog refresh/hide must rebuild the right scenery without resurrecting a project.
  const fresh = structuredClone(doc); fresh.repos[1].hidden = true;
  await send({ type: "catalog", doc: fresh });
  await send({ type: "style", style: "galaxy" });
  await frame.waitForFunction(() => atlas.style === "galaxy" && !atlas.buildings.find(b => b.repo.id === "bloom").group.visible);
  await send({ type: "catalog", doc });
  await send({ type: "filter", repos: null });
  work.jobs = [];
  await send({ type: "work", jobs: work.jobs });
  // Pointer selection uses the form's real meshes in every new world.
  for (const style of WORLD_STYLES.slice(1)) {
    await frame.evaluate(id => { atlas.setStyle(id); atlas.deselect(); atlas.select(atlas.doc.repos[4], { fly: true }); }, style.id);
    await frame.waitForFunction(() => atlas.world.controls.enabled, null, { polling: 100 });
    await frame.evaluate(() => atlas.deselect());
    const point = await frame.evaluate(() => {
      const b = atlas.buildings.find(b => b.repo.id === "ember"), mesh = b.pickables[0];
      const point = new atlas.world.THREE.Vector3();
      // The graph's branches can put the batched mesh's bounding center in
      // empty space. Click the rendered core of a graph node.
      const p = ["constellation", "neural"].includes(atlas.style)
        ? b.group.localToWorld(point.set(0, 1, 0))
        : mesh.localToWorld(mesh.geometry.boundingBox.getCenter(point));
      p.project(atlas.world.camera);
      return { x: (p.x + 1) / 2 * innerWidth, y: (-p.y + 1) / 2 * innerHeight };
    });
    const rect = await element.boundingBox();
    await page.mouse.click(rect.x + point.x, rect.y + point.y);
    await frame.waitForFunction(() => location.hash.includes("repo=ember"), null, { polling: 100 });
    console.log(`PASS pointer selection: ${style.id}`);
  }
  await mkdir("var/world-style-qa", { recursive: true });
  await page.getByRole("button", { name: "Close project pane", exact: true }).click();
  await page.getByRole("button", { name: "Close project pane", exact: true }).waitFor({ state: "hidden" });
  await frame.waitForFunction(() => !location.hash.includes("repo="));
  // The dialog must stay inside the viewport with all styles reachable at desktop and phone sizes.
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    await trigger.click();
    await dialog.waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    assert.equal(await dialog.locator("footer").count(), 0, "choosing a world should not require a second action");
    const bounds = await dialog.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.width <= width && bounds.y + bounds.height <= (width === 1440 ? 1000 : 844));
    await dialog.getByRole("button", { name: /^Museum / }).scrollIntoViewIfNeeded();
    assert.ok(await dialog.getByRole("button", { name: /^Museum / }).isVisible());
    await dialog.locator(".world-style-grid").evaluate(el => el.scrollTop = 0);
    await page.screenshot({ path: `var/world-style-qa/chooser-${width}.png` });
    await page.keyboard.press("Escape");
    await page.screenshot({ path: `var/world-style-qa/world-${width}.png` });
  }
  // Persist the selected style across a fresh viewer and host load.
  assert.equal(await frame.evaluate(() => atlas.style), "museum");
  assert.equal(await page.evaluate(() => localStorage.getItem("bt-world-style")), "museum");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "World style: Museum" }).waitFor({ timeout: 60000 });
  const restored = await (await element.elementHandle()).contentFrame();
  await restored.waitForFunction(() => window.atlas?.style === "museum", null, { timeout: 60000, polling: 150 });
  assert.ok(await restored.evaluate(() => atlas.world.scene.fog.far > atlas.world.camera.position.distanceTo(atlas.world.controls.target) + atlas.composition.extent), "mobile whole-view framing must remain inside the visible fog range");
  const standalone = await browser.newPage({ viewport: { width: 1000, height: 700 }, reducedMotion: "reduce" });
  await interceptWorld(standalone, doc);
  await standalone.goto(`${url}/api/world/local/view/index.html?style=forest&quality=low&night=0`);
  await standalone.waitForFunction(() => window.atlas?.style === "forest");
  const selector = standalone.getByRole("combobox", { name: "World style" });
  const allModelsFit = () => standalone.evaluate(() => {
    const { THREE, camera } = atlas.world;
    camera.updateMatrixWorld();
    return atlas.buildings.every(b => {
      const { min, max } = b.modelBounds;
      return [min.x, max.x].every(x => [min.y, max.y].every(y => [min.z, max.z].every(z => {
        const p = b.group.localToWorld(new THREE.Vector3(x, y, z)).project(camera);
        return Math.abs(p.x) <= 0.95 && Math.abs(p.y) <= 0.95 && p.z < 1;
      })));
    });
  });
  for (const { id } of WORLD_STYLES) {
    await standalone.setViewportSize({ width: 1000, height: 700 });
    await selector.selectOption(id);
    await standalone.evaluate(() => atlas.home());
    await standalone.waitForFunction(() => atlas.world.controls.enabled, null, { polling: 100 });
    assert.ok(await allModelsFit(), `${id} desktop whole-world framing`);
    await standalone.setViewportSize({ width: 390, height: 720 });
    await standalone.waitForFunction(() => atlas.world.camera.aspect < 0.55, null, { polling: 100 });
    assert.ok(await allModelsFit(), `${id} portrait resize reframes without pressing Home`);
    console.log(`PASS desktop and portrait frame: ${id}`);
  }
  await standalone.close();
  assert.deepEqual(errors, []);
  console.log("PASS: 12 distinct layouts, desktop and portrait frame fit, one-click chooser, picking, filters, jobs, replay, catalog updates and focus. No service writes.");
} catch (error) {
  await mkdir("var/world-style-qa", { recursive: true });
  await page.screenshot({ path: "var/world-style-qa/failure.png" });
  console.error("Browser errors:", errors);
  for (const frame of page.frames()) console.error("Frame state:", await frame.evaluate(() => ({ url: location.href, atlas: !!window.atlas, style: window.atlas?.style, saved: localStorage.getItem("bt-world-style"), loading: document.getElementById("loading")?.textContent, error: document.querySelector(".cw-world-status")?.textContent })).catch(() => "detached"));
  throw error;
} finally { await browser.close(); }
