/** Fleet access stays behind loopback or a user-created SSH tunnel. Never a public proxy. */
export function localRequestAllowed(request: Request, hosted: boolean): boolean {
  if (hosted) return false;
  const host = request.headers.get("host") ?? "";
  if (!/^(localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(host)) return false;
  if (request.headers.get("x-forwarded-host") && request.headers.get("x-forwarded-host") !== host) return false;
  const origin = request.headers.get("origin");
  if (origin && origin !== `http://${host}` && origin !== `https://${host}`) return false;
  const site = request.headers.get("sec-fetch-site");
  if (site === "cross-site") return false;
  return request.method === "GET" || request.headers.get("x-hangar") === "1";
}

/** A machine reached over Tailscale carries its tailnet address; one behind an SSH tunnel has only a forwarded local port. */
export type Peer = { id: string; name: string; port: number; sshAlias?: string; tailnet?: string };
export function validatePeer(raw: unknown): Peer {
  if (!raw || typeof raw !== "object") throw new Error("Enter a machine name and a forwarded local port.");
  const p = raw as Record<string, unknown>;
  if (typeof p.id !== "string" || !/^[a-z][a-z0-9-]{1,30}$/.test(p.id) || p.id === "local") throw new Error("Use a short machine ID such as laptop.");
  if (typeof p.name !== "string" || !p.name.trim() || p.name.length > 60) throw new Error("Name the machine (up to 60 characters).");
  if (!Number.isInteger(p.port) || Number(p.port) < 1024 || Number(p.port) > 65535 || [7788, 7789].includes(Number(p.port))) throw new Error("Use an SSH-forwarded Hangar port between 1024 and 65535.");
  if (p.sshAlias !== undefined && (typeof p.sshAlias !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(p.sshAlias))) throw new Error("Use the host alias from your SSH config.");
  if (p.tailnet !== undefined && !isTailnetIp(p.tailnet)) throw new Error("Use the machine's Tailscale address.");
  return { id: p.id, name: p.name.trim(), port: Number(p.port), ...(p.sshAlias ? { sshAlias: String(p.sshAlias) } : {}), ...(p.tailnet ? { tailnet: String(p.tailnet) } : {}) };
}

// ── Tailscale: the owner's computers find each other on their private network ──────────────────────────────────────
// Hangar itself stays on loopback. A second, narrow listener (the gate) binds to this machine's Tailscale address only,
// answers only computers signed in to the same Tailscale account, and passes on only the operations listed below.

/** The port Hangar's gate listens on, on the Tailscale address. */
export const GATE_PORT = 8033;

/** An address Tailscale hands out (100.64.0.0/10). Hangar connects out only to these, or to this machine itself. */
export function isTailnetIp(ip: unknown): ip is string {
  const m = typeof ip === "string" ? /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip) : null;
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number);
  return a === 100 && b >= 64 && b <= 127 && c <= 255 && d <= 255;
}

export type TailnetState = "missing" | "off" | "signin" | "approval" | "running";
export type TailnetDevice = { name: string; os: string; ip: string; online: boolean };
export type Tailnet = { state: TailnetState; self: (TailnetDevice & { login: string }) | null; devices: TailnetDevice[]; authUrl: string };

const STATES: Record<string, TailnetState> = { Running: "running", NeedsLogin: "signin", NeedsMachineAuth: "approval" };
const COMPUTERS = new Set(["windows", "macos", "linux"]);
function tailnetDevice(raw: unknown): TailnetDevice | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  const ip = Array.isArray(p.TailscaleIPs) ? p.TailscaleIPs.find(isTailnetIp) : undefined;
  if (!ip) return null;
  const label = typeof p.DNSName === "string" ? p.DNSName.split(".")[0] : "";
  const name = ((typeof p.HostName === "string" && p.HostName.trim()) || label).replace(/[^\x20-\x7e]/g, "").slice(0, 60);
  return name ? { name, os: typeof p.OS === "string" ? p.OS : "", ip, online: p.Online === true } : null;
}
/**
 * What `tailscale status --json` says, cut down to what Hangar acts on: whether Tailscale is up, who this machine is, and
 * the owner's other computers. Phones, devices of other people, devices shared in from another network and tagged
 * servers are left out: a Hangar is only ever paired with a computer signed in to the same account.
 */
