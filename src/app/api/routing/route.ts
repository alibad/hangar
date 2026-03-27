import { NextResponse } from "next/server";
import { SERVICE_REGISTRY, isLocalServer } from "@/lib/services";

export async function GET() {
  const local = isLocalServer();
  return NextResponse.json({
    mode: local ? "local" : "public",
    services: SERVICE_REGISTRY.map((s) => ({
      id: s.id,
      name: s.name,
      localPort: s.localPort,
      localUrl: s.localUrl,
      publicUrl: s.publicUrl,
      activeUrl: local ? s.localUrl : s.publicUrl,
      category: s.category,
    })),
  });
}
