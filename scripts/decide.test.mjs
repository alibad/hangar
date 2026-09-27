// Unit tests for src/lib/decide.ts (the /api/decide contract) and
// src/lib/decide-metrics.ts (how the experiment scores it).
//
// The parser cases are the replies LLMs actually give when asked for JSON: a
// code fence, prose around it, percentages, a label in the wrong case. Each one
// silently became a uniform distribution in a naive parser, which reads as a
// badly calibrated model rather than a parsing bug.
import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeDecideRequest,
  parseLlmDecision,
  buildLlmPrompt,
  isLayaModel,
} from "../src/lib/decide.ts";
import {
  accuracy,
  ece,
  brier,
  nll,
  temper,
  eceAfterTemperature,
  percentile,
  scoreSet,
  reliability,
} from "../src/lib/decide-metrics.ts";

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

// ── request normalisation ────────────────────────────────────────────────────

test("a bare list of choices becomes label→label, and model defaults to laya", () => {
  const r = normalizeDecideRequest({ question: "Which?", choices: ["a", " b "], context: "x" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.req.choices, { a: "a", b: "b" });
  assert.equal(r.req.model, "laya");
  assert.equal(r.req.type, "choice");
});

test("described choices keep their descriptions; empty descriptions fall back to the label", () => {
  const r = normalizeDecideRequest({ question: "Q", choices: { bug: "broken", noise: "" } });
  assert.deepEqual(r.req.choices, { bug: "broken", noise: "noise" });
});

test("yesno ignores choices and is always exactly yes/no", () => {
  const r = normalizeDecideRequest({ question: "Spam?", type: "yesno", choices: ["x"] });
  assert.deepEqual(Object.keys(r.req.choices), ["yes", "no"]);
});

test("refuses what it cannot answer, with a sentence", () => {
  assert.match(normalizeDecideRequest({}).error, /question/);
  assert.match(normalizeDecideRequest({ question: "Q", choices: ["only"] }).error, /two/);
  assert.match(normalizeDecideRequest({ question: "Q", type: "rank", choices: ["a", "b"] }).error, /type/);
  assert.match(normalizeDecideRequest({ question: "Q", choices: ["a", "b"], context: [1] }).error, /context/);
});

test("object contexts survive; laya models are recognised", () => {
  const r = normalizeDecideRequest({ question: "Q", choices: ["a", "b"], context: { subject: "hi" }, model: "claude-haiku" });
  assert.deepEqual(r.req.context, { subject: "hi" });
  assert.equal(isLayaModel(r.req.model), false);
  assert.equal(isLayaModel("laya-multilingual"), true);
});

test("the LLM prompt names every label and the JSON shape", () => {
  const { req } = normalizeDecideRequest({ question: "Where?", choices: { local: "easy", cloud: "hard" }, context: "task" });
  const p = buildLlmPrompt(req);
  assert.match(p, /- local: easy/);
  assert.match(p, /"probabilities": \{"local": <0-1>, "cloud": <0-1>\}/);
  assert.match(p, /task/);
});

// ── LLM reply parsing ───────────────────────────────────────────────────────

const L = ["bug", "feature_request", "noise"];

test("plain JSON parses and is normalised", () => {
  const r = parseLlmDecision('{"choice":"bug","probabilities":{"bug":0.8,"feature_request":0.1,"noise":0.1}}', L);
  assert.equal(r.parsed, true);
  assert.equal(r.choice, "bug");
  close(r.probabilities.bug, 0.8);
});

test("code fences, prose, label case and percentages are tolerated", () => {
  const r = parseLlmDecision('Sure!\n```json\n{"choice": "Noise", "probabilities": {"Bug": 10, "Feature_Request": 5, "noise": 85}}\n```', L);
  assert.equal(r.parsed, true);
  assert.equal(r.choice, "noise");
  close(r.probabilities.noise, 0.85);
});

test("the distribution wins over a disagreeing choice field", () => {
  const r = parseLlmDecision('{"choice":"bug","probabilities":{"bug":0.2,"feature_request":0.7,"noise":0.1}}', L);
  assert.equal(r.choice, "feature_request");
});

test("missing labels get zero; unknown labels are ignored", () => {
  const r = parseLlmDecision('{"choice":"bug","probabilities":{"bug":0.9,"other":0.1}}', L);
  close(r.probabilities.bug, 1);
  close(r.probabilities.noise, 0);
});

test("no JSON: one-hot on the first label mentioned, flagged unparsed", () => {
  const r = parseLlmDecision("I think this is noise, maybe a bug.", L);
  assert.equal(r.parsed, false);
  assert.equal(r.choice, "noise");
  close(r.probabilities.noise, 1);
});

test("nothing recognisable: uniform, flagged unparsed", () => {
  const r = parseLlmDecision("I cannot help with that.", L);
  assert.equal(r.parsed, false);
  close(r.probabilities.bug, 1 / 3);
});

test("JSON with a choice but no probabilities is one-hot and unparsed", () => {
  const r = parseLlmDecision('{"choice":"feature_request"}', L);
  assert.equal(r.parsed, false);
  assert.equal(r.choice, "feature_request");
});

// ── metrics ─────────────────────────────────────────────────────────────────

const pred = (label, probs, extra = {}) => {
  const choice = Object.keys(probs).reduce((a, b) => (probs[b] > probs[a] ? b : a));
  return { id: Math.random().toString(36), label, choice, probabilities: probs, ...extra };
};

test("a perfectly calibrated, always-right, fully confident model has ECE 0 and Brier 0", () => {
  const ps = [pred("a", { a: 1, b: 0 }), pred("b", { a: 0, b: 1 })];
  assert.equal(accuracy(ps), 1);
  close(ece(ps), 0);
  close(brier(ps), 0);
});

test("ECE is |accuracy - confidence| in a single bin", () => {
  // Four predictions at 0.9 confidence, half right: ECE = |0.5 - 0.9| = 0.4.
  const ps = [
    pred("a", { a: 0.9, b: 0.1 }),
    pred("a", { a: 0.9, b: 0.1 }),
    pred("b", { a: 0.9, b: 0.1 }),
    pred("b", { a: 0.9, b: 0.1 }),
  ];
  close(ece(ps), 0.4);
  const bin = reliability(ps).find((b) => b.n);
  assert.equal(bin.n, 4);
  close(bin.accuracy, 0.5);
});

test("errors count as wrong for accuracy but are excluded from calibration", () => {
  const ps = [pred("a", { a: 1, b: 0 }), { id: "x", label: "a", choice: "", probabilities: {}, error: "timeout" }];
  assert.equal(accuracy(ps), 0.5);
  close(ece(ps), 0);
});

test("NLL of a zero-probability truth is large but finite", () => {
  const v = nll([pred("b", { a: 1, b: 0 })]);
  assert.ok(Number.isFinite(v) && v > 10);
});

test("temperature > 1 softens, < 1 sharpens, and never moves the argmax", () => {
  const p = { a: 0.7, b: 0.2, c: 0.1 };
  assert.ok(temper(p, 2).a < 0.7);
  assert.ok(temper(p, 0.5).a > 0.7);
  close(Object.values(temper(p, 3)).reduce((x, y) => x + y, 0), 1);
});

test("cross-fitted temperature repairs an overconfident model", () => {
  // Always 0.99 confident, right 60% of the time: raw ECE ≈ 0.39.
  const ps = Array.from({ length: 40 }, (_, i) => pred(i % 5 < 3 ? "a" : "b", { a: 0.99, b: 0.01 }));
  const raw = ece(ps);
  const t = eceAfterTemperature(ps);
  assert.ok(raw > 0.35);
  assert.ok(t.ece < raw / 2, `${t.ece} should be well under ${raw}`);
  assert.ok(t.temperature > 1);
});

test("percentile uses nearest-rank and ignores missing values", () => {
  assert.equal(percentile([5, 1, 3, NaN], 0.5), 3);
  assert.equal(percentile([], 0.5), null);
});

test("scoreSet sums metered cost and scales it per thousand", () => {
  const ps = [pred("a", { a: 0.9, b: 0.1 }, { costUsd: 0.0002, latencyMs: 400 }), pred("b", { a: 0.2, b: 0.8 }, { costUsd: 0.0004, latencyMs: 600 })];
  const s = scoreSet(ps, ["a", "b"]);
  close(s.costUsd, 0.0006);
  close(s.costPer1000Usd, 0.3);
  assert.equal(s.latencyP50Ms, 400);
  assert.equal(s.confusion.a.a, 1);
});

test("an unmetered local model reports null cost, not zero", () => {
  const s = scoreSet([pred("a", { a: 1, b: 0 }, { costUsd: null })], ["a", "b"]);
  assert.equal(s.costUsd, null);
  assert.equal(s.costPer1000Usd, null);
});
