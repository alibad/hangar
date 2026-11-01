import test from "node:test";
import assert from "node:assert/strict";

process.env.TZ = "Asia/Qatar"; // the owner's clock; the layout is in local time
const { dayKey, dayView, defaultDay, windowDays } = await import("../src/lib/project-activity.ts");

// RTSAI-Mod on 26 Oct 2026, as the engine joined it (UTC). Doha is UTC+3.
const utc = (hm, day = 26) => `2026-10-${day}T${hm}+00:00`;
const commit = (short, hm, agent, session, extra = {}) => ({ sha: short.padEnd(40, "0"), short, at: utc(hm), subject: short, files: [], fileCount: 1, agent, trailer: null, session, evidence: session ? "printed" : null, why: "", ...extra });
const DATA = {
  available: true, repo: "R5", name: "RTSAI-Mod", branch: "main", days: 7, from: utc("06:00:00", 25), to: "2026-11-01T06:00:00+00:00", truncated: false, basis: "",
  commits: [
    commit("75ba609", "21:25:58", "claude", "claude:be", { at: utc("21:25:58", 25) }),
    commit("f8c728b", "10:37:06", "codex", "codex:meetup"),
    commit("1bde6ba", "10:52:38", "claude", "claude:be"),
    commit("d53955d", "11:01:11", "codex", "codex:web"),
    commit("c4b7e1f", "11:01:35", "codex", "codex:web"),
    commit("6a5bbff", "11:07:12", "claude", "claude:be"),
    commit("b51c5ef", "11:17:41", "codex", "codex:web"),
  ],
  sessions: [
    { key: "claude:be", provider: "claude", id: "be", title: "OpenRA quality analysis", commits: [], edits: 0, files: [], spans: [{ from: utc("21:25:58", 25), to: utc("21:49:34", 25) }, { from: utc("10:52:38"), to: utc("11:07:12") }] },
    { key: "codex:web", provider: "codex", id: "web", title: "The Web Latest", commits: [], edits: 17, files: [], spans: [{ from: utc("10:36:27"), to: utc("11:17:41") }] },
    { key: "codex:meetup", provider: "codex", id: "meetup", title: "Review meetup", commits: [], edits: 1, files: [], spans: [{ from: utc("10:36:52"), to: utc("10:37:06") }] },
  ],
  overlaps: [{ from: utc("10:36:27"), to: utc("11:17:41"), sessions: ["codex:web", "codex:meetup", "claude:be"], agents: ["claude", "codex"], crossAgent: true, sharedFiles: [] }],
};
const NOW = Date.parse("2026-11-01T06:00:00Z");

test("the week strip counts each agent's commits per local day and opens on the collision", () => {
  const days = windowDays(DATA, NOW);
  assert.deepEqual(days.map(d => d.key), ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"]);
  const oct26 = days[0];
  // 75ba609 was 00:25 on 26 Oct in Doha, though 25 Oct in UTC.
  assert.deepEqual([oct26.claude, oct26.codex, oct26.unknown, oct26.sessions, oct26.overlap, oct26.crossAgent], [3, 4, 0, 3, true, true]);
  assert.equal(days[1].claude + days[1].codex, 0);
  assert.equal(defaultDay(days), "2026-10-26");
  assert.equal(dayKey(Date.parse(utc("21:25:58", 25))), "2026-10-26");
});

test("a day folds its quiet hours and keeps commits in time order inside the overlap", () => {
  const view = dayView(DATA, "2026-10-26");
  assert.equal(view.segments.length, 2, "the 00:25 stretch and the 13:36 stretch, with the quiet morning folded");
  assert.equal(view.breaks.length, 1);
  assert.ok(view.breaks[0].minutes > 600);
  const [claude, codex] = view.lanes;
  assert.deepEqual([claude.agent, codex.agent], ["claude", "codex"]);
  assert.deepEqual(claude.rows.map(r => r.session.title), ["OpenRA quality analysis"]);
  assert.deepEqual(codex.rows.map(r => r.session.title), ["The Web Latest", "Review meetup"]);
  const dots = view.lanes.flatMap(l => l.rows.flatMap(r => r.commits)).sort((a, b) => Date.parse(a.commit.at) - Date.parse(b.commit.at));
  for (let i = 1; i < dots.length; i++) assert.ok(dots[i].left >= dots[i - 1].left, `${dots[i].commit.short} is right of ${dots[i - 1].commit.short}`);
  const [band] = view.bands;
  const inside = (short) => { const d = dots.find(x => x.commit.short === short); return d.left >= band.left - 0.01 && d.left <= band.left + band.width + 0.01; };
  for (const short of ["f8c728b", "1bde6ba", "d53955d", "c4b7e1f", "6a5bbff", "b51c5ef"]) assert.ok(inside(short), short);
  assert.ok(!inside("75ba609"));
  assert.ok(view.ticks.length >= 2 && view.ticks.every(t => /^\d\d:\d\d$/.test(t.label)));
  assert.ok(view.segments.at(-1).left + view.segments.at(-1).width <= 100.0001);
});

test("commits with no session sit in their agent's lane, and unknown ones get their own", () => {
  const data = { ...DATA, sessions: [], overlaps: [], commits: [commit("aaaa111", "09:00:00", "unknown", null), commit("bbbb222", "09:30:00", "claude", null, { trailer: "claude" })] };
  const view = dayView(data, "2026-10-26");
  assert.deepEqual(view.lanes.map(l => [l.agent, l.rows.length]), [["claude", 1], ["codex", 0], ["unknown", 1]]);
  assert.equal(view.lanes[0].rows[0].session, null);
  assert.equal(view.lanes[0].rows[0].bars.length, 0);
  const empty = dayView({ ...DATA, commits: [], sessions: [], overlaps: [] }, "2026-10-27");
  assert.deepEqual([empty.segments.length, empty.bands.length, empty.x(Date.now())], [0, 0, 0]);
  assert.deepEqual(empty.lanes.map(l => l.agent), ["claude", "codex"]);
});
