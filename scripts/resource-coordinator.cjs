"use strict";

const crypto = require("crypto");

const GB = 1024 ** 3;
const round = (value) => Math.round((Number(value) || 0) * 100) / 100;
const resources = (value = {}) => ({ ramGb: Number(value.ramGb) || 0, vramGb: Number(value.vramGb) || 0 });
const maxResources = (a, b) => ({ ramGb: Math.max(a.ramGb, b.ramGb), vramGb: Math.max(a.vramGb, b.vramGb) });

class ResourceAdmissionError extends Error {
  constructor(message, code = "resource-blocked", details = {}) {
    super(message);
    this.name = "ResourceAdmissionError";
    this.code = code;
    this.details = details;
  }
}

/** Resolve measured model footprints into the policy without duplicating numbers. */
function buildResourceProfiles(policy, modelMeta) {
  const modelResources = (model, resident) => {
    const fp = modelMeta?.[model]?.footprint || {};
    if (!resident) return resources(fp);
    return resources({
      ramGb: fp.idleRamGb ?? fp.ramGb,
      vramGb: fp.idleVramGb ?? fp.vramGb,
    });
  };

  const services = {};
  for (const [id, entry] of Object.entries(policy.services || {})) {
    services[id] = { resident: entry.model ? modelResources(entry.model, true) : resources() };
  }

  const workloads = {};
  for (const [id, entry] of Object.entries(policy.workloads || {})) {
    workloads[id] = {
      serviceId: entry.service || null,
      slot: entry.slot || null,
      peak: entry.model ? modelResources(entry.model, false) : resources(),
      defaultTtlMs: Number(entry.ttlMs) || 15 * 60 * 1000,
      aliases: Array.isArray(entry.aliases) ? entry.aliases : [],
    };
  }

  return {
    budgets: {
      ramSafetyGb: Number(policy.budgets?.ramSafetyGb) || 0,
      vramSafetyGb: Number(policy.budgets?.vramSafetyGb) || 0,
    },
    services,
    workloads,
  };
}

class ResourceCoordinator {
  constructor({ profiles, capacityProvider, clock = () => Date.now(), idFactory = () => crypto.randomUUID() }) {
    this.profiles = profiles;
    this.capacityProvider = capacityProvider;
    this.clock = clock;
    this.idFactory = idFactory;
    this.activeServices = new Set();
    this.startReservations = new Map();
    this.leases = new Map();
    this.pending = [];
    this.sequence = 0;
    this.draining = false;
    this.drainAgain = false;
    this.lastEvent = null;
  }

  setActiveServices(ids) {
    this.activeServices = new Set(ids);
    this.poke();
  }

  markServiceActive(serviceId, active = true) {
    if (active) this.activeServices.add(serviceId);
    else this.activeServices.delete(serviceId);
    this.poke();
  }

  _serviceUsage({ candidateLease = null, candidateStart = null } = {}) {
    const byService = new Map();
    const apply = (serviceId, value) => {
      if (!serviceId) return;
      byService.set(serviceId, maxResources(byService.get(serviceId) || resources(), resources(value)));
    };

    for (const serviceId of this.activeServices) apply(serviceId, this.profiles.services[serviceId]?.resident);
    for (const reservation of this.startReservations.values()) apply(reservation.serviceId, this.profiles.services[reservation.serviceId]?.resident);
    if (candidateStart) apply(candidateStart, this.profiles.services[candidateStart]?.resident);

    for (const lease of this.leases.values()) apply(lease.serviceId, lease.resources);
    if (candidateLease) apply(candidateLease.serviceId, candidateLease.resources);

    let ramGb = 0;
    let vramGb = 0;
    for (const value of byService.values()) {
      ramGb += value.ramGb;
      vramGb += value.vramGb;
    }
    return { ramGb: round(ramGb), vramGb: round(vramGb), byService };
  }

  async _capacity() {
    const value = await this.capacityProvider();
    return {
      ram: {
        totalGb: round(value?.ram?.totalGb ?? 0),
        freeGb: round(value?.ram?.freeGb ?? 0),
      },
      vram: {
        totalGb: round(value?.vram?.totalGb ?? 0),
        freeGb: round(value?.vram?.freeGb ?? 0),
      },
      sampledAt: value?.sampledAt || this.clock(),
    };
  }

