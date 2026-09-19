/**
 * Walk a running console and capture what it actually did.
 *
 *   node scripts/walk-console.mjs                 # every reachable host
 *   node scripts/walk-console.mjs --host b5
 *   node scripts/walk-console.mjs --host betenshi
 *
 * TWO HOSTS, BECAUSE ONE HOST CANNOT SHOW THIS PRODUCT. The whole idea of the
 * console is that a machine declares what it can do and the UI follows. A walk
 * of a Mac with one service is an honest picture of a small host and a
 * misleading picture of the product: no image generation, no speech, no
 * gateway, nothing to route between. So the same walk runs against both
 * machines and the captures are kept side by side.
 *
 * Requirements
 *   - the console running on each host you name below
 *   - its service manager, or the Home page reports an empty machine
 *   - a checkout of walkthrough-studio for the capture layer (WALKTHROUGH_STUDIO)
 *
 * The capture layer is imported rather than reimplemented: it verifies, by
 * measuring the output instead of trusting the flag it passed, that captures
 * are Retina, that the viewport is the size it asked for, that animations are
 * frozen, that no frame is near-empty, and that no two captures in a walk are
 * too similar to be distinct states. That last one has already rejected a lazy
 * step in this very script; see the note in the chat walk.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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

const ROOT = join(import.meta.dirname, "..");
const OUT = join(ROOT, "docs", "images", "console");

/** Where each console lives. Override either with an env var. */
const HOSTS = {
  b5: { label: "B5", url: process.env.B5_URL || "http://localhost:8003" },
  betenshi: { label: "BeTenshi", url: process.env.BETENSHI_URL || "http://192.168.18.36:8003" },
};

const argHost = (() => {
  const i = process.argv.indexOf("--host");
  return i > -1 ? process.argv[i + 1] : null;
})();

/** --features image,speech — re-walk a subset without redoing the whole host. */
const argFeatures = (() => {
  const i = process.argv.indexOf("--features");
  return i > -1 ? new Set(process.argv[i + 1].split(",").map((f) => f.trim())) : null;
})();

// ── helpers ─────────────────────────────────────────────────────────────────

/** Poll a boolean expression in the page. Returns false on timeout. */
async function waitFor(ctx, expr, { timeoutMs = 20_000, everyMs = 400 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await ctx.evaluate(expr)) return true;
    } catch {
      /* mid-navigation; keep polling */
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return false;
}

const jsString = (s) => JSON.stringify(String(s));

// ── the features ────────────────────────────────────────────────────────────
//
// `only` restricts a feature to hosts that can actually show it. A host that
// cannot is NOT walked and NOT quietly replaced with an empty-state capture:
// the run record says it was skipped and why.

