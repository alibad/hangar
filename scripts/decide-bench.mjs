#!/usr/bin/env node
// The decision-model benchmark: every labelled set in experiments/decide/sets,
// against every model, through the console's own POST /api/decide.
//
//   node scripts/decide-bench.mjs                      # all sets, default models
//   node scripts/decide-bench.mjs --models laya,claude-haiku --sets moderation
//   node scripts/decide-bench.mjs --fresh              # ignore cached predictions
//
// Through the console rather than straight at the services on purpose: that is
// the path a caller gets (so latency is what a caller sees), and an Ollama model
// goes through chatOnce's lease — the resource coordinator decides whether the
// 19 GB Gemma load fits, instead of this script loading it behind its back.
//
// Writes experiments/decide/results/<date>.json (every prediction, resumable:
// a re-run skips what is already there) and <date>.summary.json (the scores the
// Decision Lab and the experiment doc show). Needs the console on :8003, the
// laya service, the AI Router, and Ollama for local-gemma4.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { scoreSet, percentile } from "../src/lib/decide-metrics.ts";
import { itemContext } from "../src/lib/decide-sets.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SETS_DIR = path.join(root, "experiments", "decide", "sets");
const RESULTS_DIR = path.join(root, "experiments", "decide", "results");

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const CONSOLE = arg("console", process.env.CONSOLE_URL || "http://localhost:8003");
const MODELS = arg("models", "laya,laya-english,laya-multilingual,laya-typed-decisions,local-gemma4,claude-haiku").split(",");
const ONLY_SETS = arg("sets", "")?.split(",").filter(Boolean);
const DATE = arg("date", new Date().toISOString().slice(0, 10));
const FRESH = argv.includes("--fresh");
// Cloud calls in parallel (they are independent and billed per token, not per
// second); local ones one at a time (one GPU; a parallel run would measure
// queueing, not the model).
const CLOUD_CONCURRENCY = Number(arg("concurrency", "4"));

const outFile = path.join(RESULTS_DIR, `${DATE}.json`);
const summaryFile = path.join(RESULTS_DIR, `${DATE}.summary.json`);
fs.mkdirSync(RESULTS_DIR, { recursive: true });

const sets = fs
  .readdirSync(SETS_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(fs.readFileSync(path.join(SETS_DIR, f), "utf8")))
  .filter((s) => !ONLY_SETS.length || ONLY_SETS.includes(s.id));

/** @type {{ predictions: Record<string, Record<string, Record<string, any>>>, meta: any }} */
const store = !FRESH && fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, "utf8")) : { predictions: {}, meta: {} };
const save = () => fs.writeFileSync(outFile, JSON.stringify(store, null, 1));

const isLocal = (m) => m.startsWith("laya") || m.startsWith("local-");

