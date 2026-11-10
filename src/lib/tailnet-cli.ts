import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isTailnetIp, readTailnet, tailnetCaller, type Tailnet } from "./fleet-policy";

/**
 * What Hangar asks the Tailscale app on this machine: is it up, which computers are the owner's, and who owns an
 * address. It only reads. Hangar never signs in, changes Tailscale's settings or installs anything through it.
 */
const PLACES = process.platform === "win32" ? [join(process.env.ProgramFiles || "C:\\Program Files", "Tailscale", "tailscale.exe")]
  : process.platform === "darwin" ? ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale"]
  : ["/usr/bin/tailscale", "/usr/local/bin/tailscale", "/usr/sbin/tailscale"];

/** Tailscale's command, or the bare name to look up on PATH when it sits in none of the usual places. */
function command(): string {
  const set = process.env.HANGAR_TAILSCALE;
  return set || PLACES.find(existsSync) || "tailscale";
}

type Ran = { out: string; missing: boolean };
function run(args: string[]): Promise<Ran> {
  return new Promise(resolve => {
    execFile(command(), args, { timeout: 5000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      resolve({ out: String(stdout || ""), missing: (error as NodeJS.ErrnoException | null)?.code === "ENOENT" });
    });
  });
}

const MISSING: Tailnet = { state: "missing", self: null, devices: [], authUrl: "" };
const OFF: Tailnet = { state: "off", self: null, devices: [], authUrl: "" };
let last: { at: number; value: Tailnet } | null = null;
let reading: Promise<Tailnet> | null = null;

/** Tailscale on this machine, read at most every few seconds. */
export function tailnet(fresh = false): Promise<Tailnet> {
  if (!fresh && last && Date.now() - last.at < 6000) return Promise.resolve(last.value);
  reading ||= run(["status", "--json"]).then(({ out, missing }) => {
    let value = missing ? MISSING : OFF;
    // A stopped Tailscale still prints its state, with a failing exit code: the output decides, not the code.
    if (!missing && out.trim().startsWith("{")) { try { value = readTailnet(JSON.parse(out)); } catch { /* Not JSON: treated as switched off. */ } }
    last = { at: Date.now(), value };
    return value;
  }).finally(() => { reading = null; });
  return reading;
}

const callers = new Map<string, { at: number; value: { name: string } | null }>();
/** The owner's computer at this address, or null. Asked of Tailscale itself, never taken from the request. */
export async function tailnetWhois(ip: string): Promise<{ name: string } | null> {
  if (!isTailnetIp(ip)) return null;
  const known = callers.get(ip);
  if (known && Date.now() - known.at < (known.value ? 60000 : 8000)) return known.value;
  const net = await tailnet();
  let value: { name: string } | null = null;
  if (net.state === "running" && net.self) {
    const { out } = await run(["whois", "--json", ip]);
    try { value = tailnetCaller(JSON.parse(out), net.self.login); } catch { value = null; }
  }
  if (callers.size > 64) callers.clear();
  callers.set(ip, { at: Date.now(), value });
  return value;
}

/**
 * True when Tailscale is up and this address is one of the owner's own computers. Hangar connects out to a tailnet
 * address only then: with Tailscale off, the same numbers can belong to a stranger on the internet provider's network.
 */
export async function tailnetReachable(ip: string): Promise<boolean> {
  const net = await tailnet();
  return net.state === "running" && net.devices.some(device => device.ip === ip);
}
