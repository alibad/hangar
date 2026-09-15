/**
 * Which machine is this console running on?
 *
 * One console, several boxes. Everything that differs between them — the service
 * list, how memory is budgeted, how the GPU is probed, where access logs live —
 * hangs off ONE resolved profile, so that adding a host is a JSON file plus a
 * hostname, and no route ever asks `process.platform` on its own.
 *
 * Profiles are data (config/hosts/*.json) so scripts/manager.cjs, which is
 * CommonJS and cannot import TypeScript, reads the same file the app does. That
 * also retires the manager's own hand-copied service list, which had already
 * drifted (vllm on :8000 there, :8005 here).
 *
 * ── RESOLUTION ──────────────────────────────────────────────────────────────
 * The host is decided ONCE, in next.config.ts, and published as
 * NEXT_PUBLIC_HOST_ID. Nothing else here touches `os`: the registry is imported
 * by two client components (requests-view, service-control), and a module that
 * pulls in `os` cannot be bundled for the browser. Reading a single env string
 * works identically on both sides.
 *
 * Order of precedence: HOST_ID env → hostname match → platform inference →
 * betenshi. The fallback is deliberate: a Vercel build box has a random
 * hostname and a Linux platform, and the deployed console must keep targeting
 * BeTenshi's public URLs exactly as it did before hosts existed.
 */

import betenshi from "../../config/hosts/betenshi.json";
import b5 from "../../config/hosts/b5.json";
import type { ServiceEntry } from "./services";
import { machineProfileFromHost, type MachineProfile } from "./model-fit";

export type MemoryKind = "discrete" | "unified";

/** The console's four fixed workstream slots. Icons are chosen in code. */
export type WorkstreamKind = "text" | "image" | "audio" | "files";

/**
 * What this machine can be asked to DO, as the Home page offers it.
 *
 * Declared per host because the Home page used to hardcode BeTenshi's four —
 * Chat & Code, Image Studio, Speech, Vision & 3D — so on any other machine it
 * advertised work that host cannot do and offered buttons into tabs that are
 * not there. A host lists only the workstreams its own services back.
 */
export type Workstream = {
  label: string;
  description: string;
  /** Human-facing model name for the card and the pre-flight panel. */
  model: string;
  /** The service that must be up. Must exist in this profile's `services`. */
  serviceId: string;
  /** Tab the card's action opens. */
  tab: string;
  vramGb: number;
  ramGb: number;
  color: "orange" | "violet" | "blue" | "emerald";
  action: string;
};

export type HostProfile = {
  id: string;
  name: string;
  platform: "win32" | "darwin" | "linux";
  gpu: "nvidia" | "apple" | "none";
  /**
   * `kind` decides whether VRAM and RAM are one budget or two. The totals are
   * this machine's specs, used only as a last-resort label when live telemetry
   * has not arrived — previously two magic numbers (31.8 / 63.3) hardcoded in
   * the UI, which printed BeTenshi's card size on a Mac.
   */
  memory: { kind: MemoryKind; totalGb?: number; vramTotalGb?: number; ramTotalGb?: number };
  /** Where per-service uvicorn access logs live (traffic tail). `~` is expanded. */
  logsDir: string | null;
  /** scripts/<file> the manager reads start commands from. */
  commandsFile: string;
  services: ServiceEntry[];
  workstreams: Partial<Record<WorkstreamKind, Workstream>>;
};

// JSON carries `_doc` / `note` fields that the runtime type does not need; strip
// the profile-level ones and let ServiceEntry's optional `note` keep the rest.
function asProfile(raw: unknown): HostProfile {
  const { _doc: _ignored, memory, workstreams, ...rest } = raw as HostProfile & {
    _doc?: string;
    memory: { kind: MemoryKind; _doc?: string; totalGb?: number; vramTotalGb?: number; ramTotalGb?: number };
    workstreams?: Record<string, Workstream & { _doc?: string }>;
  };
  void _ignored;
  // Strip the `_doc` keys the JSON carries for humans; everything else is data.
  const ws: Partial<Record<WorkstreamKind, Workstream>> = {};
  for (const [k, v] of Object.entries(workstreams ?? {})) {
    if (k.startsWith("_")) continue;
    ws[k as WorkstreamKind] = v as Workstream;
  }
  const { _doc: _m, ...mem } = memory;
  void _m;
  return { ...rest, memory: mem, workstreams: ws } as HostProfile;
}

export const HOST_PROFILES: Record<string, HostProfile> = {
  betenshi: asProfile(betenshi),
  b5: asProfile(b5),
};

export const DEFAULT_HOST_ID = "betenshi";

