import assert from "node:assert/strict";
import test from "node:test";
import {
  countServices,
  isAdopted,
  needsAttention,
  serviceState,
} from "../src/lib/service-state.ts";

const svc = (status, healthy, owner = "manager") => ({ status, healthy, owner });

test("serviceState: running and answering is ready", () => {
  assert.equal(serviceState(svc("running", true)), "ready");
});

test("serviceState: running without answering wants attention", () => {
  assert.equal(serviceState(svc("running", false)), "attention");
});

test("serviceState: failed wants attention even when a stale healthy flag lingers", () => {
  assert.equal(serviceState(svc("failed", true)), "attention");
  assert.equal(serviceState(svc("failed", false)), "attention");
});

test("serviceState: stopped is on demand, not a fault", () => {
  assert.equal(serviceState(svc("stopped", false)), "ondemand");
});

test("who started it does not decide whether it is working", () => {
  const external = svc("running", true, "external");
  assert.equal(serviceState(external), "ready");
  assert.equal(needsAttention(external), false);
  assert.equal(isAdopted(external), true);
});

test("an adopted process that stops answering still wants attention", () => {
  const wedged = svc("running", false, "external");
  assert.equal(serviceState(wedged), "attention");
  assert.equal(isAdopted(wedged), true);
});

test("a stopped service is never reported as adopted", () => {
  assert.equal(isAdopted(svc("stopped", false, "external")), false);
});

test("a missing owner is treated as manager-owned, not adopted", () => {
  assert.equal(isAdopted({ status: "running", healthy: true }), false);
  assert.equal(serviceState({ status: "running", healthy: true }), "ready");
});

test("the buckets always sum to the number of services", () => {
  const services = [
    svc("running", true),
    svc("running", true, "external"),
    svc("running", false),
    svc("failed", false),
    svc("stopped", false),
    svc("stopped", false, "external"),
  ];
  const counts = countServices(services);
  assert.equal(
    counts.ready + counts.attention + counts.ondemand,
    services.length,
  );
  assert.deepEqual(counts, {
    ready: 2,
    attention: 2,
    ondemand: 2,
    adopted: 1,
  });
});

test("the live shape that reported 15 services across 14 now balances", () => {
  const running = ["webui", "grafana", "prometheus", "ai-router", "manager"].map(
    () => svc("running", true),
  );
  const ollama = svc("running", true, "external");
  const stopped = Array.from({ length: 8 }, () => svc("stopped", false));
  const services = [...running, ollama, ...stopped];
  const counts = countServices(services);
  assert.equal(services.length, 14);
  assert.equal(counts.ready, 6);
  assert.equal(counts.ondemand, 8);
  assert.equal(counts.attention, 0);
  assert.equal(counts.adopted, 1);
  assert.equal(counts.ready + counts.attention + counts.ondemand, 14);
});

test("every state is one of the three, for any input shape", () => {
  for (const status of ["running", "stopped", "failed", "starting", "unknown"])
    for (const healthy of [true, false])
      for (const owner of ["manager", "external", null]) {
        const state = serviceState({ status, healthy, owner });
        assert.ok(["ready", "attention", "ondemand"].includes(state));
      }
});
