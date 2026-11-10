import { fleetGuard } from "@/lib/fleet";
import { setVisible, tailnetConnect, tailnetView } from "@/lib/tailnet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET                              Tailscale on this computer, and the owner's other computers found on it
 * POST {action: "visible", on}     let the owner's other computers reach this Hangar, or stop
 * POST {action: "connect", ip}     connect to one of them, both ways
 */
export async function GET(request: Request) {
  const denied = fleetGuard(request); if (denied) return denied;
  return Response.json(await tailnetView(), { headers: { "Cache-Control": "no-store" } });
}
export async function POST(request: Request) {
  const denied = fleetGuard(request); if (denied) return denied;
  try {
    const body = await request.json();
    if (body.action === "visible") { await setVisible(body.on === true); return Response.json(await tailnetView()); }
    if (body.action === "connect") return Response.json(await tailnetConnect(body.ip));
    return Response.json({ error: "Unknown operation" }, { status: 400 });
  } catch (error) { return Response.json({ error: (error as Error).message }, { status: 400 }); }
}