const FEATURES = [
  {
    id: "home",
    hash: "stack",
    surfaces: ["desktop", "mobile"],
    async run(w, rec) {
      await w.shot("step-01-arrive.png");
      rec("Opened the console");
      if (!(await w.ctx.scrollToSelector("#resource-map", 80))) {
        await w.ctx.evaluate("window.scrollTo(0, document.body.scrollHeight / 2), true");
      }
      await w.shot("step-02-workstreams.png");
      rec("Scrolled to the workstreams and the resource map");
    },
  },
  {
    id: "services",
    hash: "services",
    async run(w, rec) {
      await w.shot("step-01-arrive.png");
      rec("Opened the services control centre");
    },
  },
  {
    id: "models",
    hash: "models",
    async run(w, rec) {
      await w.shot("step-01-arrive.png");
      rec("Opened Models — local weights and cloud APIs, sized against this machine");
    },
  },
  {
    id: "chat",
    hash: "llm",
    async run(w, rec, { issue }) {
      const box = 'input[placeholder="Ask the local model anything..."]';
      if (!(await w.ctx.waitForSelector(box, 15_000))) {
        issue("chat input never appeared");
        return;
      }
      await w.shot("step-01-arrive.png");
      rec("Opened Chat & Code");

      // NO CAPTURE OF THE ARMED INPUT. There was one, and the distinctness
      // invariant rejected it: typing changed 0.9% of the frame against the
      // arrival shot. The bytes differed, so a checksum would have passed it,
      // but a reader would see the same screen twice. Two real states here —
      // empty and answered — and the typing between them is an action.
      const prompt = "In one sentence: what is unified memory on Apple silicon?";
      await w.ctx.fill(box, prompt);
      const before = await w.ctx.evaluate(
        "document.querySelectorAll('.prose, [class*=\"whitespace-pre\"]').length",
      );
      await w.ctx.clickText("Run");

      // The input is disabled while `sending`, so its re-enabling is the app's
      // own signal that the round trip ended — and it catches an error reply as
      // readily as a good one.
      const ok = await waitFor(
        w.ctx,
        `(() => { const i = document.querySelector('${box}');
          return !!i && !i.disabled &&
            document.querySelectorAll('.prose, [class*="whitespace-pre"]').length > ${before}; })()`,
        { timeoutMs: 180_000 },
      );
      if (!ok) issue("no model reply within 180s");
      await w.ctx.evaluate("window.scrollTo(0, 0), true");
      await w.shot("step-02-answer.png");
      rec(`Asked "${prompt}" — the local model answered`);
    },
  },
  {
    id: "image",
    hash: "qwen",
    only: ["betenshi"],
    async run(w, rec, { issue }) {
      const box = 'textarea[placeholder^="Describe the image you want"]';
      if (!(await w.ctx.waitForSelector(box, 20_000))) {
        issue("image prompt box never appeared — is Qwen-Image registered on this host?");
        return;
      }
      await w.shot("step-01-arrive.png");
      rec("Opened Image Studio");

      const prompt =
        "a lone lighthouse on a basalt cliff at dusk, heavy weather, cinematic, moody";
      await w.ctx.fill(box, prompt);
      const before = await w.ctx.evaluate("document.querySelectorAll('img').length");

      // NOT clickText("Generate"): there are TWO controls named Generate — the
      // mode tab and the composer button — so targeting by accessible name is
      // ambiguous, the click silently does not land, and the walk then waits
      // seven minutes for an image nobody asked for. The composer button is the
      // pink one; that class is what makes it unambiguous.
      if (!(await w.ctx.click("button.bg-pink-600"))) {
        issue("could not find the Generate button");
        return;
      }

      // Capturing only the armed prompt would reduce the whole feature to a
      // text box. The point of Image Studio is the image, so wait for it —
      // a 20B diffusion model on a 5090 takes its time.
      const ok = await waitFor(
        w.ctx,
        `document.querySelectorAll('img').length > ${before}`,
        { timeoutMs: 420_000, everyMs: 2000 },
      );
      if (!ok) {
        issue("no image produced within 7 minutes");
        await w.shot("step-02-no-image.png", { sparse: true });
        rec("Generate did not produce an image within 7 minutes");
        return;
      }
      await w.shot("step-02-generated.png");
      rec(`Generated "${prompt}" on the local diffusion model`);
    },
  },
  {
    id: "speech",
    hash: "speech",
    only: ["betenshi"],
    async run(w, rec, { issue }) {
      // The Speech Lab splits into two panes — "Speech → text" and
      // "Text → speech" — and only one is mounted at a time, so the TTS box
      // does not exist until the pane is selected. An earlier version of this
      // walk looked for the textarea on arrival, found nothing, and reported
      // the host had no TTS service at all. It had one; the walk was wrong.
      await w.shot("step-01-transcribe.png");
      rec("Opened the Speech Lab on the speech-to-text pane");

      await w.ctx.clickText("Text → speech", { role: "tab" }).catch(() => {});
      if (!(await w.ctx.waitForSelector('textarea[placeholder="Type text to speak..."]', 8000))) {
        // Older builds render one combined pane with no sub-tabs.
        await w.ctx.clickText("Text → speech").catch(() => {});
      }
      const box = 'textarea[placeholder="Type text to speak..."]';
      if (!(await w.ctx.waitForSelector(box, 15_000))) {
        issue("no TTS input found on either pane");
        return;
      }
      await w.shot("step-02-synthesize.png");
      rec("Switched to the text-to-speech pane");

      const line = "The console starts the services, and the services do the work.";
      await w.ctx.fill(box, line);

      // NOT clickText("Speak"): this pane has TWO Speak buttons — one for
      // synthesis and one in the voice-cloning panel — so targeting by name is
      // ambiguous. Clicking the wrong one asks for microphone permission a
      // headless browser will never grant, which looks exactly like a broken
      // TTS service. Scope to the form that owns the textarea instead.
      const speak = 'form:has(textarea[placeholder="Type text to speak..."]) button[type="submit"]';
      if (!(await w.ctx.click(speak))) {
        issue("could not find the Speak button inside the TTS form");
        return;
      }

      // The audio element receives a blob: URL once synthesis returns — the
      // app's own completion signal, and it tells success from an error row.
      const ok = await waitFor(
        w.ctx,
        "(() => { const a = document.querySelector('audio'); return !!a && (a.src || '').startsWith('blob:'); })()",
        { timeoutMs: 180_000 },
      );
      if (!ok) issue("TTS returned no audio within 180s");
      await w.shot("step-03-spoken.png");
      rec(ok ? `Synthesized "${line}" on the local voice model` : "TTS produced no audio");
    },
  },
  {
    id: "usage",
    hash: "usage",
    async run(w, rec) {
      await w.shot("step-01-arrive.png");
      rec("Opened AI Usage — router, providers and cost");
    },
  },
  {
    id: "requests",
    hash: "requests",
    // Walked LAST on purpose: by now this run has generated real traffic
    // through the console, so the feed shows something rather than an empty
    // state. The capture is a photograph of its own walk.
    async run(w, rec) {
      await w.shot("step-01-arrive.png");
      rec("Opened Requests — the traffic this walk itself produced");
    },
  },
];

// ── run ─────────────────────────────────────────────────────────────────────

const targets = argHost && argHost !== "all" ? [argHost] : Object.keys(HOSTS);
const run = { startedAt: new Date().toISOString(), hosts: {}, issues: [], skipped: [] };

