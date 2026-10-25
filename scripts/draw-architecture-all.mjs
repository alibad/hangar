// Draw the architecture of every project on this machine, the way the Draw button does.
//
// For each project with a checkout here, this asks the bundled engine to start an
// architecture drawing (POST /api/architecture, the same call the project pane makes),
// waits for Archify's checks to pass or the repairs to run out, and moves on. Two
// drawings run at a time, Hangar's own job limit. Drawings land where Hangar keeps
// them (var/engine/architecture); with --out they are also copied, one folder per
// project, under an index page.
//
//   node scripts/draw-architecture-all.mjs                      # your own repos, Claude
//   node scripts/draw-architecture-all.mjs --provider codex
//   node scripts/draw-architecture-all.mjs --include-vendor     # vendor copies and forks too
//   node scripts/draw-architecture-all.mjs --redraw             # even when the drawing is current
//   node scripts/draw-architecture-all.mjs --only hangar,db     # a few, by name
//   node scripts/draw-architecture-all.mjs --out <folder>       # export copies + index.html
//   node scripts/draw-architecture-all.mjs --dry-run            # list what would be drawn
//
// A drawing that is already at the checkout's HEAD is skipped unless --redraw is given.
// The engine's own refusals (sign-in lapsed, two jobs running, a job already in the
// checkout) are retried for a while and otherwise recorded, never worked around.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback; };
const ENGINE = process.env.HANGAR_ENGINE_URL ?? `http://127.0.0.1:${process.env.HANGAR_ENGINE_PORT || 7789}`;
const PROVIDER = value("--provider", "claude");
const CONCURRENCY = Math.min(2, Math.max(1, Number(value("--concurrency", 2)) || 2));
const OUT = value("--out", "");
const ONLY = new Set((value("--only", "") || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
const POLL_MS = 10_000;
const DRAWING_TIMEOUT_MS = 45 * 60_000;
const RETRY_MS = 30_000;
const RETRY_FOR_MS = 60 * 60_000;
if (!["claude", "codex"].includes(PROVIDER)) { console.error("--provider is claude or codex"); process.exit(2); }

const stamp = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[${stamp()}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safe = (name) => name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "project";

async function api(p, body) {
  const init = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json", "X-Hangar": "1" }, body: JSON.stringify(body) };
  const res = await fetch(`${ENGINE}${p}`, { ...init, signal: AbortSignal.timeout(120_000) });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

const results = new Map(); // repo id -> { name, state, message, title, components, drawnAt, provider, startedAt, endedAt, rounds }
let summaryPath = null;
function save() {
  if (!OUT) return;
  const rows = [...results.values()];
  fs.writeFileSync(summaryPath, JSON.stringify({ engine: ENGINE, provider: PROVIDER, updatedAt: new Date().toISOString(), rows }, null, 1));
  const count = (s) => rows.filter((r) => r.state === s).length;
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const line = (r) => `<tr class="${esc(r.state)}"><td>${r.state === "ready" ? `<a href="${esc(r.folder)}/diagram.html">${esc(r.name)}</a>` : esc(r.name)}</td><td>${esc(r.state)}</td><td>${esc(r.title || "")}</td><td>${r.components ?? ""}</td><td>${r.rounds ?? ""}</td><td>${esc(r.message || "")}</td></tr>`;
  fs.writeFileSync(path.join(OUT, "index.html"), `<!doctype html><meta charset="utf-8"><title>Architecture drawings</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:24px;color:#222}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:6px 10px;border-bottom:1px solid #ddd;vertical-align:top}tr.ready td:nth-child(2){color:#1d7a46}tr.failed td:nth-child(2),tr.timed-out td:nth-child(2){color:#b3261e}tr.current td:nth-child(2){color:#555}small{color:#666}</style>
<h1>Architecture drawings</h1><p><small>${esc(rows.length)} projects · ${count("ready")} drawn · ${count("current")} already current · ${count("failed") + count("timed-out")} failed · ${count("drawing") + count("queued")} in progress · drawn with ${esc(PROVIDER)} · updated ${esc(new Date().toISOString())}</small></p>
<table><tr><th>Project</th><th>State</th><th>Title</th><th>Parts</th><th>Rounds</th><th>Note</th></tr>${rows.sort((a, b) => a.name.localeCompare(b.name)).map(line).join("\n")}</table>`);
}

function exportDrawing(r, engineStorage) {
  if (!OUT || !engineStorage) return;
  const dest = path.join(OUT, r.folder);
  fs.mkdirSync(dest, { recursive: true });
  for (const f of ["diagram.html", "meta.json", "candidate.json"]) {
    const src = path.join(engineStorage, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dest, f));
  }
}

/** Hangar's storage folder for a project id: <slug>-<sha256 prefix>, under var/engine/architecture. */
async function storageFor(rid) {
  const slug = rid.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 60).replace(/^[-.]+|[-.]+$/g, "") || "project";
  const base = process.env.HANGAR_ENGINE_DATA_DIR || path.join(HERE, "..", "var", "engine");
  return path.join(base, "architecture", `${slug}-${createHash("sha256").update(rid).digest("hex").slice(0, 10)}`);
}

async function draw(repo) {
  const r = results.get(repo.id);
  const began = Date.now();
  r.startedAt = new Date().toISOString();
  // Start, retrying the engine's "busy" answers for a while.
  for (;;) {
    const { ok, data } = await api("/api/architecture", { repo: repo.id, provider: PROVIDER });
    if (ok) break;
    const msg = data.error || "could not start";
    if (/already being drawn/i.test(msg)) break;
    if (/Two jobs are already running|active or unobserved Hangar job|scan is running/i.test(msg) && Date.now() - began < RETRY_FOR_MS) {
      log(`${repo.name}: waiting (${msg})`);
      await sleep(RETRY_MS);
      continue;
    }
    r.state = "failed"; r.message = msg; r.endedAt = new Date().toISOString();
    log(`${repo.name}: could not start — ${msg}`);
    save();
    return;
  }
  r.state = "drawing"; save();
  log(`${repo.name}: drawing with ${PROVIDER}`);
  const startedAt = Date.now();
  for (;;) {
    await sleep(POLL_MS);
    let status;
    try { status = (await api(`/api/architecture?repo=${encodeURIComponent(repo.id)}`)).data; }
    catch (e) { log(`${repo.name}: status unavailable (${e.message}); still waiting`); continue; }
    const d = status.drawing;
    if (d?.round) r.rounds = d.round;
    if (d?.state === "ready" || (!d && status.diagram && Date.parse(status.diagram.drawnAt) >= startedAt - 60_000)) {
      Object.assign(r, { state: "ready", title: status.diagram?.title, components: status.diagram?.components, drawnAt: status.diagram?.drawnAt, provider: status.diagram?.provider, message: status.diagram?.unchecked ? "kept, readability check not run (no browser)" : "", endedAt: new Date().toISOString() });
      exportDrawing(r, await storageFor(repo.id));
      log(`${repo.name}: ready — "${r.title}" (${r.components} parts, ${r.rounds || 1} round${r.rounds > 1 ? "s" : ""}, ${Math.round((Date.now() - startedAt) / 60_000)} min)`);
      save();
      return;
    }
    if (d?.state === "failed" || (!d && !status.diagram)) {
      Object.assign(r, { state: "failed", message: d?.message || "the engine lost track of the drawing", endedAt: new Date().toISOString() });
      log(`${repo.name}: failed — ${r.message}`);
      save();
      return;
    }
    if (Date.now() - startedAt > DRAWING_TIMEOUT_MS) {
      Object.assign(r, { state: "timed-out", message: `no result after ${DRAWING_TIMEOUT_MS / 60_000} minutes; Hangar may still finish it`, endedAt: new Date().toISOString() });
      log(`${repo.name}: timed out`);
      save();
      return;
    }
  }
}

async function main() {
  const { ok, data: doc } = await api("/api/atlas");
  if (!ok) throw new Error("The project engine did not answer. Open World in Hangar once, or run node scripts/start-engine.mjs.");
  let repos = doc.repos.filter((r) => r.onMachine && !r.hidden && (flag("--include-vendor") || !["vendor", "fork"].includes(r.kind)));
  if (ONLY.size) repos = repos.filter((r) => ONLY.has(r.name.toLowerCase()) || ONLY.has((r.fullName || "").toLowerCase()));
  repos.sort((a, b) => (a.sizeKB || 0) - (b.sizeKB || 0)); // small first: early feedback
  if (OUT) { fs.mkdirSync(OUT, { recursive: true }); summaryPath = path.join(OUT, "run.json"); }
  const queue = [];
  for (const repo of repos) {
    const r = { id: repo.id, name: repo.name, repo: repo.fullName || repo.name, folder: safe(repo.name), state: "queued", message: "" };
    results.set(repo.id, r);
    const { ok: sOk, data: s } = await api(`/api/architecture?repo=${encodeURIComponent(repo.id)}`);
    if (!sOk) { r.state = "failed"; r.message = s.error || "status unavailable"; continue; }
    if (!s.archify) throw new Error(`Archify is not installed on this machine. Install it with: ${s.install}`);
    if (s.signedOut?.includes(PROVIDER)) throw new Error(`${PROVIDER} is not signed in on this machine; use Sign in in Hangar first.`);
    if (!s.checkout) { r.state = "failed"; r.message = "no usable checkout"; continue; }
    if (s.diagram && s.behind === 0 && !flag("--redraw")) {
      Object.assign(r, { state: "current", title: s.diagram.title, components: s.diagram.components, drawnAt: s.diagram.drawnAt, provider: s.diagram.provider, message: "drawing is at HEAD" });
      exportDrawing(r, await storageFor(repo.id));
      continue;
    }
    if (s.drawing && ["drawing", "checking"].includes(s.drawing.state)) { r.message = "a drawing was already running"; }
    queue.push(repo);
  }
  save();
  const skipped = [...results.values()].filter((r) => r.state === "current").length;
  log(`${repos.length} projects on this machine; ${queue.length} to draw with ${PROVIDER}, ${skipped} already current, ${repos.length - queue.length - skipped} cannot be drawn.`);
  if (flag("--dry-run")) { for (const repo of queue) console.log(`  ${repo.name}`); return; }
  const workers = Array.from({ length: CONCURRENCY }, async () => { while (queue.length) await draw(queue.shift()); });
  await Promise.all(workers);
  const rows = [...results.values()];
  const n = (s) => rows.filter((r) => r.state === s).length;
  log(`done: ${n("ready")} drawn, ${n("current")} already current, ${n("failed")} failed, ${n("timed-out")} timed out.`);
  for (const r of rows.filter((x) => x.state === "failed" || x.state === "timed-out")) log(`  ${r.name}: ${r.message}`);
}

main().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
