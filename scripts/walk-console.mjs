/**
 * Walk the running console and capture the images the README uses.
 *
 * This is a Walkthrough Studio walk script: it drives the REAL console with a
 * real browser and photographs what it actually did. Nothing here composes or
 * mocks a screen. If a capture in the README shows a model answer, a model
 * answered.
 *
 *   node scripts/walk-console.mjs
 *
 * Requirements
 *   - the console running on :8003 (launchd agent, or `npm run dev`)
 *   - the service manager on :8099, or the Home page reports an empty machine
 *   - a checkout of walkthrough-studio for the capture layer (below)
 *
 * WHY THE CAPTURE LAYER IS IMPORTED RATHER THAN WRITTEN HERE: it enforces, by
 * measurement rather than by trusting the option it passed, that every capture
 * is Retina, that the viewport really is the size it asked for, that animations
 * are frozen so the frame is deterministic, that no two captures in a walk are
 * byte-identical (identical bytes mean nothing happened between two claimed
 * states), and that a capture is not a near-empty frame. A hand-rolled
 * screenshot helper silently opts out of all of it. Point WALKTHROUGH_STUDIO at
 * the checkout if it is not in the default location.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const STUDIO =
  process.env.WALKTHROUGH_STUDIO || join(homedir(), "Code", "GitHub", "walkthrough-studio");
const CAPTURE = join(STUDIO, "scripts", "lib", "capture", "index.mjs");

if (!existsSync(CAPTURE)) {
  console.error(`Capture layer not found at ${CAPTURE}`);
  console.error("Clone walkthrough-studio, or set WALKTHROUGH_STUDIO to its path.");
  process.exit(1);
}

const { openCapture, SURFACES } = await import(pathToFileURL(CAPTURE).href);

const BASE = process.env.CONSOLE_URL || "http://localhost:8003";
const OUT = join(import.meta.dirname, "..", "docs", "images", "console");

/** Poll a boolean expression in the page. Returns false on timeout. */
async function waitFor(ctx, expr, { timeoutMs = 20_000, everyMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await ctx.evaluate(expr)) return true;
    } catch {
      /* the page may be mid-navigation; keep polling */
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return false;
}

const steps = [];
const record = (feature, file, action) => steps.push({ feature, file, action });

const cap = await openCapture({ outDir: OUT, driver: "auto" });
const issues = [];

/** One feature = one fresh browser context at one URL. */
async function walk(featureId, hash, fn) {
  process.stdout.write(`\n▸ ${featureId}\n`);
  const w = await cap.feature(featureId, SURFACES.desktop, { url: `${BASE}/#${hash}` });
  try {
    await fn(w);
  } finally {
    for (const e of w.consoleErrors()) issues.push({ feature: featureId, kind: "console", detail: e });
    for (const f of w.failures()) issues.push({ feature: featureId, kind: "request", detail: `${f.status} ${f.path}` });
    await w.finish();
  }
}

// ── Home ────────────────────────────────────────────────────────────────────
// The cockpit: what this machine is, what it can be asked to do, and what is
// resident right now. Two captures because the page has two distinct halves and
// one viewport does not hold both.
await walk("home", "stack", async (w) => {
  await w.shot("step-01-arrive.png");
  record("home", "step-01-arrive.png", "Opened the console at #stack");

  // The resource map is below the fold on a 900px viewport. Scrolling is the
  // interaction here — there is nothing to click.
  const found = await w.ctx.scrollToSelector("#resource-map", 80);
  if (!found) await w.ctx.evaluate("window.scrollTo(0, document.body.scrollHeight / 2), true");
  await w.shot("step-02-resource-map.png");
  record("home", "step-02-resource-map.png", "Scrolled to the resource map");
});

// ── Services ────────────────────────────────────────────────────────────────
await walk("services", "services", async (w) => {
  await w.shot("step-01-arrive.png");
  record("services", "step-01-arrive.png", "Opened the Services control centre");
});

// ── Models ──────────────────────────────────────────────────────────────────
await walk("models", "models", async (w) => {
  await w.shot("step-01-arrive.png");
  record("models", "step-01-arrive.png", "Opened Models — running, wired, and downloadable in one list");
});

// ── Chat ────────────────────────────────────────────────────────────────────
// The peak moment, and the reason this walk is not just a tour of empty chrome:
// a real prompt to the real local model, and the real answer it returned.
// Capturing only the armed input would reduce the whole feature to a text box.
const PROMPT = "In one sentence: what is unified memory on Apple silicon?";
await walk("chat", "llm", async (w) => {
  const box = 'input[placeholder="Ask the local model anything..."]';
  const ok = await w.ctx.waitForSelector(box, 15_000);
  if (!ok) throw new Error("chat input never appeared — is the LLM tab available on this host?");

  await w.shot("step-01-arrive.png");
  record("chat", "step-01-arrive.png", "Opened Chat & Code");

  // NO CAPTURE OF THE ARMED INPUT. There was one here, and the distinctness
  // invariant rejected it: typing into a text box changed 0.9% of the frame and
  // 18% of the content area against the arrival shot — the bytes differ, so an
  // MD5 guard would have waved it through, but a reader would simply see the
  // same screen twice. This feature has two real states, empty and answered,
  // and the step between them is an action, not a state.
  await w.ctx.fill(box, PROMPT);

  const before = await w.ctx.evaluate("document.querySelectorAll('.prose, [class*=\"whitespace-pre\"]').length");
  await w.ctx.clickText("Run");

  // The input is disabled while `sending`, so its re-enabling is the app's own
  // signal that the round trip finished — more reliable than watching for text,
  // and it catches an error reply as readily as a successful one.
  const answered = await waitFor(
    w.ctx,
    `(() => { const i = document.querySelector('${box}'); return !!i && !i.disabled && document.querySelectorAll('.prose, [class*="whitespace-pre"]').length > ${before}; })()`,
    { timeoutMs: 180_000 },
  );
  if (!answered) {
    issues.push({ feature: "chat", kind: "timeout", detail: "no model reply within 180s" });
  }
  // Scroll the transcript to the answer rather than the composer.
  await w.ctx.evaluate("window.scrollTo(0, 0), true");
  await w.shot("step-02-answer.png");
  record("chat", "step-02-answer.png", `Asked "${PROMPT}" and the local model answered`);
});

// ── Requests ────────────────────────────────────────────────────────────────
// Walked LAST on purpose: by now this walk has itself generated traffic through
// the console and Ollama, so the tab has something real to show instead of an
// empty state. The screenshot is a picture of this run.
await walk("requests", "requests", async (w) => {
  await w.shot("step-01-arrive.png");
  record("requests", "step-01-arrive.png", "Opened Requests — traffic generated by this very walk");
});

const report = cap.report();
await cap.close();

// ── Report ──────────────────────────────────────────────────────────────────
console.log("\n─── walk complete ───");
console.log(`captures  ${steps.length}`);
for (const s of steps) console.log(`  ${s.feature}/${s.file}  — ${s.action}`);
if (report.warnings?.length) {
  console.log("\nwarnings");
  for (const w of report.warnings) console.log(`  · ${w}`);
}
if (report.rejected?.length) {
  console.log("\nREJECTED CAPTURES (the layer refused these)");
  for (const r of report.rejected) console.log(`  · ${r.file}: ${r.reason}`);
}
if (issues.length) {
  console.log("\nissues seen while walking");
  for (const i of issues) console.log(`  · [${i.feature}] ${i.kind}: ${i.detail}`);
}
console.log(`\noutput  ${OUT}`);