async function decideOnce(set, item, model) {
  const body = {
    question: set.question,
    type: set.type ?? "choice",
    choices: set.choices,
    context: itemContext(set, item),
    model,
  };
  const t0 = performance.now();
  try {
    const r = await fetch(`${CONSOLE}/api/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Source": "decide-bench" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(900_000),
    });
    const j = await r.json();
    if (!r.ok) return { id: item.id, label: item.label, choice: "", probabilities: {}, error: j.error ?? `HTTP ${r.status}`, latencyMs: null };
    return {
      id: item.id,
      label: item.label,
      choice: j.choice,
      probabilities: j.probabilities,
      latencyMs: j.latencyMs ?? performance.now() - t0,
      modelLatencyMs: j.modelLatencyMs ?? null,
      costUsd: j.costUsd ?? null,
      parsed: j.parsed,
      checkpoint: j.checkpoint ?? null,
    };
  } catch (e) {
    return { id: item.id, label: item.label, choice: "", probabilities: {}, error: String(e), latencyMs: null };
  }
}

async function pool(tasks, n) {
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < tasks.length) await tasks[i++]();
    }),
  );
}

// ── reddit-scout's own heuristic, ported verbatim from its score_post ───────
// (~/.claude/skills/reddit-scout/scripts/reddit_scout.py), so "could Laya do
// that part?" is answered against what runs today, not against nothing.
const VALUE_PROPS = {
  "system-designer": ["system design", "architecture", "learning paths", "quizzes", "whiteboarding", "AI explanations"],
  "inner-quest": ["personality", "assessment", "attachment", "self improvement", "mental health", "mindfulness", "career", "relationship"],
  autobounds: ["field boundary", "satellite imagery", "computer vision", "field delineation", "precision agriculture"],
  "leela-quest": ["spiritual", "board game", "leela", "self reflection", "ancient game"],
  "handstand-quest": ["handstand", "AI coach", "personalized workouts", "progress tracking", "calisthenics"],
  "plan-quest": ["goal planning", "timeline", "OKR", "milestone", "AI planning", "reflection", "roadmap", "mind map", "snapshot", "plan history", "backlog"],
  "calendar-color": ["custom colors", "focus timer", "pomodoro", "time blocking", "google calendar", "free extension"],
};
function scoutScore(item) {
  const text = `${item.title ?? ""} ${item.body ?? ""}`.toLowerCase();
  let score = 0;
  const q = ["how do i", "how to", "any tips", "recommend", "suggestion", "looking for", "need help", "struggling", "advice", "best way to", "anyone know", "what app", "what tool", "alternative to", "is there"];
  if (q.some((w) => text.includes(w))) score += 15;
  const f = ["frustrated", "struggling", "can't find", "nothing works", "tired of", "annoying", "wish there was", "is there an app", "does anyone know", "hate", "broken", "doesn't work", "help me"];
  if (f.some((w) => text.includes(w))) score += 10;
  const kws = VALUE_PROPS[item.product] ?? [];
  score += Math.min(kws.filter((k) => text.includes(k.toLowerCase())).length * 8, 24);
  const c = item.comments ?? 0;
  score += c >= 20 ? 15 : c >= 10 ? 12 : c >= 5 ? 8 : c >= 2 ? 4 : 0;
  const p = item.upvotes ?? 0;
  score += p >= 50 ? 10 : p >= 10 ? 5 : p >= 3 ? 2 : 0;
  if (text.includes("i built") || text.includes("i made") || text.includes("check out my")) score -= 20;
  return Math.max(0, Math.min(score, 100));
}
function scoutPrediction(item) {
  const s = scoutScore(item);
  const choice = s >= 40 ? "high" : s >= 20 ? "medium" : "low";
  // A threshold has no probabilities: one-hot, which is exactly what a caller
  // of the heuristic gets, and ECE shows what that costs.
  return {
    id: item.id,
    label: item.label,
    choice,
    probabilities: { high: +(choice === "high"), medium: +(choice === "medium"), low: +(choice === "low") },
    latencyMs: 0,
    costUsd: null,
    score: s,
  };
}

// ── run ─────────────────────────────────────────────────────────────────────
const started = Date.now();
for (const set of sets) {
  store.predictions[set.id] ??= {};
  for (const model of MODELS) {
    const have = (store.predictions[set.id][model] ??= {});
    const todo = set.items.filter((it) => !have[it.id] || have[it.id].error);
    if (!todo.length) continue;
    process.stdout.write(`${set.id} × ${model}: ${todo.length} to run… `);
    const t0 = Date.now();
    let errors = 0;
    await pool(
      todo.map((item) => async () => {
        const p = await decideOnce(set, item, model);
        if (p.error) errors++;
        have[item.id] = p;
      }),
      isLocal(model) ? 1 : CLOUD_CONCURRENCY,
    );
    save();
    console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s${errors ? `, ${errors} errors (first: ${Object.values(have).find((x) => x.error)?.error?.slice(0, 160)})` : ""}`);
  }
  if (set.id === "reddit-relevance") {
    store.predictions[set.id]["reddit-scout-heuristic"] = Object.fromEntries(set.items.map((it) => [it.id, scoutPrediction(it)]));
  }
}