  _capacityDenial(current, next, capacity) {
    const budgets = this.profiles.budgets;
    const checks = [
      ["RAM", "ramGb", capacity.ram, budgets.ramSafetyGb],
      ["VRAM", "vramGb", capacity.vram, budgets.vramSafetyGb],
    ];
    const reasons = [];
    for (const [label, key, available, safety] of checks) {
      if (!available.totalGb) continue;
      if (next[key] + safety > available.totalGb + 0.001) {
        reasons.push(`${label} model requires ${round(next[key] + safety)} GB including safety, but capacity is ${available.totalGb} GB`);
      }
      const delta = Math.max(0, next[key] - current[key]);
      if (delta + safety > available.freeGb + 0.001) {
        reasons.push(`${label} needs ${round(delta)} GB more plus ${safety} GB safety, but only ${available.freeGb} GB is currently free`);
      }
    }
    if (!reasons.length) return null;
    const consumers = [...next.byService.entries()]
      .filter(([, value]) => value.ramGb || value.vramGb)
      .map(([serviceId, value]) => ({ serviceId, ramGb: value.ramGb, vramGb: value.vramGb }))
      .sort((a, b) => (b.vramGb + b.ramGb) - (a.vramGb + a.ramGb));
    return { kind: "capacity", message: reasons.join("; "), reasons, consumers };
  }

  async reserveServiceStart(serviceId, owner = "service-manager") {
    if (this.activeServices.has(serviceId)) return { ok: true, reservationId: null, alreadyActive: true };
    const duplicate = [...this.startReservations.values()].find((item) => item.serviceId === serviceId);
    if (duplicate) {
      const denial = {
        kind: "service-start",
        message: `${serviceId} is already being started by ${duplicate.owner}`,
        reservationId: duplicate.id,
      };
      return { ok: false, error: denial.message, denial };
    }

    const current = this._serviceUsage();
    const next = this._serviceUsage({ candidateStart: serviceId });
    const capacity = await this._capacity();
    const denial = this._capacityDenial(current, next, capacity);
    if (denial) {
      this.lastEvent = { at: this.clock(), type: "service-start-blocked", serviceId, ...denial };
      return { ok: false, error: denial.message, denial, capacity, usage: { ramGb: current.ramGb, vramGb: current.vramGb } };
    }

    const id = this.idFactory();
    this.startReservations.set(id, { id, serviceId, owner, createdAt: this.clock() });
    this.lastEvent = { at: this.clock(), type: "service-start-reserved", serviceId };
    return { ok: true, reservationId: id };
  }

  promoteServiceStart(reservationId, serviceId) {
    if (reservationId) this.startReservations.delete(reservationId);
    this.activeServices.add(serviceId);
    this.lastEvent = { at: this.clock(), type: "service-started", serviceId };
    this.poke();
  }

  releaseServiceStart(reservationId) {
    if (reservationId) this.startReservations.delete(reservationId);
    this.poke();
  }

  _request(workload, options) {
    const profile = this.profiles.workloads[workload];
    if (!profile) throw new ResourceAdmissionError(`Unknown workload "${workload}"`, "unknown-workload", { workload });
    const now = this.clock();
    return {
      id: this.idFactory(),
      workload,
      serviceId: profile.serviceId,
      slot: profile.slot,
      resources: resources(profile.peak),
      owner: String(options.owner || "unknown").slice(0, 160),
      lane: options.lane === "background" ? "background" : "interactive",
      createdAt: now,
      ttlMs: Math.max(1000, Number(options.ttlMs) || profile.defaultTtlMs),
      waitMs: Math.max(0, Number(options.waitMs) || 0),
      sequence: this.sequence++,
      lastDenial: null,
    };
  }

  acquire(workload, options = {}) {
    let request;
    try {
      request = this._request(workload, options);
    } catch (error) {
      return Promise.reject(error);
    }
    if (options.signal?.aborted) {
      return Promise.reject(new ResourceAdmissionError("Resource request was cancelled", "resource-cancelled", { workload }));
    }

    return new Promise((resolve, reject) => {
      request.resolve = resolve;
      request.reject = reject;
      if (request.waitMs > 0) {
        request.timer = setTimeout(() => {
          if (!this._removePending(request.id)) return;
          reject(new ResourceAdmissionError(
            request.lastDenial?.message || `Timed out waiting for ${workload}`,
            "resource-timeout",
            { workload, denial: request.lastDenial }
          ));
        }, request.waitMs);
        request.timer.unref?.();
      }
      if (options.signal) {
        request.abortHandler = () => {
          if (!this._removePending(request.id)) return;
          reject(new ResourceAdmissionError("Resource request was cancelled", "resource-cancelled", { workload }));
        };
        options.signal.addEventListener("abort", request.abortHandler, { once: true });
        request.signal = options.signal;
      }
      this.pending.push(request);
      this.poke();
    });
  }

