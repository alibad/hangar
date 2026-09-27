/**
 * Shapes shared by the Lab shell (browser) and the Lab API routes (server).
 * Types only, so either side can import it without pulling the other's modules.
 */

export type LabFootprint = {
  vramGb?: number;
  ramGb?: number;
  idleVramGb?: number;
  idleRamGb?: number;
  kind?: "reserved" | "peak" | "estimate";
  basis?: string;
};

/** One model a Lab can run, on this host. */
export type LabModel = {
  /** Router alias, or the served-model-name for a service the router does not know. */
  id: string;
  local: boolean;
  /** Where the model came from: the router catalogue, or a host service's `serves`. */
  source: "router" | "service";
  /** Backing service on this host, for local models — what Start/Stop acts on. */
  serviceId?: string;
  serviceName?: string;
  status: "ready" | "no-key" | "service-stopped" | "router-offline";
  detail?: string;
  /** For on-demand runtimes (Ollama): resident right now. */
  loaded?: boolean;
  /**
   * Listed only as a comparison target: drawn from the Lab's compareCapability
   * (an LLM beside a decision model), not from the Lab's own capability.
   */
  compare?: boolean;
  params?: string;
  checkpoint?: string;
  license?: string;
  docs?: string;
  footprint?: LabFootprint;
  costPerMTokIn?: number;
  costPerMTokOut?: number;
  costPerImage?: number;
};

export type LabModelsPayload = {
  capability: string;
  host: { id: string; name: string; memoryKind: "discrete" | "unified" };
  routerUp: boolean;
  /**
   * The model the router's routing sends this capability to (Models tab), when
   * the capability is routable. The shell's default cloud comparison when it is
   * a cloud model — the one you would otherwise be using, not an arbitrary one.
   */
  routed?: string;
  models: LabModel[];
};

/** What a Lab's run() resolves to, success or not. The shell renders the numbers. */
export type LabRunResult<TOutput = unknown> = {
  ok: boolean;
  model: string;
  local: boolean;
  error?: string;
  /** The coordinator refused for capacity — a remedy, not a bug. */
  resourceBlocked?: boolean;
  output?: TOutput;
  runId?: string | null;
  latencyMs?: number | null;
  peakVramGb?: number | null;
  baselineVramGb?: number | null;
  vramNote?: string | null;
  costUsd?: number | null;
};
