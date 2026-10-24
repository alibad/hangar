import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isHostedRuntime } from "./runtime";
import { localRequestAllowed, validatePeer, type Peer } from "./fleet-policy";
import { ensureProjectEngine } from "./project-engine";

const CONFIG = join(process.cwd(), "var", "fleet.json");
export function fleetGuard(request: Request): Response | null {
  return localRequestAllowed(request, isHostedRuntime() || !!process.env.VERCEL) ? null : Response.json(
    { error: "Project and machine access is available through local Hangar or your SSH tunnel." }, { status: 403 });
}
export async function peers(): Promise<Peer[]> {
  try { return (JSON.parse(await readFile(CONFIG, "utf8")) as unknown[]).map(validatePeer); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
let writeQueue = Promise.resolve();
export function changePeer(peer: Peer | null, removeId?: string): Promise<void> {
  const change = writeQueue.then(async () => {
    const previous = await peers();
    const next = previous.filter(p => p.id !== (peer?.id ?? removeId));
    if (peer) next.push(peer);
    if (next.length > 8) throw new Error("At most eight connected machines are supported.");
    await mkdir(join(process.cwd(), "var"), { recursive: true });
    const tmp = `${CONFIG}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    await rename(tmp, CONFIG);
  });
  writeQueue = change.catch(() => undefined);
  return change;
}
export async function peerBase(id: string): Promise<string> {
  const peer = (await peers()).find(p => p.id === id);
  if (!peer) throw new Error("Machine is not connected. Add its SSH-forwarded port in Machines.");
  return `http://127.0.0.1:${peer.port}`;
}
// Compatibility name for older API callers; always resolves the bundled engine.
export const atlasBase = ensureProjectEngine;
