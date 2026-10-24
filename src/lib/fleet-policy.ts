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

export type Peer = { id: string; name: string; port: number; sshAlias?: string };
export function validatePeer(raw: unknown): Peer {
  if (!raw || typeof raw !== "object") throw new Error("Enter a machine name and a forwarded local port.");
  const p = raw as Record<string, unknown>;
  if (typeof p.id !== "string" || !/^[a-z][a-z0-9-]{1,30}$/.test(p.id) || p.id === "local") throw new Error("Use a short machine ID such as laptop.");
  if (typeof p.name !== "string" || !p.name.trim() || p.name.length > 60) throw new Error("Name the machine (up to 60 characters).");
  if (!Number.isInteger(p.port) || Number(p.port) < 1024 || Number(p.port) > 65535 || p.port === 7788) throw new Error("Use an SSH-forwarded Hangar port between 1024 and 65535.");
  if (p.sshAlias !== undefined && (typeof p.sshAlias !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(p.sshAlias))) throw new Error("Use the host alias from your SSH config.");
  return { id: p.id, name: p.name.trim(), port: Number(p.port), ...(p.sshAlias ? { sshAlias: String(p.sshAlias) } : {}) };
}

const READS = new Set(["atlas", "apps", "status", "sessions", "work", "logo", "changes", "plans"]);
const WRITES = new Set(["open", "notes", "rescan", "apps", "sessions/resume", "work", "plans"]);
export function atlasPathAllowed(kind: string, parts: string[], method: string): boolean {
  if (!parts.length || parts.some(p => !p || p === "." || p === ".." || /[\\%?#\0]/.test(p))) return false;
  const path = parts.join("/");
  if (kind === "proxy") return (method === "GET" ? READS : WRITES).has(path);
  if (kind !== "view" || method !== "GET") return false;
  return path === "index.html" || path === "icon.svg" || /^(js|css|vendor)\/[a-zA-Z0-9_./-]+\.(js|css|woff2)$/.test(path);
}
