import { hostname } from "node:os";
import { changePeer, fleetGuard, peers } from "@/lib/fleet";
import { validatePeer } from "@/lib/fleet-policy";
import { getHost } from "@/lib/host";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const denied = fleetGuard(request); if (denied) return denied;
  return Response.json({ local: { id: "local", name: hostname(), profile: getHost().id }, peers: await peers() });
}
export async function POST(request: Request) {
  const denied = fleetGuard(request); if (denied) return denied;
  try {
    const body = await request.json();
    if (body.action === "remove" && typeof body.id === "string") await changePeer(null, body.id);
    else {
      const peer = validatePeer(body);
      // Pair only after the forwarded endpoint identifies itself. No arbitrary URL or hostname accepted.
      const result = await fetch(`http://127.0.0.1:${peer.port}/api/fleet/local/status`, { redirect: "error", signal: AbortSignal.timeout(15000) });
      const node = await result.json();
      if (!result.ok || node.protocol !== "hangar-fleet-v1") throw new Error("No Hangar answered at this forwarded port. Open the SSH tunnel first.");
      if (node.machine === hostname()) throw new Error("This port points back to this machine. Forward the other machine's Hangar port.");
      await changePeer(peer);
    }
    return Response.json({ saved: true });
  } catch (error) { return Response.json({ error: (error as Error).message }, { status: 400 }); }
}
