import { NextRequest, NextResponse } from "next/server";
import { CAPABILITIES, getCatalogue, getRouting, localServiceHealthy, modelMetaFor, modelsFor, type Capability } from "@/lib/providers";
import { getHost, servedModels } from "@/lib/host";
import { isCapabilityId } from "@/lib/capabilities";
import type { LabModel, LabModelsPayload } from "@/lib/lab-types";

export const dynamic = "force-dynamic";

/**
 * GET ?capability=<id> — the models a Lab can run, on THIS host.
 *
 * Two sources, merged, so the same Lab works on every machine:
 *  • the router catalogue, for capabilities the router can route — narrowed to
 *    cloud models plus local ones whose backing service this host actually has.
 *    ai-router.yaml is shared across machines; without the narrowing B5 would
 *    list BeTenshi's vLLM models with a Start button for a service it lacks.
 *  • host-profile services that declare the capability in `serves`, for
 *    anything the router does not know about — which is every music, 3D, video
 *    and decision service. `serves` may list several models for one service
 *    (ComfyUI hosts many); each gets a row, described from model-meta.json.
 *    A service already represented by a catalogue entry is not listed twice.
 */
export async function GET(req: NextRequest) {
  const capability = req.nextUrl.searchParams.get("capability") ?? "";
  if (!isCapabilityId(capability)) {
    return NextResponse.json({ error: `Unknown capability "${capability}".` }, { status: 400 });
  }

  // `compare`: a Lab's compareCapability — the comparison column's models come
  // from there (an LLM beside a decision model). Only a routable capability
  // has router models to offer, so anything else is refused rather than
  // silently returning an empty picker.
  const compare = req.nextUrl.searchParams.get("compare");
  const isRoutable = (c: string) => CAPABILITIES.some((x) => x.id === c);
  if (compare != null && (!isCapabilityId(compare) || !isRoutable(compare))) {
    return NextResponse.json({ error: `Cannot compare against "${compare}": the router has no models for it.` }, { status: 400 });
  }

  const host = getHost();
  const hostServices = new Map(host.services.map((s) => [s.id, s]));
  const routable = isRoutable(capability);

  const { routerUp, models: catalogue } =
    routable || compare ? await getCatalogue() : { routerUp: false, models: [] };

  const models: LabModel[] = [];
  const covered = new Set<string>();
  const fromRouter = (cap: Capability, asCompare: boolean) => {
    for (const m of modelsFor(cap, catalogue)) {
      if (m.local && (!m.serviceId || !hostServices.has(m.serviceId))) continue;
      if (!asCompare && m.serviceId) covered.add(m.serviceId);
      models.push({
        id: m.id,
        local: m.local,
        source: "router",
        serviceId: m.serviceId,
        serviceName: m.serviceId ? hostServices.get(m.serviceId)?.name : undefined,
        status: m.status,
        detail: m.detail,
        loaded: m.loaded,
        params: m.params,
        checkpoint: m.checkpoint,
        license: m.license,
        docs: m.docs,
        footprint: m.footprint,
        costPerMTokIn: m.costPerMTokIn,
        costPerMTokOut: m.costPerMTokOut,
        costPerImage: m.costPerImage,
        ...(asCompare ? { compare: true } : {}),
      });
    }
  };
  if (routable) fromRouter(capability as Capability, false);
  if (compare && compare !== capability) fromRouter(compare as Capability, true);

  const direct = host.services.filter((s) => servedModels(s, capability).length && !covered.has(s.id));
  const health = await Promise.all(direct.map((s) => localServiceHealthy(s.id)));
  direct.forEach((s, i) => {
    // One row per model the service declares — one runtime can host several.
    for (const id of servedModels(s, capability)) {
      // Described by config/model-meta.json exactly as router models are, keyed
      // `local-<id>` (or the bare id), so footprint and licence still show.
      const md = modelMetaFor(id);
      models.push({
        id,
        local: true,
        source: "service",
        serviceId: s.id,
        serviceName: s.name,
        status: health[i] ? "ready" : "service-stopped",
        detail: health[i] ? undefined : `${s.name} isn't running.`,
        params: md?.params,
        checkpoint: md?.checkpoint,
        license: md?.license,
        docs: md?.docs,
        footprint: md?.footprint,
      });
    }
  });

  // Local first (that is what a Lab is for), then ready before not, then name.
  models.sort(
    (a, b) =>
      Number(b.local) - Number(a.local) ||
      Number(b.status === "ready") - Number(a.status === "ready") ||
      a.id.localeCompare(b.id),
  );

  const payload: LabModelsPayload = {
    capability,
    host: { id: host.id, name: host.name, memoryKind: host.memory.kind },
    routerUp,
    routed: routable ? getRouting()[capability as Capability] : undefined,
    models,
  };
  return NextResponse.json(payload);
}
