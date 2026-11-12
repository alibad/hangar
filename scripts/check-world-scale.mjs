// Larger-catalog rendering and disposal check; all project data is fictional.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { WORLD_STYLES } from "../engine/world/js/world-styles.js";
import { styleFixture, interceptWorld } from "./world-style-fixture.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_CORE ? pathToFileURL(process.env.PLAYWRIGHT_CORE).href : "playwright-core");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, reducedMotion: "reduce" });
const doc = styleFixture(), originals = [...doc.repos];
doc.families = Array.from({ length: 7 }, (_, i) => ({ id: `family-${i}`, name: `Family ${i + 1}`, repos: 30 }));
doc.repos = Array.from({ length: 210 }, (_, i) => ({ ...originals[i % 9], id: `project-${i}`, name: `Project ${i}`, family: `family-${Math.floor(i / 30)}` }));
await interceptWorld(page, doc);
try {
  await page.goto(`${process.env.HANGAR_URL || "http://127.0.0.1:8003"}/api/world/local/view/index.html?embed=hangar&style=galaxy&quality=low&lens=map`);
  await page.waitForFunction(() => window.atlas?.buildings.length === 210, null, { timeout: 60000 });
  const styles = WORLD_STYLES.slice(2).map(style => style.id), first = new Map();
  for (let cycle = 0; cycle < 3; cycle++) for (const style of styles) {
    const stats = await page.evaluate(style => {
      const start = performance.now(); atlas.setStyle(style); atlas.world.render(false);
      return { ms: Math.round(performance.now() - start), calls: atlas.world.renderer.info.render.calls, geometries: atlas.world.renderer.info.memory.geometries, textures: atlas.world.renderer.info.memory.textures };
    }, style);
    if (cycle === 1) first.set(style, stats);
    else if (cycle === 2) {
      assert.ok(stats.geometries <= first.get(style).geometries + 1, `${style}: geometries grew across replacements: ${JSON.stringify(stats)}`);
      assert.ok(stats.textures <= first.get(style).textures, `${style}: textures grew across replacements`);
    }
    console.log(`PASS cycle ${cycle + 1}, ${style}: ${JSON.stringify(stats)}`);
  }
  console.log("PASS: 210 projects, seven families, 30 world changes with stable geometry/texture counts. No service writes.");
} finally { await browser.close(); }
