import { NextResponse } from "next/server";
import { SERVICE_REGISTRY, isLocalServer, getServiceHeaders, getManagerHeaders, getManagerUrl, type ServiceEntry } from "@/lib/services";

// Health-check a registry service directly (used for the fallback and to reconcile
// LLM cards, whose real ports live in the registry not the manager's static list).
async function checkOne(svc: ServiceEntry) {
  const baseUrl = isLocalServer() ? svc.localUrl : svc.publicUrl;
  let healthy = false;
  try {
    const res = await fetch(baseUrl + svc.healthPath, {
      headers: getServiceHeaders(svc.id),
      signal: AbortSignal.timeout(3000),
    });
    healthy = res.ok;
  } catch {
    /* unreachable = stopped */
  }
  return {
    id: svc.id,
    name: svc.name,
    type: "process",
    port: svc.localPort,
    category: svc.category,
    status: healthy ? "running" : "stopped",
    healthy,
    pid: null,
    container: null,
    log_tail: [],
  };
}

async function registryFallback() {
  return Promise.all(SERVICE_REGISTRY.map(checkOne));
}

export async function GET() {
  try {
    const res = await fetch(`${getManagerUrl()}/services`, {
      headers: getManagerHeaders(),
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json();
    if (!res.ok || !Array.isArray(data)) {
      return NextResponse.json(await registryFallback());
    }

    // Reconcile with the registry, which is the source of truth for presentation
    // metadata (name, category). The manager keeps its own static copy, so
    // without this a categorisation change would need a manager restart —
    // and restarting the manager orphans every service it spawned.
    const merged = await Promise.all(
      data.map(async (m: { id: string; name: string; category: string }) => {
        const reg = SERVICE_REGISTRY.find((s) => s.id === m.id);
        if (!reg) return m;
        const base = { ...m, name: reg.name, category: reg.category };
        if (reg.llm) {
          // LLM entries can also carry a stale port in the manager's list.
          const fresh = await checkOne(reg);
          return { ...base, port: fresh.port, status: fresh.status, healthy: fresh.healthy };
        }
        return base;
      }),
    );

    // Append registry services the manager doesn't know about (e.g. vllm-small),
    // so they still appear as cards with start/stop (which the manager handles by id).
    const known = new Set(data.map((s: { id: string }) => s.id));
    const extra = await Promise.all(
      SERVICE_REGISTRY.filter((s) => !known.has(s.id)).map(checkOne),
    );

    return NextResponse.json([...merged, ...extra]);
  } catch {
    return NextResponse.json(await registryFallback());
  }
}
