import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { isHostedRuntime } from "./runtime";

export function engineAddress(): string {
  const port = Number(process.env.HANGAR_ENGINE_PORT || 7789);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("HANGAR_ENGINE_PORT must be a local port.");
  return `http://127.0.0.1:${port}`;
}
const runtime = globalThis as typeof globalThis & { hangarEngineStarting?: Promise<string> };

/** Start the bundled engine on demand, once across simultaneous requests/HMR. */
export async function ensureProjectEngine(): Promise<string> {
  if (isHostedRuntime() || process.env.VERCEL) throw new Error("The project engine runs only in local Hangar.");
  const base = engineAddress();
  async function ready() {
    try {
      const response = await fetch(`${base}/api/status`, { cache: "no-store", signal: AbortSignal.timeout(700) });
      const status = await response.json().catch(() => null);
      if (!response.ok || status?.protocol !== "hangar-engine-v1") throw new Error("Another service owns Hangar's engine port. Set HANGAR_ENGINE_PORT to a free port.");
      return true;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Another service")) throw error;
      return false;
    }
  }
  if (await ready()) return base;
  if (!runtime.hangarEngineStarting) {
    runtime.hangarEngineStarting = (async () => {
      const logs = join(process.cwd(), "var"); mkdirSync(logs, { recursive: true });
      const log = openSync(join(logs, "engine.log"), "a");
      let failed = false;
      try {
        const child = spawn(process.execPath, [join(process.cwd(), "scripts/start-engine.mjs")], {
          cwd: process.cwd(), detached: true, windowsHide: true, stdio: ["ignore", log, log], env: process.env,
        });
        child.on("error", () => { failed = true; });
        child.on("exit", code => { if (code) failed = true; });
        child.unref();
      } finally { closeSync(log); }
      for (let i = 0; i < 40 && !failed; i++) {
        if (await ready()) return base;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      throw new Error("Hangar's project engine could not start. Check Python 3.10+ and var/engine.log.");
    })().finally(() => { delete runtime.hangarEngineStarting; });
  }
  return runtime.hangarEngineStarting;
}
