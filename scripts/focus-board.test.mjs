import test from "node:test";
import assert from "node:assert/strict";
import { applyFocus, emptyFocus, FocusInputError, isoWeek, lastWeek, MAX_GOALS, normalizeFocus, quarter, weekMonday } from "../src/lib/focus-board.ts";

let n = 0;
const id = () => `g${++n}`;

test("weeks are ISO weeks, Monday to Sunday", () => {
  assert.equal(isoWeek(new Date(2026, 10, 8)), "2026-W45"); // Sunday 8 Nov 2026
  assert.equal(isoWeek(new Date(2026, 10, 9)), "2026-W46"); // the Monday after
  assert.equal(isoWeek(new Date(2027, 0, 1)), "2026-W53"); // a Friday that still belongs to 2026's last week
  assert.equal(lastWeek(new Date(2026, 10, 8)), "2026-W44");
  assert.equal(weekMonday(new Date(2026, 10, 8)).getDate(), 2);
  assert.deepEqual(quarter(new Date(2026, 10, 8)), { label: "Q4 2026", weeksLeft: 8 });
  assert.equal(quarter(new Date(2026, 11, 31, 12)).weeksLeft, 1);
});

test("goals: add, tick off, remove, and no more than the cap", () => {
  let board = applyFocus(emptyFocus(), { action: "add-goal", text: "  RTS AI:\n/play open to everyone " }, id);
  assert.deepEqual(board.goals, [{ id: "g1", text: "RTS AI: /play open to everyone", done: false }]);
  board = applyFocus(board, { action: "update-goal", id: "g1", done: true }, id);
  assert.equal(board.goals[0].done, true);
  assert.throws(() => applyFocus(board, { action: "add-goal", text: "   " }, id), FocusInputError);
  assert.throws(() => applyFocus(board, { action: "add-goal", text: "x".repeat(141) }, id), FocusInputError);
  assert.throws(() => applyFocus(board, { action: "update-goal", id: "nope", done: true }, id), FocusInputError);
  for (let i = 1; i < MAX_GOALS; i++) board = applyFocus(board, { action: "add-goal", text: `Goal ${i}` }, id);
  assert.throws(() => applyFocus(board, { action: "add-goal", text: "one too many" }, id), /most/);
  board = applyFocus(board, { action: "remove-goal", id: "g1" }, id);
  assert.equal(board.goals.length, MAX_GOALS - 1);
});

test("weekly numbers: whole numbers only, and clearing the last one leaves nothing behind", () => {
  const before = emptyFocus();
  let board = applyFocus(before, { action: "set-number", repo: "R_kgDORp4_QQ", week: "2026-W45", metric: "users", value: 120 }, id);
  assert.deepEqual(board.weeks, { R_kgDORp4_QQ: { "2026-W45": { users: 120 } } });
  assert.deepEqual(before.weeks, {}, "the board passed in is not changed");
  for (const value of [-1, 1.5, "12", 1e12]) assert.throws(() => applyFocus(board, { action: "set-number", repo: "R_kgDORp4_QQ", week: "2026-W45", metric: "users", value }, id), FocusInputError);
  assert.throws(() => applyFocus(board, { action: "set-number", repo: "../etc", week: "2026-W45", metric: "users", value: 1 }, id), FocusInputError);
  assert.throws(() => applyFocus(board, { action: "set-number", repo: "R_x", week: "2026-45", metric: "users", value: 1 }, id), FocusInputError);
  assert.throws(() => applyFocus(board, { action: "set-number", repo: "R_x", week: "2026-W45", metric: "revenue", value: 1 }, id), FocusInputError);
  board = applyFocus(board, { action: "set-number", repo: "R_kgDORp4_QQ", week: "2026-W45", metric: "users", value: null }, id);
  assert.deepEqual(board.weeks, {});
  assert.throws(() => applyFocus(board, { action: "delete-everything" }, id), FocusInputError);
});

test("a hand-edited file is read back safely", () => {
  assert.deepEqual(normalizeFocus(null), emptyFocus());
  assert.deepEqual(normalizeFocus({
    goals: [{ id: "ok-1", text: " Ship it ", done: true }, { id: "BAD ID", text: "x" }, { id: "no-text", text: "" }, "junk"],
    weeks: { "R_ok": { "2026-W45": { users: 5, posts: -2, visits: "9", other: 1 }, "not-a-week": { users: 1 } }, "../bad": { "2026-W45": { users: 1 } } },
  }), { goals: [{ id: "ok-1", text: "Ship it", done: true }], weeks: { R_ok: { "2026-W45": { users: 5 } } } });
});