export function readTailnet(raw: unknown): Tailnet {
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const state = STATES[String(s.BackendState)] || "off";
  const authUrl = typeof s.AuthURL === "string" && /^https:\/\/login\.tailscale\.com\//.test(s.AuthURL) ? s.AuthURL : "";
  const me = (s.Self && typeof s.Self === "object" ? s.Self : {}) as Record<string, unknown>;
  const users = (s.User && typeof s.User === "object" ? s.User : {}) as Record<string, { LoginName?: unknown }>;
  const login = users[String(me.UserID)]?.LoginName;
  const self = tailnetDevice(me);
  if (state !== "running" || !self || typeof login !== "string" || !login) return { state, self: null, devices: [], authUrl };
  const devices = Object.values((s.Peer && typeof s.Peer === "object" ? s.Peer : {}) as Record<string, Record<string, unknown>>)
    .filter(p => p && p.UserID === me.UserID && p.ShareeNode !== true && !(Array.isArray(p.Tags) && p.Tags.length) && COMPUTERS.has(String(p.OS).toLowerCase()))
    .map(tailnetDevice).filter((d): d is TailnetDevice => !!d && d.ip !== self.ip)
    .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  return { state, self: { ...self, login }, devices, authUrl };
}

/** Who `tailscale whois --json` says is calling. Null unless it is a computer signed in to the owner's own account. */
export function tailnetCaller(raw: unknown, login: string): { name: string } | null {
  const w = (raw && typeof raw === "object" ? raw : {}) as { UserProfile?: { LoginName?: unknown }; Node?: { Tags?: unknown; ComputedName?: unknown; Name?: unknown; Hostinfo?: { Hostname?: unknown } } };
  if (!login || w.UserProfile?.LoginName !== login) return null;
  if (Array.isArray(w.Node?.Tags) && w.Node.Tags.length) return null;
  const name = [w.Node?.ComputedName, w.Node?.Hostinfo?.Hostname, typeof w.Node?.Name === "string" ? w.Node.Name.split(".")[0] : ""]
    .find((n): n is string => typeof n === "string" && !!n.trim()) || "Another computer";
  return { name: name.replace(/[^\x20-\x7e]/g, "").trim().slice(0, 60) || "Another computer" };
}

/** A short machine id from a computer's name, not one already taken. */
export function peerId(name: string, taken: string[]): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
  const base = /^[a-z]/.test(slug) && slug.length > 1 && slug !== "local" ? slug : `pc-${slug || "other"}`.slice(0, 24);
  for (let n = 1; n < 100; n++) { const id = n === 1 ? base : `${base}-${n}`; if (!taken.includes(id)) return id; }
  throw new Error("Too many machines share this name.");
}

/** Where to get Tailscale for this kind of computer. The command is only given where one is known to work. */
export function tailscaleInstall(platform: string): { url: string; command: string } {
  if (platform === "win32") return { url: "https://tailscale.com/download/windows", command: "winget install --id Tailscale.Tailscale" };
  if (platform === "darwin") return { url: "https://tailscale.com/download/mac", command: "" };
  return { url: "https://tailscale.com/download/linux", command: "" };
}

const READS = new Set(["agents", "insights", "islands", "workspace", "atlas", "apps", "status", "sessions", "sessions/library", "work", "logo", "changes", "plans", "architecture", "architecture/view", "activity", "activity/all", "commit", "reviews", "stepback", "stepback/facts"]);
const WRITES = new Set(["agents/login", "islands", "workspace", "open", "notes", "rescan", "apps", "sessions/resume", "sessions/library", "sessions/checkin", "work", "plans", "git", "architecture", "reviews", "stepback"]);
export function atlasPathAllowed(kind: string, parts: string[], method: string): boolean {
  if (!parts.length || parts.some(p => !p || p === "." || p === ".." || /[\\%?#\0]/.test(p))) return false;
  const path = parts.join("/");
  if (kind === "proxy") return (method === "GET" ? READS : WRITES).has(path);
  if (kind !== "view" || method !== "GET") return false;
  return path === "index.html" || path === "icon.svg" || /^(js|css|vendor)\/[a-zA-Z0-9_./-]+\.(js|css|woff2)$/.test(path);
}

// Opening a desktop window belongs to the machine the person sits at, so it is refused from another computer.
const DESKTOP_ONLY = new Set(["open", "sessions/resume", "apps"]);
/**
 * What the gate does with a request from another of the owner's computers: pass it on to this Hangar, pair, or refuse.
 * It passes on exactly what a Hangar behind an SSH tunnel is asked for, and nothing else of Hangar's API.
 */
export function gateAllows(method: string, pathname: string): "forward" | "pair" | null {
  if (method !== "GET" && method !== "POST") return null;
  if (pathname === "/api/fleet/pair") return method === "POST" ? "pair" : null;
  const fleet = /^\/api\/fleet\/local\/([a-z]+)$/.exec(pathname);
  if (fleet) return (method === "GET" ? ["status", "models"] : ["inference"]).includes(fleet[1]) ? "forward" : null;
  const world = /^\/api\/world\/local\/(proxy|view)\/(.+)$/.exec(pathname);
  if (!world) return null;
  const parts = world[2].split("/");
  if (!atlasPathAllowed(world[1], parts, method)) return null;
  return method === "POST" && DESKTOP_ONLY.has(parts.join("/")) ? null : "forward";
}
