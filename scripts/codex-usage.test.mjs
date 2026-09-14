import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  appendFile,
  rename,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCodexReader,
  newParserState,
  ingestCodexRecord,
  dedupeCodexEvents,
} from "../src/lib/codex-usage.ts";
import { estimateCodexCost } from "../src/lib/codex-pricing.ts";
import {
  filterUsage,
  sumUsage,
  groupUsage,
} from "../src/lib/assistant-usage-data.ts";

const meta = {
  type: "session_meta",
  payload: { id: "task-1", cwd: "C:/Code/Project" },
};
const context = (model) => ({ type: "turn_context", payload: { model } });
const usage = (
  input,
  output,
  cached = 0,
  reasoning = 0,
  timestamp = "2026-09-12T10:00:00Z",
) => ({
  timestamp,
  type: "event_msg",
  payload: {
    type: "token_count",
    info: {
      total_token_usage: {
        input_tokens: input,
        output_tokens: output,
        cached_input_tokens: cached,
        reasoning_output_tokens: reasoning,
      },
    },
  },
});
const lines = (...records) =>
  records.map((r) => JSON.stringify(r)).join("\n") + "\n";

test("cumulative checkpoints become deltas; repeated usage and rate-limit-only events add nothing", () => {
  const state = newParserState();
  for (const record of [
    meta,
    context("gpt-5.5"),
    usage(1000, 100, 600, 40),
    usage(1000, 100, 600, 40),
    { type: "event_msg", payload: { type: "token_count", info: null } },
    context("gpt-6-astra"),
    usage(2500, 250, 1600, 100, "2026-09-12T10:01:00Z"),
  ])
    ingestCodexRecord(state, record);
  assert.equal(state.events.length, 2);
  assert.equal(state.events[1].input, 1500);
  assert.equal(state.events[1].output, 150);
  assert.equal(state.events[1].cached, 1000);
  assert.equal(state.events[1].reasoning, 60);
  assert.equal(state.events[0].model, "gpt-5.5");
  assert.equal(state.events[1].model, "gpt-6-astra");
  assert.equal(
    state.events.reduce((n, e) => n + e.input + e.output, 0),
    2750,
  );
});

test("counter reset starts a new segment and copied fork history is deduplicated", () => {
  const state = newParserState();
  ingestCodexRecord(state, usage(1000, 100));
  const reset = usage(50, 10, 0, 0, "2026-09-12T11:00:00Z");
  reset.payload.info.last_token_usage = reset.payload.info.total_token_usage;
  ingestCodexRecord(state, reset);
  assert.equal(state.events[1].input, 50);
  assert.equal(state.resets, 1);
  assert.equal(
    dedupeCodexEvents([
      ...state.events,
      ...state.events.map((e) => ({ ...e, session: "fork" })),
    ]).length,
    2,
  );
});

test("GPT pricing charges cache once, output includes reasoning, unknown models remain unpriced", () => {
  assert.equal(
    estimateCodexCost({
      model: "gpt-5.5",
      input: 1000000,
      cached: 600000,
      cacheWrite: 0,
      output: 100000,
    }),
    5.3,
  );
  assert.equal(
    estimateCodexCost({
      model: "gpt-6-astra",
      input: 1000000,
      cached: 500000,
      cacheWrite: 100000,
      output: 100000,
    }),
    10.75,
  );
  assert.equal(
    estimateCodexCost({
      model: "codex-auto-review",
      input: 100,
      cached: 0,
      cacheWrite: 0,
      output: 10,
    }),
    null,
  );
});

test("incremental reader handles incomplete lines, restart cache, archive moves and truncation", async () => {
  const root = await mkdtemp(join(tmpdir(), "betenshi-codex-usage-"));
  try {
    await mkdir(join(root, "sessions"));
    await mkdir(join(root, "archived_sessions"));
    const path = join(root, "sessions", "rollout.jsonl");
    const cache = join(root, "cache.json");
    await writeFile(
      path,
      lines(meta, context("gpt-5.5"), usage(1000, 100, 600, 40)),
    );
    const read = createCodexReader(root, cache);
    assert.equal((await read()).events.length, 1);
    assert.equal((await read()).bytesRead, 0);
    const next = JSON.stringify(
      usage(2500, 250, 1500, 80, "2026-09-12T10:01:00Z"),
    );
    await appendFile(path, next.slice(0, 80));
    assert.equal((await read()).events.length, 1);
    await appendFile(path, next.slice(80) + "\n");
    assert.equal((await read()).events[1].input, 1500);
    const restarted = createCodexReader(root, cache);
    assert.equal((await restarted()).bytesRead, 0);
    const archived = join(root, "archived_sessions", "rollout.jsonl");
    await rename(path, archived);
    assert.equal((await restarted()).events.length, 2);
    await writeFile(archived, lines(meta, context("gpt-5.5"), usage(20, 2)));
    const rebuilt = await restarted();
    assert.equal(rebuilt.events.length, 1);
    assert.equal(rebuilt.events[0].input, 20);
    assert.deepEqual(rebuilt.warnings, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one source/date/model selection drives identical KPI, daily and model totals", () => {
  const row = {
    source: "codex",
    day: "2026-09-12",
    model: "gpt-5.5",
    project: "AI",
    session: "task",
    input: 100,
    cached: 60,
    cacheWrite: 0,
    output: 10,
    reasoning: 5,
    totalTokens: 110,
    calls: 1,
    estimatedCost: 0.001,
    unpricedTokens: 0,
    last: 1,
  };
  const rows = [
    row,
    { ...row, day: "2026-09-11" },
    { ...row, source: "claude" },
  ];
  const filtered = filterUsage(rows, {
    source: "codex",
    from: "2026-09-12",
    to: "2026-09-12",
    model: "gpt-5.5",
  });
  assert.equal(filtered.length, 1);
  assert.equal(sumUsage(filtered).totalTokens, 110);
  assert.equal(groupUsage(filtered, "day")[0].totalTokens, 110);
  assert.equal(groupUsage(filtered, "model")[0].totalTokens, 110);
});
