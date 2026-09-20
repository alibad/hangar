import { getHost } from "./host";

export type ServiceEntry = {
  id: string;
  name: string;
  localPort: number;
  localUrl: string;
  publicUrl: string;
  healthPath: string;
  category: "ai" | "monitoring" | "app";
  authRequired: boolean;
  /**
   * Never leaves this box. `getServiceUrl()` returns `localUrl` for these even
   * when running on Vercel, so a deployed build physically cannot route to it.
   * Set for the AI Router: cloud projects must call vendor APIs directly and
   * must never be pointed at a local gateway.
   */
  localOnly?: boolean;
  /** Present on OpenAI-compatible LLM services — `model` is the served-model-name
   *  to send in /v1/chat/completions. Marks a service as selectable in the LLM picker. */
  llm?: { model: string };
  /**
   * What this service can serve, as capability id → served-model-name.
   *
   * The console used to answer "which service does speech-to-text" by looking
   * for a service literally called `whisper`, which is the same class of
   * mistake as sizing a model by its name: it encodes today's choice as the
   * definition of the capability. Rename the service, or put a better ASR
   * model behind it, and the Speech tab reports itself unavailable on a box
   * that transcribes perfectly well.
   *
   * Capability ids are the ones in CAPABILITIES (text, vision, image, stt,
   * tts, embedding, video). The value is what to send as `model` when calling the service
   * directly, which is what makes a fallback possible without naming a
   * service in code.
   *
   * Overlaps `llm.model` for chat services, deliberately and narrowly: `llm`
   * also marks a service as selectable in the LLM picker, which is behaviour
   * this does not replace. Where a service declares both they must agree —
   * scripts/host-profiles.test.mjs fails the build if they do not.
   */
  serves?: Record<string, string>;
  /**
   * Path serving Prometheus-format counters, when this service publishes any.
   *
   * Declared rather than inferred, for the same reason as `serves`: /api/metrics
   * used to ask `getServiceUrl("vllm")` directly, so on any host without a
   * service literally called `vllm` — which is every host but one — the route
   * threw "Unknown service" and answered 502 on every page load. Naming the
   * capability instead means a host that publishes counters from something else
   * works, and a host that publishes none says so instead of erroring.
   *
   * Only vLLM does today. Ollama publishes no counters, which is a fact about
   * Ollama and not a failure.
   */
  metricsPath?: string;
  /** Free-text rationale carried from the host profile. Documentation, not behaviour. */
  note?: string;
};

/**
 * The services on THIS host.
 *
 * Used to be a literal array here, with a second hand-copied list inside
 * scripts/manager.cjs that had already drifted from it. Both now read the same
 * config/hosts/<id>.json, selected by src/lib/host.ts. Add a service by editing
 * the profile; nothing in this file changes per host.
 */
export const SERVICE_REGISTRY: ServiceEntry[] = getHost().services;

/**
 * Server-side: detect if we're running locally (not on Vercel).
 * On Vercel, VERCEL=1 is set. Locally, it's absent.
 */
export function isLocalServer(): boolean {
  return !process.env.VERCEL;
}

/**
 * Get the base URL for a service, choosing local or public based on environment.
 */
export function getServiceUrl(id: string): string {
  const svc = SERVICE_REGISTRY.find((s) => s.id === id);
  if (!svc) throw new Error(`Unknown service: ${id}`);
  // localOnly services have no off-box address by design — never hand out a
  // public one, even from a deployed build.
  if (svc.localOnly) return svc.localUrl;
  return isLocalServer() ? svc.localUrl : svc.publicUrl;
}

/**
 * Whether CF Access headers are needed for a service in current environment.
 * Locally we go direct — no CF Access needed.
 */
export function needsCfAuth(id: string): boolean {
  const svc = SERVICE_REGISTRY.find((s) => s.id === id);
  if (!svc) return false;
  return svc.authRequired && !isLocalServer();
}

/**
 * Build headers for a service request, adding CF Access if needed.
 */
export function getServiceHeaders(id: string, extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  if (needsCfAuth(id)) {
    headers["CF-Access-Client-Id"] = process.env.CF_ACCESS_CLIENT_ID!;
    headers["CF-Access-Client-Secret"] = process.env.CF_ACCESS_CLIENT_SECRET!;
  }
  return headers;
}

/** Resolve the supervisor on-box locally and through its tunnel when hosted. */
export function getManagerUrl(): string {
  return process.env.MANAGER_URL?.trim() || getServiceUrl("manager");
}

export function getManagerHeaders(extra?: Record<string, string>): Record<string, string> {
  return getServiceHeaders("manager", extra);
}
