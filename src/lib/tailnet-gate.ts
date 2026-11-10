import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * The gate: the one door into this Hangar from the owner's other computers.
 *
 * Hangar listens on loopback only, and that does not change. The gate is a second, small listener that Hangar binds to
 * this machine's Tailscale address. For every request it asks who is calling (Tailscale knows which device and account
 * an address belongs to), refuses anyone who is not the owner's own computer, and passes on only the few operations a
 * paired Hangar needs. It forwards none of the caller's headers, so no cookie or origin reaches Hangar through it.
 *
 * Everything it depends on is handed in, so the same code runs under test with a made-up caller.
 */
export type GateCaller = { name: string };
export type GateDeps = {
  /** Who owns this address. Null when it is not one of the owner's own computers. */
  caller(ip: string): Promise<GateCaller | null>;
  /** Pass on, pair, or refuse (null). */
  decide(method: string, pathname: string): "forward" | "pair" | null;
  /** Another of the owner's computers asks to be added here, so both see each other. */
  pair(ip: string, body: unknown, caller: GateCaller): Promise<unknown>;
  /** This machine's own Hangar, on loopback. */
  upstream: { host: string; port: number };
};

const LIMIT = 65536;
const PASS = ["content-type", "cache-control", "content-security-policy", "x-content-type-options"];

function send(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}
const remote = (req: IncomingMessage) => (req.socket.remoteAddress || "").replace(/^::ffff:/, "");

/** The request body, or null when it is larger than anything a paired Hangar sends. */
function read(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > LIMIT) { resolve(null); req.resume(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(size > LIMIT ? null : Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function handle(deps: GateDeps, req: IncomingMessage, res: ServerResponse) {
  const method = req.method || "GET";
  let url: URL;
  try { url = new URL(req.url || "/", "http://gate"); } catch { return send(res, 400, { error: "Bad request" }); }
  const from = remote(req);
  const caller = await deps.caller(from).catch(() => null);
  if (!caller) return send(res, 403, { error: "This Hangar answers only its owner's own computers on Tailscale." });
  const verdict = deps.decide(method, url.pathname);
  if (!verdict) return send(res, 404, { error: "Unknown operation" });
  const body = method === "POST" ? await read(req) : Buffer.alloc(0);
  if (!body) return send(res, 413, { error: "Request is too large" });
  if (verdict === "pair") {
    let value: unknown;
    try { value = JSON.parse(body.toString("utf8") || "{}"); } catch { return send(res, 400, { error: "Send a JSON body." }); }
    try { return send(res, 200, await deps.pair(from, value, caller)); }
    catch (error) { return send(res, 400, { error: (error as Error).message }); }
  }
  await new Promise<void>((resolve, reject) => {
    const out = request({
      host: deps.upstream.host, port: deps.upstream.port, method, path: url.pathname + url.search, timeout: 185000,
      headers: { host: `${deps.upstream.host}:${deps.upstream.port}`, "content-type": "application/json", "content-length": body.length,
        "x-hangar": "1", "x-atlas": "1", "x-source": "hangar-fleet" },
    }, up => {
      const headers: Record<string, string> = {};
      for (const name of PASS) { const value = up.headers[name]; if (typeof value === "string") headers[name] = value; }
      res.writeHead(up.statusCode || 502, headers);
      up.pipe(res);
      up.on("end", resolve);
      up.on("error", reject);
    });
    out.on("timeout", () => out.destroy(new Error("This Hangar took too long to answer.")));
    out.on("error", reject);
    out.end(body);
  });
}

export function createGate(deps: GateDeps): Server {
  return createServer((req, res) => {
    handle(deps, req, res).catch(() => {
      if (res.headersSent) res.destroy();
      else send(res, 502, { error: "This Hangar is not answering." });
    });
  });
}
