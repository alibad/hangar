import test from "node:test";
import assert from "node:assert/strict";
import { applyFocus, emptyFocus, FocusInputError, isoWeek, lastWeek, MAX_FOCUS, MAX_GOALS, normalizeFocus, quarter, weekMonday } from "../src/lib/focus-board.ts";

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

test("stars: products in the order starred, no repeats, no more than the cap", () => {
  let board = applyFocus(emptyFocus(), { action: "star", product: "rtsai", on: true }, id);
  board = applyFocus(board, { action: "star", product: "rtsai", on: true }, id);
  assert.deepEqual(board.starred, ["rtsai"]);
  for (const p of ["narrate", "hangar", "calendar-clarity", "scribe"]) board = applyFocus(board, { action: "star", product: p, on: true }, id);
  assert.equal(board.starred.length, MAX_FOCUS);
  assert.throws(() => applyFocus(board, { action: "star", product: "queens", on: true }, id), /Unstar one/);
  board = applyFocus(board, { action: "star", product: "narrate", on: false }, id);
  assert.deepEqual(board.starred, ["rtsai", "hangar", "calendar-clarity", "scribe"]);
  assert.throws(() => applyFocus(board, { action: "star", product: "../x", on: true }, id), FocusInputError);
  assert.throws(() => applyFocus(board, { action: "star", product: "rtsai" }, id), FocusInputError);
});

test("goals belong to one product: add, tick off, remove, and a cap per product", () => {
  let board = applyFocus(emptyFocus(), { action: "add-goal", product: "rtsai", text: "  /play open\nto everyone " }, id);
  const first = board.goals[0];
  assert.deepEqual({ ...first, id: "x" }, { id: "x", product: "rtsai", text: "/play open to everyone", done: false });
  board = applyFocus(board, { action: "update-goal", id: first.id, done: true }, id);
  assert.equal(board.goals[0].done, true);
  assert.throws(() => applyFocus(board, { action: "add-goal", product: "rtsai", text: "   " }, id), FocusInputError);
  assert.throws(() => applyFocus(board, { action: "add-goal", product: "rtsai", text: "x".repeat(141) }, id), FocusInputError);
  assert.throws(() => applyFocus(board, { action: "update-goal", id: "nope", done: true }, id), FocusInputError);
  for (let i = 1; i < MAX_GOALS; i++) board = applyFocus(board, { action: "add-goal", product: "rtsai", text: `Goal ${i}` }, id);
  assert.throws(() => applyFocus(board, { action: "add-goal", product: "rtsai", text: "one too many" }, id), /most for one product/);
  board = applyFocus(board, { action: "add-goal", product: "narrate", text: "Another product has its own room" }, id);
  board = applyFocus(board, { action: "remove-goal", id: first.id }, id);
  assert.equal(board.goals.filter(g => g.product === "rtsai").length, MAX_GOALS - 1);
});

test("typed numbers: posts and visits, whole numbers only, and clearing the last one leaves nothing behind", () => {
  const before = emptyFocus();
  let board = applyFocus(before, { action: "set-number", product: "rtsai", week: "2026-W46", metric: "posts", value: 3 }, id);
  assert.deepEqual(board.weeks, { rtsai: { "2026-W46": { posts: 3 } } });
  assert.deepEqual(before.weeks, {}, "the board passed in is not changed");
  for (const value of [-1, 1.5, "12", 1e12]) assert.throws(() => applyFocus(board, { action: "set-number", product: "rtsai", week: "2026-W46", metric: "posts", value }, id), FocusInputError);
  assert.throws(() => applyFocus(board, { action: "set-number", product: "rtsai", week: "2026-46", metric: "posts", value: 1 }, id), FocusInputError);
  assert.throws(() => applyFocus(board, { action: "set-number", product: "rtsai", week: "2026-W46", metric: "users", value: 1 }, id), FocusInputError, "people come from Analytics, not typing");
  board = applyFocus(board, { action: "set-number", product: "rtsai", week: "2026-W46", metric: "posts", value: null }, id);
  assert.deepEqual(board.weeks, {});
  assert.throws(() => applyFocus(board, { action: "delete-everything" }, id), FocusInputError);
});

test("a hand-edited or older file is read back safely", () => {
  assert.deepEqual(normalizeFocus(null), emptyFocus());
  // The first Focus board (8 Nov) kept goals without a product and numbers by repository: none of it carries over.
  assert.deepEqual(normalizeFocus({ goals: [{ id: "old-1", text: "x", done: false }], weeks: { R_kgDORp4_QQ: { "2026-W45": { users: 42 } } } }), emptyFocus());
  assert.deepEqual(normalizeFocus({
    starred: ["rtsai", "rtsai", "../bad", 7, "narrate"],
    goals: [{ id: "ok-1", product: "rtsai", text: " Ship it ", done: true }, { id: "BAD ID", product: "rtsai", text: "x" }, { id: "no-text", product: "rtsai", text: "" }, "junk"],
    weeks: { rtsai: { "2026-W46": { posts: 5, visits: -2, other: 1 }, "not-a-week": { posts: 1 } }, "../bad": { "2026-W46": { posts: 1 } } },
  }), { starred: ["rtsai", "narrate"], goals: [{ id: "ok-1", product: "rtsai", text: "Ship it", done: true }], weeks: { rtsai: { "2026-W46": { posts: 5 } } } });
});
