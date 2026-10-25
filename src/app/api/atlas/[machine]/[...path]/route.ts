import { atlasBase, fleetGuard, peerBase } from "@/lib/fleet";
import { atlasPathAllowed } from "@/lib/fleet-policy";
import { islandStore } from "@/lib/island-store";
import { IslandInputError, IslandStorageError, type WorldDocument } from "@/lib/islands";
import { workspaceResponse } from "@/lib/workspace-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ machine: string; path: string[] }> };

async function proxy(request: Request, context: Context) {
  const denied = fleetGuard(request);
  if (denied) return denied;
  const { machine, path: [kind, ...parts] } = await context.params;
  if (!atlasPathAllowed(kind, parts, request.method)) return Response.json({ error: "Unknown project operation" }, { status: 404 });
  // Interactive desktop apps must open on the machine the browser belongs to.
  if (machine !== "local" && request.method === "POST" && ["open", "sessions/resume", "apps"].includes(parts.join("/"))) {
    return Response.json({ error: "Use a managed coding job on the remote machine. Desktop windows open locally on their host." }, { status: 400 });
  }
  try {
    const base = machine === "local" ? await atlasBase() : await peerBase(machine);
    const target = machine === "local" ? `${kind === "proxy" ? "/api" : ""}/${parts.join("/")}`
      : `/api/world/local/${kind}/${parts.join("/")}`;
    const query = new URL(request.url).searchParams;
    const safeQuery = new URLSearchParams();
    for (const key of ["repo", "v"]) if (query.has(key)) safeQuery.set(key, query.get(key)!);
    let body = request.method === "POST" ? await request.text() : undefined;
    if (body && body.length > 32768) return Response.json({ error: "Request is too large" }, { status: 413 });
    const localApi = machine === "local" && kind === "proxy";
    const operation = parts.join("/");
    const readWorld = async () => workspaceResponse<WorldDocument>(await fetch(`${base}/api/atlas`, {
      cache: "no-store", redirect: "error", signal: AbortSignal.any([request.signal, AbortSignal.timeout(20000)]),
    }));
    const parseBody = () => {
      try { return JSON.parse(body || "{}"); } catch { throw new IslandInputError("Send a valid island action."); }
    };
    // Island organization belongs to Hangar, not to the repository scanner process.
    if (localApi && operation === "islands") {
      const doc = await readWorld();
      if (request.method === "POST") return Response.json(await islandStore.update(doc, parseBody()), { headers: { "Cache-Control": "no-store" } });
      const world = await islandStore.apply(doc);
      return Response.json({ islands: world.islands, roots: [], jobs: [] }, { headers: { "Cache-Control": "no-store" } });
    }
    let organization: { doc: WorldDocument; actions: Record<string, unknown>[] } | undefined;
    if (localApi && operation === "notes" && body) {
      const payload = parseBody();
      if (payload && typeof payload === "object" && payload.fields && typeof payload.fields === "object") {
        const { family, ...fields } = payload.fields;
        if (family !== undefined || fields.focus !== undefined || fields.parked !== undefined || fields.hidden !== undefined) {
          const doc = await readWorld();
          const actions: Record<string, unknown>[] = [];
          if (family !== undefined) actions.push(family ? { action: "assign-island", island: family, repos: [payload.repo] } : { action: "reset-assignment", repo: payload.repo });
          if (fields.hidden !== undefined || fields.focus !== undefined || fields.parked !== undefined) {
            actions.push({ action: "set-project-state", repos: [payload.repo],
              ...(fields.hidden !== undefined ? { hidden: fields.hidden } : {}),
              ...(fields.focus !== undefined || fields.parked !== undefined ? { attention: fields.focus ? "focus" : fields.parked ? "parked" : null } : {}),
            });
          }
          for (const action of actions) await islandStore.validate(doc, action);
          organization = { doc, actions };
          // Empty family resets the scanner's old assignment too. Custom IDs stay here.
          body = JSON.stringify({ ...payload, fields: family === "" ? { ...fields, family: "" } : fields });
        }
      }
    }
    const response = await fetch(`${base}${target}?${safeQuery}`, {
      method: request.method, body, redirect: "error", cache: "no-store",
      headers: { "Content-Type": "application/json", "X-Atlas": "1", "X-Hangar": "1" },
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(["sessions", "insights"].includes(parts[0]) ? 90000 : 20000)]),
    });
    if (localApi && operation === "atlas" && response.ok) {
      return Response.json(await islandStore.apply(await response.json()), { headers: { "Cache-Control": "no-store" } });
    }
    if (localApi && operation === "notes" && response.ok) {
      const result = await response.json();
      if (organization) for (const action of organization.actions) await islandStore.update(organization.doc, action);
      const world = await islandStore.apply(await readWorld());
      return Response.json({ ...result, repo: world.repos.find(r => r.id === result.repo?.id) || result.repo }, { headers: { "Cache-Control": "no-store" } });
    }
    return new Response(response.body, { status: response.status, headers: {
      "Content-Type": response.headers.get("content-type") || "application/json",
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": kind === "view" ? "frame-ancestors 'self'" : "default-src 'none'; frame-ancestors 'none'",
    } });
  } catch (error) {
    if (error instanceof IslandInputError) return Response.json({ error: error.message }, { status: 400 });
    if (error instanceof IslandStorageError) return Response.json({ error: error.message }, { status: 500 });
    return Response.json({ error: machine === "local" ? "Hangar’s project engine is not responding. Check Python 3.10+ and the engine log in local storage." : "The SSH connection is unavailable. Reconnect the tunnel in Machines." }, { status: 503 });
  }
}
export const GET = proxy;
export const POST = proxy;
