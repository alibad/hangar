import { hostname } from "node:os";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Server } from "node:http";
import { changePeer, peers } from "./fleet";
import { GATE_PORT, gateAllows, isTailnetIp, peerId, tailscaleInstall, validatePeer } from "./fleet-policy";
import { createGate, type GateCaller } from "./tailnet-gate";
import { tailnet, tailnetWhois } from "./tailnet-cli";

/**
 * Pairing the owner's computers over Tailscale: whether this one lets the others in, which of them run Hangar, and
 * connecting two of them in both directions with one click. See docs/connected-workspace.md.
 */
const CONFIG = join(process.cwd(), "var", "tailnet.json");
const HANGAR_PORT = Number(process.env.PORT) || 8003;

/** Off until the owner turns it on: nothing outside this machine reaches Hangar before that. */
async function visible(): Promise<boolean> {
  try { return JSON.parse(await readFile(CONFIG, "utf8")).visible === true; } catch { return false; }
}
export async function setVisible(on: boolean): Promise<void> {
  await mkdir(join(process.cwd(), "var"), { recursive: true });
  const tmp = `${CONFIG}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify({ visible: on }, null, 2), { mode: 0o600 });
  await rename(tmp, CONFIG);
}

// The gate outlives a reload of this module in development, so it is kept on the process.
const held = globalThis as unknown as { hangarGate?: { server: Server; ip: string }; hangarGateStarting?: Promise<GateStatus> };
export type GateStatus = { on: boolean; listening: boolean; error: string };

function closeGate() {
  const gate = held.hangarGate;
  if (!gate) return;
  delete held.hangarGate;
  gate.server.close();
  gate.server.closeAllConnections();
}

/** Start, keep or stop the gate so it matches what the owner chose and where Tailscale is now. */
export function ensureGate(): Promise<GateStatus> {
  held.hangarGateStarting ||= (async (): Promise<GateStatus> => {
    const on = await visible();
    const net = await tailnet();
    const ip = net.state === "running" ? net.self?.ip : undefined;
    if (!on || !ip) { closeGate(); return { on, listening: false, error: on ? "Tailscale is not connected on this computer." : "" }; }
    if (held.hangarGate?.ip === ip && held.hangarGate.server.listening) return { on, listening: true, error: "" };
    closeGate();
    const server = createGate({ caller: address => tailnetWhois(address), decide: gateAllows, pair: acceptPair, upstream: { host: "127.0.0.1", port: HANGAR_PORT } });
    try {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(GATE_PORT, ip, () => { server.off("error", reject); resolve(); }); });
    } catch (error) {
      const busy = (error as NodeJS.ErrnoException).code === "EADDRINUSE";
      return { on, listening: false, error: busy ? `Port ${GATE_PORT} is already in use on this computer.` : "Hangar could not start listening on the Tailscale address." };
    }
    server.on("error", () => { /* A dropped connection must not stop Hangar. */ });
    held.hangarGate = { server, ip };
    return { on, listening: true, error: "" };
  })().finally(() => { delete held.hangarGateStarting; });
  return held.hangarGateStarting;
}

async function savePeer(name: string, ip: string, port: number) {
  const list = await peers();
  const known = list.find(peer => peer.tailnet === ip);
  await changePeer(validatePeer({ id: known?.id || peerId(name, list.map(peer => peer.id)), name: name.slice(0, 60), port, tailnet: ip }));
}

/** Another of the owner's computers connected to this one: add it here too, so each sees the other. */
async function acceptPair(ip: string, body: unknown, caller: GateCaller) {
  const port = (body as { port?: unknown } | null)?.port;
  // The name comes from Tailscale, and the address from the connection itself: neither is taken from what was sent.
  await savePeer(caller.name, ip, Number.isInteger(port) ? Number(port) : GATE_PORT);
  return { paired: true, machine: hostname() };
}

type Found = { machine: string; name: string };
const probes = new Map<string, { at: number; value: Found | false }>();
/** Is a Hangar answering on that computer? */
async function probe(ip: string, fresh = false): Promise<Found | false> {
  const known = probes.get(ip);
  if (!fresh && known && Date.now() - known.at < 10000) return known.value;
  let value: Found | false = false;
  try {
    const response = await fetch(`http://${ip}:${GATE_PORT}/api/fleet/local/status`, { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(2500) });
    const node = await response.json();
    if (response.ok && node.protocol === "hangar-fleet-v1" && typeof node.machine === "string") value = { machine: node.machine, name: typeof node.name === "string" ? node.name : "" };
  } catch { /* No Hangar there, it is not letting others in, or a firewall is in the way. */ }
  probes.set(ip, { at: Date.now(), value });
  return value;
}

/** Everything the Machines page shows about Tailscale and the owner's other computers. */
export async function tailnetView() {
  const net = await tailnet();
  const gate = await ensureGate();
  const saved = await peers();
  const devices = await Promise.all(net.devices.map(async device => ({
    ...device,
    // null: that computer is off or asleep, so there is nothing to ask.
    hangar: device.online ? !!(await probe(device.ip)) : null,
    connected: saved.some(peer => peer.tailnet === device.ip),
  })));
  return { state: net.state, platform: process.platform, machine: hostname(), install: tailscaleInstall(process.platform),
    self: net.self, authUrl: net.authUrl, visible: gate, devices };
}

/** Connect to one of the owner's computers, and ask it to connect back. */
export async function tailnetConnect(ip: unknown) {
  if (!isTailnetIp(ip)) throw new Error("Pick one of your computers from the list.");
  const net = await tailnet(true);
  const device = net.devices.find(d => d.ip === ip);
  if (net.state !== "running" || !device) throw new Error("That computer is not on your Tailscale network right now.");
  const found = await probe(ip, true);
  if (!found) throw new Error(`Hangar did not answer on ${device.name}. Start Hangar there and turn on “Let my other computers see this one”.`);
  if (found.machine === hostname()) throw new Error("That is this computer.");
  // Both ways: this computer has to let the other one in as well.
  await setVisible(true);
  const gate = await ensureGate();
  await savePeer(device.name, ip, GATE_PORT);
  let back = false;
  try {
    const response = await fetch(`http://${ip}:${GATE_PORT}/api/fleet/pair`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(8000),
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ port: GATE_PORT }) });
    back = response.ok;
  } catch { /* An older Hangar there: this computer still sees it. */ }
  return { saved: true, name: device.name, both: back && gate.listening };
}
