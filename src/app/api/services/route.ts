import { NextResponse } from "next/server";
import { SERVICE_REGISTRY, isLocalServer } from "@/lib/services";

const MANAGER_URL = process.env.MANAGER_URL ?? "http://localhost:8099";

async function registryFallback() {
  const local = isLocalServer();
  return Promise.all(
    SERVICE_REGISTRY.map(async (svc) => {
      const baseUrl = local ? svc.localUrl : svc.publicUrl;
      let healthy = false;
      try {
        const res = await fetch(baseUrl + svc.healthPath, {
          signal: AbortSignal.timeout(3000),
        });
        healthy = res.ok;
      } catch { /* unreachable = stopped */ }
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
    })
  );
}

export async function GET() {
  try {
    const res = await fetch(`${MANAGER_URL}/services`, {
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json();
    if (!res.ok || !Array.isArray(data)) {
      return NextResponse.json(await registryFallback());
    }
    return NextResponse.json(data);
  } catch {
    return NextResponse.json(await registryFallback());
  }
}
