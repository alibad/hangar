"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { ResourceCoordinator, buildResourceProfiles } = require("./resource-coordinator.cjs");
const productionPolicy = require("../config/resource-policy.json");
const productionModelMeta = require("../config/model-meta.json");

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("live free VRAM admits Qwen beside an overestimated resident footprint", async () => {
  const coordinator = new ResourceCoordinator({
    profiles: buildResourceProfiles(productionPolicy, productionModelMeta),
    capacityProvider: async () => ({ ram: { totalGb: 63.3, freeGb: 25 }, vram: { totalGb: 31.84, freeGb: 22 } }),
  });
  coordinator.setActiveServices(["qwen", "vllm-small"]);
  const lease = await coordinator.acquire("qwen-generate", { waitMs: 1000 });
  assert.equal(lease.workload, "qwen-generate");
  coordinator.release(lease.id);
});

test("a second service start cannot spend the first start's unmaterialized reservation", async () => {
  const coordinator = fixtures({ ram: { totalGb: 64, freeGb: 40 }, vram: { totalGb: 32, freeGb: 32 } });
  const first = await coordinator.reserveServiceStart("qwen");
  assert.equal(first.ok, true);
  coordinator.profiles.services.other = { resident: { ramGb: 28, vramGb: 0.1 } };
  const second = await coordinator.reserveServiceStart("other");
  assert.equal(second.ok, false);
  assert.equal(second.denial.kind, "capacity");
  coordinator.releaseServiceStart(first.reservationId);
});

function fixtures(capacity = { ram: { totalGb: 64, freeGb: 64 }, vram: { totalGb: 32, freeGb: 32 } }) {
  const policy = {
    budgets: { ramSafetyGb: 4, vramSafetyGb: 0.2 },
    services: {
      qwen: { model: "qwen" },
      comfyui: { model: "flux" },
      coder: { model: "coder" },
      sam3: {},
    },
    workloads: {
      qwen: { service: "qwen", model: "qwen", slot: "gpu-heavy", ttlMs: 1000 },
      flux: { service: "comfyui", model: "flux", slot: "gpu-heavy", ttlMs: 1000 },
      segment: { service: "sam3", slot: "gpu-heavy", ttlMs: 1000 },
    },
  };
  const modelMeta = {
    qwen: { footprint: { ramGb: 28, vramGb: 20, idleRamGb: 28, idleVramGb: 0.1 } },
    flux: { footprint: { ramGb: 28, vramGb: 31.7, idleRamGb: 0.1, idleVramGb: 0.1 } },
    coder: { footprint: { ramGb: 1, vramGb: 22.9 } },
  };
  let id = 0;
  return new ResourceCoordinator({
    profiles: buildResourceProfiles(policy, modelMeta),
    capacityProvider: async () => ({ ...capacity, sampledAt: 1 }),
    idFactory: () => `id-${++id}`,
  });
}

test("blocks a service start when live capacity cannot preserve the safety margin", async () => {
  const coordinator = fixtures({
    ram: { totalGb: 64, freeGb: 32 },
    vram: { totalGb: 32, freeGb: 8 },
  });
  coordinator.setActiveServices(["qwen"]);

  const result = await coordinator.reserveServiceStart("coder");

  assert.equal(result.ok, false);
  assert.equal(result.denial.kind, "capacity");
  assert.match(result.error, /VRAM needs/);
  assert.deepEqual(result.denial.consumers.map((item) => item.serviceId), ["qwen", "coder"]);
});

test("blocks a duplicate service start while the first start is reserved", async () => {
  const coordinator = fixtures();
  const first = await coordinator.reserveServiceStart("qwen", "first caller");
  const second = await coordinator.reserveServiceStart("qwen", "second caller");

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.denial.kind, "service-start");
  coordinator.releaseServiceStart(first.reservationId);
});

test("serves the interactive lane before an older background request", async () => {
  const coordinator = fixtures();
  const holder = await coordinator.acquire("segment", { owner: "holder" });
  const order = [];
  const background = coordinator.acquire("flux", { owner: "batch", lane: "background" }).then((lease) => {
    order.push("background");
    return lease;
  });
  const interactive = coordinator.acquire("qwen", { owner: "person", lane: "interactive" }).then((lease) => {
    order.push("interactive");
    return lease;
  });
  await tick();

  coordinator.release(holder.id);
  const first = await interactive;
  assert.deepEqual(order, ["interactive"]);
  coordinator.release(first.id);
  const second = await background;
  assert.deepEqual(order, ["interactive", "background"]);
  coordinator.release(second.id);
});

test("serializes workloads that share the gpu-heavy slot", async () => {
  const coordinator = fixtures();
  const first = await coordinator.acquire("qwen", { owner: "one" });
  let secondAcquired = false;
  const secondPromise = coordinator.acquire("segment", { owner: "two" }).then((lease) => {
    secondAcquired = true;
    return lease;
  });
  await tick();

  assert.equal(secondAcquired, false);
  const snapshot = await coordinator.snapshot();
  assert.equal(snapshot.queue[0].lastDenial.kind, "slot");

  coordinator.release(first.id);
  const second = await secondPromise;
  assert.equal(secondAcquired, true);
  coordinator.release(second.id);
});

test("removes a cancelled request from the queue", async () => {
  const coordinator = fixtures();
  const holder = await coordinator.acquire("segment", { owner: "holder" });
  const abort = new AbortController();
  const queued = coordinator.acquire("qwen", { owner: "cancel-me", signal: abort.signal });
  await tick();

  abort.abort();
  await assert.rejects(queued, (error) => error.code === "resource-cancelled");
  assert.equal((await coordinator.snapshot()).queue.length, 0);
  coordinator.release(holder.id);
});

test("reaps an expired lease and admits the next request", async () => {
  let now = 1000;
  const coordinator = fixtures();
  coordinator.clock = () => now;
  const first = await coordinator.acquire("segment", { owner: "stale", ttlMs: 1000 });
  const secondPromise = coordinator.acquire("qwen", { owner: "next" });
  await tick();

  now = first.expiresAt;
  assert.equal(coordinator.reapExpired(), 1);
  const second = await secondPromise;
  assert.equal(second.owner, "next");
  coordinator.release(second.id);
});

test("a workload peak replaces its service resident footprint instead of double counting it", async () => {
  const coordinator = fixtures();
  coordinator.setActiveServices(["qwen"]);
  const idle = await coordinator.snapshot();
  assert.deepEqual(idle.usage, { ramGb: 28, vramGb: 0.1 });

  const lease = await coordinator.acquire("qwen", { owner: "image" });
  const active = await coordinator.snapshot();
  assert.deepEqual(active.usage, { ramGb: 28, vramGb: 20 });
  coordinator.release(lease.id);
});

test("the production policy still admits measured FLUX peak on the 5090", async () => {
  const coordinator = new ResourceCoordinator({
    profiles: buildResourceProfiles(productionPolicy, productionModelMeta),
    capacityProvider: async () => ({
      ram: { totalGb: 63.3, freeGb: 35 },
      vram: { totalGb: 31.84, freeGb: 31.68 },
    }),
  });
  coordinator.setActiveServices(["qwen", "comfyui"]);

  const lease = await coordinator.acquire("flux-generate", { owner: "measured-card", waitMs: 100 });
  assert.equal(lease.workload, "flux-generate");
  coordinator.release(lease.id);
});
