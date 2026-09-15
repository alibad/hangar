/** One classification of service state, shared by the header, the cockpit and
 * the control centre. These three used to carry their own copies of the same
 * predicates, which drifted: the control centre counted a service as needing
 * attention on rules its own cards did not apply.
 *
 * The three states are mutually exclusive and cover every service, so the
 * buckets always sum to the number of services. They did not before: a healthy
 * service started outside the manager landed in "ready" and "attention" at
 * once, and the dashboard reported 15 services across 14. */
export type ServiceOwner = "manager" | "external" | null;

export type ServiceLike = {
  status: string;
  healthy: boolean;
  owner?: ServiceOwner;
};

export type ServiceState = "ready" | "attention" | "ondemand";

/** Who started it is not a verdict on whether it is working. The manager can
 * stop an adopted process and hands it over on restart, so an externally
 * started service is controllable, not broken. It is reported through
 * `isAdopted` instead, which reads as provenance rather than as a fault. */
export function serviceState(service: ServiceLike): ServiceState {
  if (service.status === "failed") return "attention";
  if (service.status === "running") return service.healthy ? "ready" : "attention";
  return "ondemand";
}

/** Running, but started outside the console rather than by the manager. */
export const isAdopted = (service: ServiceLike) =>
  service.status === "running" && service.owner === "external";

/** Up and answering, whoever started it. */
export const isReady = (service: ServiceLike) => serviceState(service) === "ready";

/** Failed outright, or running without answering its health check. */
export const needsAttention = (service: ServiceLike) =>
  serviceState(service) === "attention";

/** Stopped, and startable on demand. */
export const isOnDemand = (service: ServiceLike) =>
  serviceState(service) === "ondemand";

export type ServiceCounts = {
  ready: number;
  attention: number;
  ondemand: number;
  adopted: number;
};

export function countServices(services: ServiceLike[]): ServiceCounts {
  const counts: ServiceCounts = {
    ready: 0,
    attention: 0,
    ondemand: 0,
    adopted: 0,
  };
  for (const service of services) {
    counts[serviceState(service)]++;
    if (isAdopted(service)) counts.adopted++;
  }
  return counts;
}
