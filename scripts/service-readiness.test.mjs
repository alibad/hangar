import assert from "node:assert/strict";
import test from "node:test";
import { serviceBodyReady } from "../src/lib/service-readiness.ts";

test("a live model server is unavailable until its model is ready", () => {
  assert.equal(serviceBodyReady({ status: "loading", ready: false }), false);
  assert.equal(serviceBodyReady({ status: "ok", ready: false }), false);
  assert.equal(serviceBodyReady({ status: "error", error: "load failed" }), false);
  assert.equal(serviceBodyReady({ ok: false }), false);
  assert.equal(serviceBodyReady({ status: "ok", ready: true }), true);
});

test("services with opaque or statistics-only health keep HTTP-only readiness", () => {
  assert.equal(serviceBodyReady(null), true);
  assert.equal(serviceBodyReady("OK"), true);
  assert.equal(serviceBodyReady({ system: {}, devices: [] }), true);
  assert.equal(serviceBodyReady({ status: "ok" }), true);
});
