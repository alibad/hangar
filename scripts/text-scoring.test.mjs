// Unit tests for src/lib/text-scoring.ts.
//
// These pin the Arabic-specific behaviour, which is where the whole library
// earns its keep: every one of these cases produced a wrong number in a naive
// implementation, and a wrong CER is indistinguishable from a bad model.
import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeArabic,
  editDistance,
  cer,
  wer,
  chrF,
  extractJson,
  scoreFields,
  arabicRatio,
} from "../src/lib/text-scoring.ts";

// Written as escapes rather than literals so the expectations stay readable in a
// diff and cannot be silently mangled by an editor's bidi rendering.
const ALEF = "ا";
const BA = "ب";
const HAMZA_ALEF = "أ"; // alef with hamza above
const TA_MARBUTA = "ة";
const HA = "ه";
const YA = "ي";
const ALEF_MAQSURA = "ى";
const FATHA = "َ";
const SHADDA = "ّ";
const TATWEEL = "ـ";
const LAM = "ل";
const LAM_ALEF_LIG = "ﻻ"; // lam-alef presentation ligature

test("normalizeArabic: strict keeps diacritics, normalized strips them", () => {
  const vocalised = BA + FATHA + ALEF + SHADDA;
  assert.equal(normalizeArabic(vocalised, "strict"), vocalised);
  assert.equal(normalizeArabic(vocalised, "normalized"), BA + ALEF);
});

test("normalizeArabic: folds alef variants, ta marbuta, alef maqsura", () => {
  assert.equal(normalizeArabic(HAMZA_ALEF), ALEF);
  assert.equal(normalizeArabic(TA_MARBUTA), HA);
  assert.equal(normalizeArabic(ALEF_MAQSURA), YA);
});

test("normalizeArabic: removes tatweel, which carries no meaning", () => {
  assert.equal(normalizeArabic(BA + TATWEEL + TATWEEL + ALEF), BA + ALEF);
});

test("normalizeArabic: Arabic-Indic and Persian digits fold to ASCII", () => {
  assert.equal(normalizeArabic("١٩٨٤"), "1984");
  assert.equal(normalizeArabic("۱۲۳"), "123");
});

test("normalizeArabic: lam-alef ligature decomposes to two letters", () => {
  // This is the case that makes a rendered fixture comparable to typed output.
  assert.equal(normalizeArabic(LAM_ALEF_LIG), LAM + ALEF);
});

test("normalizeArabic: strips bidi controls and collapses whitespace at both levels", () => {
  assert.equal(normalizeArabic("‫" + BA + "  \n " + ALEF + "‬", "strict"), BA + " " + ALEF);
});

test("editDistance: known values", () => {
  assert.equal(editDistance([..."kitten"], [..."sitting"]), 3);
  assert.equal(editDistance([], [..."abc"]), 3);
  assert.equal(editDistance([..."abc"], []), 3);
  assert.equal(editDistance([..."same"], [..."same"]), 0);
});

test("cer: a perfect unvocalised reading of vocalised text is 0 normalized, high strict", () => {
  const reference = BA + FATHA + ALEF + SHADDA + " " + BA + FATHA + ALEF;
  const hypothesis = BA + ALEF + " " + BA + ALEF;
  assert.equal(cer(reference, hypothesis, "normalized").rate, 0);
  // The gap is the finding: strict must NOT also be 0, or the two levels are
  // reporting the same thing and one of them is decoration.
  assert.ok(cer(reference, hypothesis, "strict").rate > 0.3);
});

test("cer: rate is clamped to 1 when the hypothesis runs away", () => {
  const r = cer(BA, BA + ALEF.repeat(50));
  assert.equal(r.rate, 1);
  assert.ok(r.edits > 1);
});

test("cer/wer: empty reference scores 0 for empty output and 1 otherwise, never NaN", () => {
  assert.equal(cer("", "").rate, 0);
  assert.equal(cer("", BA).rate, 1);
  assert.ok(Number.isFinite(wer("", BA).rate));
});

test("wer: counts word edits, not character edits", () => {
  const ref = [BA + ALEF, BA + ALEF, BA + ALEF].join(" ");
  const hyp = [BA + ALEF, ALEF + BA, BA + ALEF].join(" ");
  const w = wer(ref, hyp);
  assert.equal(w.edits, 1);
  assert.equal(w.refLength, 3);
});

test("chrF: identical strings score 1, disjoint strings score near 0", () => {
  const s = BA + ALEF + HA + YA + LAM;
  assert.equal(chrF(s, s), 1);
  assert.ok(chrF(s, "zzzzz") < 0.05);
});

test("chrF: rewards partial character overlap that word-level BLEU would miss", () => {
  // Same content word, differing only by an attached conjunction (a clitic).
  const ref = "و" + BA + ALEF + LAM + BA + YA + HA;
  const hyp = BA + ALEF + LAM + BA + YA + HA;
  const score = chrF(ref, hyp);
  assert.ok(score > 0.6, `expected partial credit, got ${score}`);
  assert.ok(score < 1);
});

test("chrF: short strings do not get penalised for lacking high-order n-grams", () => {
  // Two characters have no 3..6-grams; skipping those orders must not zero it.
  assert.equal(chrF(BA + ALEF, BA + ALEF), 1);
});

test("extractJson: unwraps fenced and prefixed JSON", () => {
  assert.deepEqual(extractJson('Here you go:\n```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('{"a":1} and some trailing prose'), { a: 1 });
});

test("extractJson: a brace inside a string value does not truncate the object", () => {
  assert.deepEqual(extractJson('{"a":"} not the end","b":2}'), { a: "} not the end", b: 2 });
});

test("extractJson: escaped quote inside a string is handled", () => {
  assert.deepEqual(extractJson('{"a":"say \\" now","b":2}'), { a: 'say " now', b: 2 });
});

test("extractJson: returns null when there is no object or it is malformed", () => {
  assert.equal(extractJson("no json here"), null);
  assert.equal(extractJson('{"a": }'), null);
});

test("scoreFields: values match across digit systems and orthographies", () => {
  const reply = JSON.stringify({ total: "١٢٣", name: HAMZA_ALEF + BA });
  const score = scoreFields(reply, { total: "123", name: ALEF + BA });
  assert.equal(score.accuracy, 1);
  assert.equal(score.parsed, true);
});

test("scoreFields: unparseable reply scores 0 and reports every field as missed", () => {
  const score = scoreFields("sorry, I cannot do that", { a: "1", b: "2" });
  assert.equal(score.parsed, false);
  assert.equal(score.accuracy, 0);
  assert.equal(score.missed.length, 2);
  assert.equal(score.missed[0].got, null);
});

test("scoreFields: a wrong value is missed and carries what was actually returned", () => {
  const score = scoreFields(JSON.stringify({ a: "9" }), { a: "1" });
  assert.equal(score.accuracy, 0);
  assert.equal(score.missed[0].got, "9");
});

test("arabicRatio: separates an Arabic answer from an English one", () => {
  assert.equal(arabicRatio(BA + ALEF + HA), 1);
  assert.equal(arabicRatio("hello"), 0);
  // Digits and punctuation are not letters and must not dilute the ratio.
  assert.equal(arabicRatio(BA + ALEF + " 123 !"), 1);
  assert.equal(arabicRatio(""), 0);
});
