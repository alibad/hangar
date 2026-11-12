import { fleetGuard } from "@/lib/fleet";
import { FocusInputError } from "@/lib/focus-board";
import { changeFocus, readFocus } from "@/lib/focus-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

/** GET Focus: the starred products, their goals and typed weekly numbers; POST one change ({ action, ... } from focus-board.ts). */
export async function GET(request: Request) {
  const denied = fleetGuard(request);
  if (denied) return denied;
  try { return Response.json(await readFocus(), { headers }); }
  catch (error) { return Response.json({ error: (error as Error).message }, { status: 500, headers }); }
}

export async function POST(request: Request) {
  const denied = fleetGuard(request);
  if (denied) return denied;
  const raw = await request.text();
  if (raw.length > 4096) return Response.json({ error: "Request is too large" }, { status: 413, headers });
  let body: unknown;
  try { body = JSON.parse(raw || "{}"); } catch { return Response.json({ error: "Send a valid Focus action." }, { status: 400, headers }); }
  try { return Response.json(await changeFocus(body), { headers }); }
  catch (error) {
    if (error instanceof FocusInputError) return Response.json({ error: error.message }, { status: 400, headers });
    return Response.json({ error: (error as Error).message }, { status: 500, headers });
  }
}
