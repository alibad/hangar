// Rebuild the chooser's thumbnails from the real renderer, with fictional projects only.
import { pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";
import sharp from "sharp";
import { WORLD_STYLES } from "../engine/world/js/world-styles.js";
import { styleFixture, interceptWorld } from "./world-style-fixture.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_CORE ? pathToFileURL(process.env.PLAYWRIGHT_CORE).href : "playwright-core");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, headless: true, args: process.env.HANGAR_CAPTURE_HARDWARE ? [] : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 960, height: 600 }, deviceScaleFactor: 1, reducedMotion: "reduce" });
const errors = []; page.on("pageerror", error => errors.push(error.message));
await interceptWorld(page, styleFixture());
try {
  await page.goto(`${process.env.HANGAR_URL || "http://127.0.0.1:8003"}/api/world/local/view/index.html?embed=hangar&quality=${process.env.HANGAR_CAPTURE_QUALITY || "medium"}&night=0&lens=map`);
  await page.waitForFunction(() => !!window.atlas, null, { timeout: 60000 });
  await page.addStyleTag({ content: "#labels,.pad,.dock,.hint,.notice{display:none!important}" });
  await mkdir("public/world-styles", { recursive: true });
  await mkdir("var/world-style-qa/previews", { recursive: true });
  for (const style of WORLD_STYLES) {
    await page.evaluate(id => atlas.setStyle(id), style.id);
    await page.waitForTimeout(100);
    await page.evaluate(style => {
      const a = window.atlas;
      a.setStyle(style.id);
      const v = a.composition, r = v.extent;
      a.world.controls.target.set(v.center.x, v.center.y, v.center.z);
      const sphere = new a.world.THREE.Spherical(r * 2.15, v.phi, v.theta);
      a.world.camera.position.copy(a.world.controls.target).add(new a.world.THREE.Vector3().setFromSpherical(sphere));
      if (style.id === "buildings") {
        a.world.controls.target.set(0, 7, 0);
        a.world.camera.position.set(r * 1.8, r * 1.8, r * 2.2);
      }
      a.world.controls.update();
      a.setLens("map");
      // A clean view of the project forms; the host's navigation portal stays in the product.
      for (const island of a.islands) for (const child of island.group.children) {
        if (child.isGroup && child.children.some(c => c.geometry?.type === "CylinderGeometry" && c.geometry?.parameters?.height === 14)) child.visible = false;
      }
    }, style);
    await page.waitForFunction(id => atlas.buildings.every(b => b.style === id && b.state.dim < 0.002), style.id);
    await page.waitForTimeout(900);
    await page.screenshot({ path: `var/world-style-qa/previews/${style.id}.png` });
    await sharp(`var/world-style-qa/previews/${style.id}.png`).resize(480, 300).webp({ quality: 84 }).toFile(`public/world-styles/${style.id}.webp`);
    console.log(`Captured ${style.id}`);
  }
  const tiles = [];
  for (const [index, style] of WORLD_STYLES.entries()) {
    const x = index % 3 * 400, y = Math.floor(index / 3) * 294;
    tiles.push({ input: await sharp(`public/world-styles/${style.id}.webp`).resize(400, 250).toBuffer(), left: x, top: y });
    tiles.push({ input: Buffer.from(`<svg width="400" height="44"><rect width="400" height="44" fill="#171b24"/><text x="16" y="28" fill="#edf1ff" font-family="sans-serif" font-size="17">${style.name}</text></svg>`), left: x, top: y + 250 });
  }
  await sharp({ create: { width: 1200, height: 1176, channels: 3, background: "#171b24" } }).composite(tiles).webp({ quality: 86 }).toFile("public/world-styles/overview.webp");
  if (errors.length) throw new Error(errors.join("\n"));
} finally { await browser.close(); }
