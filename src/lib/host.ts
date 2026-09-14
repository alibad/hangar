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

export type MemoryKind = "discrete" | "unified";

export type HostProfile = {
  id: string;
  name: string;
  platform: "win32" | "darwin" | "linux";
  gpu: "nvidia" | "apple" | "none";
  memory: { kind: MemoryKind };
  /** Where per-service uvicorn access logs live (traffic tail). `~` is expanded. */
  logsDir: string | null;
  /** scripts/<file> the manager reads start commands from. */
  commandsFile: string;
  services: ServiceEntry[];
};

// JSON carries `_doc` / `note` fields that the runtime type does not need; strip
// the profile-level ones and let ServiceEntry's optional `note` keep the rest.
function asProfile(raw: unknown): HostProfile {
  const { _doc: _ignored, memory, ...rest } = raw as HostProfile & {
    _doc?: string;
    memory: { kind: MemoryKind; _doc?: string };
  };
  void _ignored;
  return { ...rest, memory: { kind: memory.kind } } as HostProfile;
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