/**
 * Pure: map what next.config.ts can observe onto a profile id. Exported so the
 * manager (via the compiled-free path below) and tests can run the same rule.
 */
export function resolveHostId(input: {
  envHostId?: string | null;
  hostname?: string | null;
  platform?: string | null;
}): string {
  const env = (input.envHostId ?? "").trim().toLowerCase();
  if (env && HOST_PROFILES[env]) return env;

  const host = (input.hostname ?? "").trim().toLowerCase().replace(/\.local$/, "");
  if (host && HOST_PROFILES[host]) return host;

  // No name match: the only platform we can be *sure* about is a Mac, which is
  // never BeTenshi. Anything else (win32, or Linux on a build box) is BeTenshi.
  if (input.platform === "darwin") return "b5";
  return DEFAULT_HOST_ID;
}

export function getHostId(): string {
  const id = (process.env.NEXT_PUBLIC_HOST_ID ?? "").trim().toLowerCase();
  return HOST_PROFILES[id] ? id : DEFAULT_HOST_ID;
}

export function getHost(): HostProfile {
  return HOST_PROFILES[getHostId()];
}

/** Whether VRAM and system RAM are the same pool on this host. */
export function isUnifiedMemory(): boolean {
  return getHost().memory.kind === "unified";
}

/** What the UI should call the GPU's memory bar. */
export function memoryLabel(): string {
  return isUnifiedMemory() ? "Memory" : "VRAM";
}

/**
 * Which services a console tab needs before it can do anything.
 *
 * These tabs are NEVER hidden. A console that drops half its navigation on one
 * machine reads as a different, smaller product, and it hides the very thing
 * you want to know — what this box can and cannot do. Every surface is present
 * on every host; one that has nothing behind it here says so, in place, and
 * names what is missing.
 *
 * A tab absent from this map (Home, Services, Models, Requests, Usage, Storage,
 * Arena) is host-independent and always usable.
 */
const TAB_SERVICES: Record<string, string[]> = {
  speech: ["whisper", "tts"],
  qwen: ["qwen", "comfyui"],
  sam3d: ["sam3d"],
  sam3: ["sam3"],
};

export type TabSupport = {
  /** Is at least one backing service registered on this host? */
  available: boolean;
  /** Every service that could back this tab. Empty for host-independent tabs. */
  needs: string[];
  /** Those this host does not have. */
  missing: string[];
};

/**
 * What this host can do for a tab. Resolved from the build-time profile, so the
 * answer is right on the first paint rather than after /api/host lands.
 */
export function tabSupport(tab: string): TabSupport {
  const needs = TAB_SERVICES[tab] ?? [];
  if (!needs.length) return { available: true, needs, missing: [] };
  const have = new Set(getHost().services.map((s) => s.id));
  const missing = needs.filter((id) => !have.has(id));
  return { available: missing.length < needs.length, needs, missing };
}

/** Convenience: can this host back the tab at all? */
export function hostHasTab(tab: string): boolean {
  return tabSupport(tab).available;
}

/**
 * Per-host OVERRIDES for the canonical workstreams, not a replacement list.
 *
 * The four cards (Chat & Code, Image Studio, Speech, Vision & 3D) exist on every
 * host; a profile only says where THIS machine differs — B5 backs Chat & Code
 * with Ollama rather than vLLM, so it overrides the model and service for that
 * one slot and says nothing about the rest.
 */
export function getWorkstreamOverrides(): Partial<Record<WorkstreamKind, Partial<Workstream>>> {
  return getHost().workstreams as Partial<Record<WorkstreamKind, Partial<Workstream>>>;
}

/**
 * Declared totals, for labelling a meter before telemetry arrives. On a unified
 * host both answers are the same pool by definition.
 */
export function declaredMemoryGb(): { vramGb: number; ramGb: number } {
  const m = getHost().memory;
  if (m.kind === "unified") {
    const t = m.totalGb ?? 0;
    return { vramGb: t, ramGb: t };
  }
  return { vramGb: m.vramTotalGb ?? 0, ramGb: m.ramTotalGb ?? 0 };
}

// ── each host as a MachineProfile ───────────────────────────────────────────

export type { KnownMachine } from "./model-fit";

/**
 * A machine profile for a host this process is NOT running on, from its
 * declared specs. The arithmetic lives in model-fit's machineProfileFromHost();
 * this is only the lookup, so the builder stays pure and testable without
 * pulling the profile JSON through a bundler.
 */
export function declaredMachineProfile(hostId: string): MachineProfile | null {
  const host = HOST_PROFILES[hostId];
  return host ? machineProfileFromHost(host) : null;
}
