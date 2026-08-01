import { NextRequest, NextResponse } from "next/server";
import { getServiceUrl, getServiceHeaders } from "@/lib/services";
import { getLlmServices, getActiveLlmId, setActiveLlmId } from "@/lib/llm";
import { getFootprintsByService } from "@/lib/providers";

export const dynamic = "force-dynamic";

// GET → the selectable LLMs, each with live health + which one is active.
export async function GET() {
  const active = getActiveLlmId();
  // Read from disk rather than the router catalogue: this endpoint is polled
  // every few seconds and must still answer when the router is down.
  const footprints = getFootprintsByService();
  const services = await Promise.all(
    getLlmServices().map(async (s) => {
      let healthy = false;
      try {
        const res = await fetch(getServiceUrl(s.id) + s.healthPath, {
          headers: getServiceHeaders(s.id),
          signal: AbortSignal.timeout(3000),
        });
        healthy = res.ok;
      } catch {
        /* down = not loaded */
      }
      return {
        id: s.id,
        name: s.name,
        port: s.localPort,
        model: s.llm?.model,
        healthy,
        active: s.id === active,
        footprint: footprints[s.id]?.footprint,
      };
    }),
  );
  return NextResponse.json({ active, services });
}

// POST { id } → set the active LLM.
export async function POST(req: NextRequest) {
  const { id } = await req.json().catch(() => ({}));
  if (typeof id !== "string") return NextResponse.json({ error: "id is required" }, { status: 400 });
  const result = setActiveLlmId(id);
  if ("error" in result) return NextResponse.json(result, { status: 400 });
  return NextResponse.json({ ok: true, active: id });
}
