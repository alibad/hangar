import policyJson from "../../config/resource-policy.json";

const MANAGER_URL = process.env.MANAGER_URL ?? "http://localhost:8099";

type Lane = "interactive" | "background";
type Policy = {
  workloads: Record<string, { aliases?: string[]; ttlMs?: number }>;
};

const policy = policyJson as Policy;

export type ResourceLease = {
  id: string;
  workload: string;
  serviceId: string | null;
  slot: string | null;
  owner: string;
  lane: Lane;
  resources: { ramGb: number; vramGb: number };
  acquiredAt: number;
  expiresAt: number;
};

export class ResourceLeaseError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(message: string, status: number, code = "resource-manager-error", details?: unknown) {
    super(message);
    this.name = "ResourceLeaseError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function workloadForImageModel(model: string | undefined): string | null {
  if (!model) return null;
  for (const [workload, entry] of Object.entries(policy.workloads)) {
    if (entry.aliases?.includes(model)) return workload;
  }
  return null;
}

async function acquireResourceLease(
  workload: string,
  options: { owner: string; lane?: Lane; waitMs?: number; ttlMs?: number; signal?: AbortSignal },
): Promise<ResourceLease> {
  let response: Response;
  try {
    response = await fetch(`${MANAGER_URL}/resources/leases/acquire`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workload,
        owner: options.owner,
        lane: options.lane ?? "interactive",
        waitMs: options.waitMs ?? (options.lane === "background" ? 0 : 15 * 60 * 1000),
        ttlMs: options.ttlMs,
      }),
      cache: "no-store",
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new ResourceLeaseError(
      `Resource manager unavailable: ${error instanceof Error ? error.message : String(error)}`,
      503,
      "resource-manager-unavailable",
    );
  }

  const body = await response.json().catch(() => ({})) as {
    error?: string;
    code?: string;
    details?: unknown;
    lease?: ResourceLease;
  };
  if (!response.ok || !body.lease) {
    throw new ResourceLeaseError(
      body.error || `Resource manager returned ${response.status}`,
      response.status === 499 ? 409 : response.status,
      body.code,
      body.details,
    );
  }
  return body.lease;
}

async function releaseResourceLease(id: string): Promise<void> {
  try {
    await fetch(`${MANAGER_URL}/resources/leases/${encodeURIComponent(id)}/release`, {
      method: "POST",
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    // TTL reaping is the backstop. Do not replace a successful generation with
    // a cleanup failure, but leave a useful server-side breadcrumb.
    console.warn(`[resources] failed to release lease ${id}:`, error);
  }
}

export async function withResourceLease<T>(
  workload: string,
  options: { owner: string; lane?: Lane; waitMs?: number; ttlMs?: number; signal?: AbortSignal },
  run: () => Promise<T>,
): Promise<T> {
  const lease = await acquireResourceLease(workload, options);
  try {
    return await run();
  } finally {
    await releaseResourceLease(lease.id);
  }
}
