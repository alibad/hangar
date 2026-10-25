import test from "node:test";
import assert from "node:assert/strict";
import { timelinePeriods } from "../src/lib/project-timeline.ts";

const chapter = (month, count) => ({ month, count, themes: ["feat"], highlights: [] });
const data = (chapters, tags = []) => ({ chapters, tags, commits: chapters.reduce((sum, c) => sum + c.count, 0), truncated: false, basis: "Local Git" });

test("visual history is chronological and represents quiet months, not compressed gaps", () => {
  const { periods } = timelinePeriods(data([chapter("2026-10", 6), chapter("2026-08", 40)], [{ name: "v1", at: "2026-09-12T10:00:00Z" }]));
  assert.deepEqual(periods.map(p => [p.id, p.count]), [["2026-08", 40], ["2026-09", 0], ["2026-10", 6]]);
  assert.equal(periods[1].tags[0].name, "v1");
});

test("long histories remain bounded while retaining counts and tags", () => {
  const { periods, monthsPerPeriod } = timelinePeriods(data([chapter("2000-01", 10), chapter("2026-12", 2)], [{ name: "early", at: "1999-12-31T00:00:00Z" }]));
  assert.ok(periods.length <= 120);
  assert.ok(monthsPerPeriod > 1);
  assert.equal(periods.reduce((sum, p) => sum + p.count, 0), 12);
  assert.equal(periods[0].tags[0].name, "early");
  assert.equal(periods.at(-1).end, "2026-12");
});

test("empty and invalid dated evidence cannot create a phantom timeline", () => {
  assert.deepEqual(timelinePeriods(data([])).periods, []);
  assert.deepEqual(timelinePeriods(data([chapter("2026-99", 2)], [{ name: "bad", at: "unknown" }])).periods, []);
});

test("period highlights are newest first, deduplicated and capped", () => {
  const c = chapter("2026-10", 10);
  c.highlights = Array.from({length:10}, (_, i) => ({sha: String(i), at:`2026-10-${String(i+1).padStart(2,'0')}T00:00:00Z`, subject:'fix: sample'}));
  const { periods } = timelinePeriods(data([c]));
  assert.equal(periods[0].highlights.length, 8);
  assert.equal(periods[0].highlights[0].sha, "9");
  assert.equal(c.highlights[0].sha, "0");
});
