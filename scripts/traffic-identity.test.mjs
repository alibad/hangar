import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import ts from "typescript";

const nativeRequire = createRequire(import.meta.url);
async function load(file, dependencies = {}) {
  const source = await readFile(new URL(`../src/${file}`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  new Function("require", "exports", compiled)(name => name in dependencies ? dependencies[name] : nativeRequire(name), exports);
  return exports;
}
const identity = await load("lib/traffic-identity.ts");
const event = { ts: 1792141690566, service: "console", method: "GET", path: "/api/forge", status: null, ms: null, ip: null, source: "live" };

test("same-millisecond legacy calls and log lines get distinct keys before filtering", () => {
  const calls = identity.keyTrafficEvents([event, { ...event, status: 503 }, event, { ...event, ts: null, source: "log" }, { ...event, ts: null, source: "log" }]);
  assert.equal(new Set(calls.map(e => e.uiKey)).size, calls.length);
  const selected = calls[1].uiKey;
  assert.equal(calls.filter(e => e.status === 503)[0].uiKey, selected);
  assert.equal(calls.toReversed().find(e => e.uiKey === selected).status, 503);
  assert.deepEqual(identity.keyTrafficEvents([event, { ...event, status: 503 }, event]).map(e => e.uiKey), calls.slice(0, 3).map(e => e.uiKey));
});

test("request IDs survive completion changes; repeated IDs across streams remain renderable", () => {
  const pending = { ...event, rid: "request-a", pending: true };
  const complete = { ...pending, pending: false, status: 200, ms: 25 };
  assert.equal(identity.keyTrafficEvents([pending])[0].uiKey, identity.keyTrafficEvents([complete])[0].uiKey);
  assert.equal(new Set(identity.keyTrafficEvents([pending, complete]).map(e => e.uiKey)).size, 2);
});

test("history merges by request identity, preserving simultaneous calls and live state", () => {
  const live = { ...event, rid: "a", pending: true };
  const stored = [{ ...event, rid: "a", ts: event.ts + 100, status: 200 }, { ...event, rid: "b", status: 500 }, { ...event, rid: "c", service: "qwen" }];
  const merged = identity.mergeTrafficHistory([live], stored);
  assert.equal(merged.length, 3);
  assert.equal(merged.find(e => e.rid === "a"), live);
  assert.equal(merged.find(e => e.rid === "b").status, 500);
});

test("traffic ingestion gives ID-less calls unique IDs and preserves producer IDs", async () => {
  const recorded = [], persisted = [];
  const route = await load("app/api/traffic/route.ts", {
    "next/server": { NextResponse: { json: body => body } },
    "@/lib/traffic-identity": identity,
    "@/lib/traffic": { record: e => recorded.push(e) },
    "@/lib/router-usage": { recordRouterCall: async () => {} },
    "@/lib/traffic-store": { recordTrafficEvent: async e => persisted.push(e) },
  });
  for (const input of [event, event, { ...event, rid: "producer-id", pending: true }, { ...event, rid: "producer-id", status: 200 }]) {
    assert.deepEqual(await route.POST({ json: async () => input }), { ok: true });
  }
  assert.ok(recorded[0].rid);
  assert.notEqual(recorded[0].rid, recorded[1].rid);
  assert.equal(recorded[2].rid, recorded[3].rid);
  assert.deepEqual(recorded.map(e => e.rid), persisted.map(e => e.rid));
});

test("durable history restores the original request ID without changing legacy records", async () => {
  const writes = [];
  const store = await load("lib/traffic-store.ts", {
    "./traffic": { isNoise: () => false },
    "./db": { getDb: async () => ({ run: async (...args) => writes.push(args), all: async () => [
      { ...event, key: "rid:original-id", tokens_in: 1, tokens_out: 2 },
      { ...event, key: "syn:old-record", tokens_in: null, tokens_out: null },
    ] }) },
  });
  await store.recordTrafficEvent({ ...event, rid: "original-id" });
  assert.equal(writes.at(-1)[1][0], "rid:original-id");
  const rows = await store.readStoredTraffic();
  assert.equal(rows[0].rid, "original-id");
  assert.equal(rows[1].rid, null);
  assert.equal(rows.length, 2);
});