for (const hostId of targets) {
  const host = HOSTS[hostId];
  if (!host) {
    console.error(`Unknown host "${hostId}". Known: ${Object.keys(HOSTS).join(", ")}`);
    process.exit(1);
  }

  // Pre-flight: is it up, and is it the host we think it is? Walking the wrong
  // console produces captures that look completely fine and are fiction.
  let profile;
  try {
    const res = await fetch(`${host.url}/api/host`, { signal: AbortSignal.timeout(10_000) });
    profile = await res.json();
  } catch (err) {
    console.log(`\n⚠ ${host.label} (${host.url}) is not reachable — skipping. ${err}`);
    run.skipped.push({ host: hostId, reason: `unreachable: ${err}` });
    continue;
  }
  if (profile.id !== hostId) {
    console.log(`\n⚠ ${host.url} reports host "${profile.id}", expected "${hostId}" — skipping.`);
    run.skipped.push({ host: hostId, reason: `reports "${profile.id}"` });
    continue;
  }

  const health = await fetch(`${host.url}/api/health`, { signal: AbortSignal.timeout(30_000) })
    .then((r) => r.json())
    .catch(() => null);

  console.log(
    `\n══ ${host.label} — ${profile.platform}/${profile.gpu}, ` +
      `${health ? `${health.upCount}/${health.totalCount} services up` : "health unknown"}`,
  );

  run.hosts[hostId] = {
    label: host.label,
    url: host.url,
    platform: profile.platform,
    gpu: profile.gpu,
    memoryKind: profile.memory?.kind,
    services: health
      ? health.services.map((s) => ({ id: s.id, status: s.status }))
      : [],
    captures: [],
  };

  const cap = await openCapture({ outDir: join(OUT, hostId), driver: "auto" });

  for (const feature of FEATURES) {
    if (argFeatures && !argFeatures.has(feature.id)) continue;
    if (feature.only && !feature.only.includes(hostId)) {
      run.skipped.push({ host: hostId, feature: feature.id, reason: "not available on this host" });
      continue;
    }
    for (const surfaceId of feature.surfaces ?? ["desktop"]) {
      const surface = SURFACES[surfaceId];
      process.stdout.write(`  ▸ ${feature.id} (${surfaceId})\n`);
      const w = await cap.feature(feature.id, surface, { url: `${host.url}/#${feature.hash}` });
      const rec = (action) =>
        run.hosts[hostId].captures.push({ feature: feature.id, surface: surfaceId, action });
      const issue = (detail) =>
        run.issues.push({ host: hostId, feature: feature.id, kind: "walk", detail });
      try {
        await feature.run(w, rec, { issue });
      } catch (err) {
        console.log(`    ✗ ${err.message}`);
        run.issues.push({ host: hostId, feature: feature.id, kind: "error", detail: String(err.message) });
      } finally {
        for (const e of w.consoleErrors())
          run.issues.push({ host: hostId, feature: feature.id, kind: "console", detail: e });
        for (const f of w.failures())
          run.issues.push({ host: hostId, feature: feature.id, kind: "request", detail: `${f.status} ${f.path}` });
        await w.finish();
      }
    }
  }

  run.hosts[hostId].report = cap.report();
  await cap.close();
}

// ── record the run ──────────────────────────────────────────────────────────
// Kept inside this repository rather than written into a Walkthrough Studio
// hub: the hub half of the skill wants to own catalog/runs/issues files, and
// this project is not registered there. Same data, local home.
run.finishedAt = new Date().toISOString();
const dir = join(ROOT, "docs", "walkthrough");
mkdirSync(dir, { recursive: true });
// Timestamped, not just dated: a re-walk of one feature must not overwrite the
// record of the full run that preceded it. It did once, and the committed
// record then claimed the whole capture set came from a three-shot speech run.
const stamp = run.startedAt.replace(/[:.]/g, "-").slice(0, 19);
const file = join(dir, `run-${stamp}.json`);
writeFileSync(file, JSON.stringify(run, null, 2) + "\n");

console.log("\n─── walk complete ───");
for (const [id, h] of Object.entries(run.hosts)) {
  console.log(`\n${h.label}  (${h.captures.length} captures)`);
  for (const c of h.captures) console.log(`  ${c.feature}/${c.surface}  — ${c.action}`);
  for (const w of h.report?.warnings ?? []) console.log(`  · warning: ${w}`);
  for (const r of h.report?.rejected ?? []) console.log(`  · REJECTED ${r.file}: ${r.reason}`);
  void id;
}
if (run.skipped.length) {
  console.log("\nskipped");
  for (const s of run.skipped) console.log(`  · ${s.host}${s.feature ? "/" + s.feature : ""}: ${s.reason}`);
}
// Deduplicate the console/network noise, which repeats per feature.
const seen = new Set();
const uniq = run.issues.filter((i) => {
  const k = `${i.kind}:${i.detail}`;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});
if (uniq.length) {
  console.log("\nissues (deduplicated)");
  for (const i of uniq) console.log(`  · [${i.host}/${i.feature}] ${i.kind}: ${i.detail}`);
}
console.log(`\nrun record  ${file}`);
console.log(`captures    ${OUT}`);
void jsString;