  _removePending(id) {
    const index = this.pending.findIndex((item) => item.id === id);
    if (index < 0) return false;
    const [request] = this.pending.splice(index, 1);
    this._cleanupRequest(request);
    return true;
  }

  _cleanupRequest(request) {
    if (request.timer) clearTimeout(request.timer);
    if (request.signal && request.abortHandler) request.signal.removeEventListener("abort", request.abortHandler);
  }

  async _denialFor(request) {
    if (request.slot) {
      const holder = [...this.leases.values()].find((lease) => lease.slot === request.slot);
      if (holder) {
        return { kind: "slot", message: `${request.slot} is busy with ${holder.workload} (${holder.owner})`, holder: this._publicLease(holder) };
      }
    }
    const current = this._serviceUsage();
    const next = this._serviceUsage({ candidateLease: request });
    const capacity = await this._capacity();
    return this._capacityDenial(current, next, capacity);
  }

  poke() {
    if (this.draining) {
      this.drainAgain = true;
      return;
    }
    queueMicrotask(() => this._drain().catch((error) => console.error("[resources] queue drain failed:", error)));
  }

  async _drain() {
    if (this.draining) {
      this.drainAgain = true;
      return;
    }
    this.draining = true;
    try {
      do {
        this.drainAgain = false;
        const ordered = [...this.pending].sort((a, b) => {
          const lane = (a.lane === "interactive" ? 0 : 1) - (b.lane === "interactive" ? 0 : 1);
          return lane || a.sequence - b.sequence;
        });
        for (const request of ordered) {
          if (!this.pending.some((item) => item.id === request.id)) continue;
          const denial = await this._denialFor(request);
          if (denial) {
            request.lastDenial = denial;
            continue;
          }
          if (!this._removePending(request.id)) continue;
          const now = this.clock();
          const lease = { ...request, acquiredAt: now, expiresAt: now + request.ttlMs };
          delete lease.resolve;
          delete lease.reject;
          delete lease.timer;
          delete lease.signal;
          delete lease.abortHandler;
          this.leases.set(lease.id, lease);
          this.lastEvent = { at: now, type: "lease-acquired", workload: lease.workload, owner: lease.owner };
          request.resolve(this._publicLease(lease));
        }
      } while (this.drainAgain);
    } finally {
      this.draining = false;
    }
  }

  release(leaseId, reason = "released") {
    const lease = this.leases.get(leaseId);
    if (!lease) return false;
    this.leases.delete(leaseId);
    this.lastEvent = { at: this.clock(), type: "lease-released", workload: lease.workload, owner: lease.owner, reason };
    this.poke();
    return true;
  }

  reapExpired() {
    const now = this.clock();
    let count = 0;
    for (const lease of this.leases.values()) {
      if (lease.expiresAt <= now && this.release(lease.id, "expired")) count += 1;
    }
    return count;
  }

  _publicLease(lease) {
    return {
      id: lease.id,
      workload: lease.workload,
      serviceId: lease.serviceId,
      slot: lease.slot,
      owner: lease.owner,
      lane: lease.lane,
      resources: lease.resources,
      acquiredAt: lease.acquiredAt,
      expiresAt: lease.expiresAt,
    };
  }

  async snapshot() {
    const capacity = await this._capacity();
    const usage = this._serviceUsage();
    return {
      sampledAt: this.clock(),
      budgets: this.profiles.budgets,
      capacity,
      usage: { ramGb: usage.ramGb, vramGb: usage.vramGb },
      activeServices: [...this.activeServices].sort(),
      starts: [...this.startReservations.values()],
      leases: [...this.leases.values()].map((lease) => this._publicLease(lease)),
      queue: this.pending
        .slice()
        .sort((a, b) => a.sequence - b.sequence)
        .map((request) => ({
          id: request.id,
          workload: request.workload,
          owner: request.owner,
          lane: request.lane,
          queuedAt: request.createdAt,
          lastDenial: request.lastDenial,
        })),
      lastEvent: this.lastEvent,
    };
  }
}

module.exports = { GB, ResourceAdmissionError, ResourceCoordinator, buildResourceProfiles };
