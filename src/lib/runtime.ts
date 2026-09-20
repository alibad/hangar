export type HangarRuntime = "local" | "hosted";

/**
 * Where this copy of Hangar is running.
 *
 * Vercel sets VERCEL during the build. next.config.ts publishes the result so
 * client and server components make the same decision: a hosted showcase must
 * never pretend its ephemeral Linux function is the visitor's workstation.
 */
export function hangarRuntime(): HangarRuntime {
  return process.env.NEXT_PUBLIC_HANGAR_RUNTIME === "hosted" ? "hosted" : "local";
}

export function isHostedRuntime(): boolean {
  return hangarRuntime() === "hosted";
}
