import { atlasBase, fleetGuard, peerBase } from "@/lib/fleet";
import { atlasPathAllowed } from "@/lib/fleet-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ machine: string; path: string[] }> };

async function proxy(request: Request, context: Context) {
  const denied = fleetGuard(request);
  if (denied) return denied;
  const { machine, path: [kind, ...parts] } = await context.params;
  if (!atlasPathAllowed(kind, parts, request.method)) return Response.json({ error: "Unknown Atlas operation" }, { status: 404 });
  // Interactive desktop apps must open on the machine the browser belongs to.
  if (machine !== "local" && request.method === "POST" && ["open", "sessions/resume", "apps"].includes(parts.join("/"))) {
    return Response.json({ error: "Use a managed coding job on the remote machine. Desktop windows open locally on their host." }, { status: 400 });
  }
  try {
    const base = machine === "local" ? atlasBase() : await peerBase(machine);
    const target = machine === "local" ? `${kind === "proxy" ? "/api" : ""}/${parts.join("/")}`
      : `/api/atlas/local/${kind}/${parts.join("/")}`;
    const query = new URL(request.url).searchParams;
    const safeQuery = new URLSearchParams();
    for (const key of ["repo", "v"]) if (query.has(key)) safeQuery.set(key, query.get(key)!);
    const body = request.method === "POST" ? await request.text() : undefined;
    if (body && body.length > 32768) return Response.json({ error: "Request is too large" }, { status: 413 });
    const response = await fetch(`${base}${target}?${safeQuery}`, {
      method: request.method, body, redirect: "error", cache: "no-store",
      headers: { "Content-Type": "application/json", "X-Atlas": "1", "X-Hangar": "1" },
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(parts[0] === "sessions" ? 90000 : 20000)]),
    });
    return new Response(response.body, { status: response.status, headers: {
      "Content-Type": response.headers.get("content-type") || "application/json",
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": kind === "view" ? "frame-ancestors 'self'" : "default-src 'none'; frame-ancestors 'none'",
    } });
  } catch {
    return Response.json({ error: machine === "local" ? "Atlas is not responding. Start Atlas from Machines." : "The SSH connection is unavailable. Reconnect the tunnel in Machines." }, { status: 503 });
  }
}
export const GET = proxy;
export const POST = proxy;
