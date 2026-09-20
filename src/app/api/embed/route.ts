import { NextRequest, NextResponse } from "next/server";
import { resolveCallTarget, type CallTarget } from "@/lib/providers";
import { getServiceHeaders } from "@/lib/services";

export const maxDuration = 300;

/** OpenAI-compatible embeddings, routed to the host's configured local model. */
export async function POST(req: NextRequest) {
  let target: CallTarget | null = null;
  try {
    const body = await req.json();
    if (body.input == null && body.text == null) {
      return NextResponse.json({ error: "input is required" }, { status: 400 });
    }
    target = await resolveCallTarget("embedding");
    const res = await fetch(`${target.baseUrl}/v1/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(target.via === "service" ? getServiceHeaders(target.serviceId!) : {}),
      },
      body: JSON.stringify({ ...body, input: body.input ?? body.text, model: target.model }),
      signal: AbortSignal.timeout(240_000),
    });
    const text = await res.text();
    if (!res.ok) return NextResponse.json({ error: `Embedding failed (${res.status})`, detail: text.slice(0, 500) }, { status: res.status });
    const payload = JSON.parse(text);
    return NextResponse.json({ ...payload, routedModel: target.alias, via: target.via, degraded: target.degraded });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : String(error),
      model: target?.alias,
      serviceId: target?.serviceId,
    }, { status: 502 });
  }
}
