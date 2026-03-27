import { NextResponse } from "next/server";
import { SERVICE_REGISTRY, isLocalServer, getServiceHeaders } from "@/lib/services";

export async function GET() {
  const local = isLocalServer();

  const results = await Promise.all(
    SERVICE_REGISTRY.map(async (svc) => {
      const baseUrl = local ? svc.localUrl : svc.publicUrl;
      const url = baseUrl + svc.healthPath;
      const start = Date.now();
      try {
        const res = await fetch(url, {
          headers: getServiceHeaders(svc.id),
          signal: AbortSignal.timeout(10000),
        });
        return {
          name: svc.name,
          id: svc.id,
          subdomain: svc.publicUrl.replace("https://", ""),
          localUrl: svc.localUrl,
          publicUrl: svc.publicUrl,
          category: svc.category,
          status: res.ok ? ("up" as const) : ("down" as const),
          statusCode: res.status,
          latency: Date.now() - start,
          routing: local ? "local" : "public",
        };
      } catch {
        return {
          name: svc.name,
          id: svc.id,
          subdomain: svc.publicUrl.replace("https://", ""),
          localUrl: svc.localUrl,
          publicUrl: svc.publicUrl,
          category: svc.category,
          status: "down" as const,
          statusCode: 0,
          latency: Date.now() - start,
          routing: local ? "local" : "public",
        };
      }
    })
  );

  return NextResponse.json({
    services: results,
    timestamp: new Date().toISOString(),
    upCount: results.filter((s) => s.status === "up").length,
    totalCount: results.length,
    routing: local ? "local" : "public",
  });
}
