import { NextRequest, NextResponse } from "next/server";
import { CAPABILITIES, getBenchmarks, getCatalogue, getRouting, setRouting, type Routing } from "@/lib/providers";

/** GET — the model catalogue, the capability list, and the active model per capability. */
export async function GET() {
  const [{ routerUp, source, models }, routing] = [await getCatalogue(), getRouting()];
  return NextResponse.json({
    routerUp,
    source,
    models,
    routing,
    capabilities: CAPABILITIES,
    benchmarks: getBenchmarks(),
  });
}

/** POST { <capability>: alias } — repoint one or more capabilities. */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const next: Partial<Routing> = {};

  for (const capDef of CAPABILITIES) {
    const cap = capDef.id;
    const v = body?.[cap];
    if (v === undefined) continue;
    if (typeof v !== "string" || !v.trim()) {
      return NextResponse.json({ error: `Invalid ${cap} model` }, { status: 400 });
    }
    next[cap] = v.trim();
  }
  if (Object.keys(next).length === 0) {
    return NextResponse.json({ error: "Nothing to set" }, { status: 400 });
  }

  // Only accept aliases the router actually serves, AND only for a capability
  // they can perform. A typo'd or mode-mismatched model would otherwise persist
  // and fail at call time — the exact failure mode this surface exists to kill.
  const { routerUp, models } = await getCatalogue();
  if (routerUp) {
    for (const [cap, id] of Object.entries(next)) {
      const model = models.find((m) => m.id === id);
      if (!model) {
        return NextResponse.json(
          { error: `Unknown model "${id}" for ${cap}. Add it to config/ai-router.yaml first.` },
          { status: 400 },
        );
      }
      const capDef = CAPABILITIES.find((c) => c.id === cap);
      if (capDef && !(capDef.modes as readonly string[]).includes(model.mode)) {
        return NextResponse.json(
          { error: `"${id}" is a ${model.mode} model — it can't serve ${capDef.label}.` },
          { status: 400 },
        );
      }
    }
  }

  return NextResponse.json({ ok: true, routing: setRouting(next) });
}