// ── score ───────────────────────────────────────────────────────────────────
const allModels = [...new Set(sets.flatMap((s) => Object.keys(store.predictions[s.id] ?? {})))];
const summary = {
  date: DATE,
  host: os.hostname(),
  generatedAt: new Date().toISOString(),
  console: CONSOLE,
  models: allModels,
  sets: sets.map((set) => {
    const labels = Object.keys(set.choices);
    const scores = {};
    for (const model of allModels) {
      const byId = store.predictions[set.id]?.[model];
      if (!byId) continue;
      const preds = set.items.map((it) => byId[it.id]).filter(Boolean);
      if (!preds.length) continue;
      const s = scoreSet(preds, labels);
      const fwd = preds.map((p) => p.modelLatencyMs).filter((x) => typeof x === "number");
      scores[model] = {
        ...s,
        forwardP50Ms: fwd.length ? percentile(fwd, 0.5) : null,
        checkpoints: [...new Set(preds.map((p) => p.checkpoint).filter(Boolean))],
        wrong: preds.filter((p) => p.choice !== p.label).map((p) => ({ id: p.id, label: p.label, choice: p.choice || null, p: p.probabilities?.[p.choice] ?? null, error: p.error ?? null })),
      };
    }
    return { id: set.id, title: set.title, n: set.items.length, labels, scores, cascades: cascades(set) };
  }),
};

/**
 * The realistic deployment is not "Laya or the LLM" but "Laya first, the LLM
 * when Laya is unsure". For each Laya model, and each confidence threshold:
 * accept Laya's answer at or above it, send the rest to the fallback LLM, and
 * report the accuracy, the share escalated, and the cost per thousand
 * decisions (escalations × the LLM's measured mean cost). This is where
 * calibration earns money: a well-calibrated model escalates exactly the items
 * it would have got wrong.
 */
function cascades(set, fallback = "claude-haiku") {
  const preds = store.predictions[set.id] ?? {};
  const fb = preds[fallback];
  if (!fb) return null;
  const fbCosts = Object.values(fb).map((p) => p.costUsd).filter((c) => typeof c === "number");
  const meanCost = fbCosts.length ? fbCosts.reduce((a, b) => a + b, 0) / fbCosts.length : null;
  const out = {};
  for (const model of Object.keys(preds).filter((m) => m.startsWith("laya"))) {
    out[model] = [0, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1.01].map((t) => {
      let correct = 0;
      let escalated = 0;
      for (const it of set.items) {
        const p = preds[model][it.id];
        const conf = p?.probabilities?.[p?.choice] ?? 0;
        const useLaya = p && !p.error && conf >= t;
        const final = useLaya ? p : fb[it.id];
        if (!useLaya) escalated++;
        if (final && !final.error && final.choice === it.label) correct++;
      }
      const n = set.items.length;
      return {
        threshold: t > 1 ? "always escalate" : t,
        accuracy: correct / n,
        escalated: escalated / n,
        costPer1000Usd: meanCost == null ? null : (escalated / n) * meanCost * 1000,
      };
    });
  }
  return { fallback, models: out };
}
fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 1));

// ── print ───────────────────────────────────────────────────────────────────
const pct = (x) => `${(x * 100).toFixed(0)}%`.padStart(5);
for (const s of summary.sets) {
  console.log(`\n${s.title} (n=${s.n}, ${s.labels.length} labels)`);
  console.log("  model".padEnd(30), "acc".padStart(5), "F1".padStart(5), "  ECE", " ECE-T", "   p50", "  $/1k");
  for (const [m, sc] of Object.entries(s.scores)) {
    console.log(
      `  ${m}`.padEnd(30),
      pct(sc.accuracy),
      pct(sc.macroF1),
      sc.ece.toFixed(3).padStart(6),
      sc.eceAfterTemperature.toFixed(3).padStart(6),
      (sc.latencyP50Ms == null ? "—" : `${Math.round(sc.latencyP50Ms)}ms`).padStart(7),
      (sc.costPer1000Usd == null ? "local" : `$${sc.costPer1000Usd.toFixed(3)}`).padStart(7),
      sc.errors ? ` ${sc.errors} err` : "",
      sc.unparsed ? ` ${sc.unparsed} unparsed` : "",
    );
  }
}
console.log(`\n${outFile}\n${summaryFile}\n${((Date.now() - started) / 1000).toFixed(0)}s`);
