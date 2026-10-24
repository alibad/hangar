import { hostname } from "node:os";
import { atlasBase, fleetGuard, peerBase } from "@/lib/fleet";
import { getHost } from "@/lib/host";
import { getCatalogue } from "@/lib/providers";
import type { NextRequest } from "next/server";
import { getServiceUrl, getServiceHeaders } from "@/lib/services";
import { withTraffic, describeCall, TARGET_HEADER } from "@/lib/with-traffic";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ machine: string; action: string }> };
export async function GET(request: Request, context: Context) {
  const denied = fleetGuard(request); if (denied) return denied;
  const { machine, action } = await context.params;
  if (!["status", "models"].includes(action)) return Response.json({ error: "Unknown operation" }, { status: 404 });
  try {
    if (machine !== "local") {
      const response = await fetch(`${await peerBase(machine)}/api/fleet/local/${action}`, { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15000) });
      return new Response(response.body, { status: response.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    }
    if (action === "models") return Response.json(await getCatalogue());
    let atlas = false;
    try { const r = await fetch(`${atlasBase()}/api/status`, { signal: AbortSignal.timeout(1800), cache: "no-store" }); atlas = r.ok && "generatedAt" in await r.json(); } catch { /* Show a disconnected engine. */ }
    const host = getHost();
    return Response.json({ protocol: "hangar-fleet-v1", machine: hostname(), name: host.name, profile: host.id,
      platform: host.platform, memory: host.memory, atlas, observedAt: new Date().toISOString() });
  } catch { return Response.json({ error: "Machine unavailable. Check its SSH tunnel." }, { status: 503 }); }
}

export const POST = withTraffic(async (request: NextRequest, context: Context) => {
  const denied = fleetGuard(request); if (denied) return denied;
  const { machine, action } = await context.params;
  if (action !== "inference") return Response.json({ error: "Unknown operation" }, { status: 404 });
  let target: string | undefined;
  try {
    const body = await request.json();
    if (typeof body.prompt !== "string" || !body.prompt.trim() || body.prompt.length > 12000 || typeof body.model !== "string") {
      return Response.json({ error: "Choose a model and enter a prompt of up to 12,000 characters." }, { status: 400 });
    }
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(180000)]);
    if (machine !== "local") {
      const remote = await fetch(`${await peerBase(machine)}/api/fleet/local/inference`, { method: "POST", redirect: "error", signal,
        headers: { "Content-Type": "application/json", "X-Hangar": "1", "X-Source": "hangar-fleet" }, body: JSON.stringify({ model: body.model, prompt: body.prompt }) });
      const data = await remote.json();
      describeCall(request, { model: body.model, prompt: body.prompt, response: data.content ?? null, error: data.error ?? null });
      return Response.json(data, { status: remote.status, headers: { [TARGET_HEADER]: `machine:${machine}` } });
    }
    const catalogue = await getCatalogue();
    const chosen = catalogue.models.find(m => m.id === body.model);
    if (!chosen || chosen.mode !== "chat" || chosen.status !== "ready") return Response.json({ error: "That exact text model is not ready on this machine." }, { status: 409 });
    if (!chosen.local && !catalogue.routerUp) return Response.json({ error: "Start the AI Router to use this cloud model." }, { status: 409 });
    target = chosen.local ? chosen.serviceId : "ai-router";
    if (!target) return Response.json({ error: "No registered service for this model." }, { status: 409 });
    const model = chosen.local ? chosen.target.replace(/^[^/]+\//, "") : chosen.id;
    const response = await fetch(`${getServiceUrl(target)}/v1/chat/completions`, { method: "POST", signal, redirect: "error",
      headers: { "Content-Type": "application/json", "X-Source": "hangar-fleet", ...getServiceHeaders(target) },
      body: JSON.stringify({ model, messages: [{ role: "user", content: body.prompt }], max_tokens: 4096 }) });
    const data = await response.json();
    if (!response.ok) throw new Error(typeof data.error?.message === "string" ? data.error.message : `Model returned ${response.status}`);
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("The model returned no text answer.");
    describeCall(request, { model: chosen.id, prompt: body.prompt, response: content, tokensIn: data.usage?.prompt_tokens ?? null, tokensOut: data.usage?.completion_tokens ?? null });
    return Response.json({ content, model: chosen.id, machine: hostname(), usage: data.usage }, { headers: { [TARGET_HEADER]: target } });
  } catch (error) {
    describeCall(request, { error: (error as Error).message });
    return Response.json({ error: (error as Error).message }, { status: 502, headers: target ? { [TARGET_HEADER]: target } : undefined });
  }
});
