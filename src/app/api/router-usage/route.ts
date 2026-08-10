import { NextResponse } from "next/server";

import { buildRouterSnapshot } from "@/lib/router-usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const data = await buildRouterSnapshot();
    return NextResponse.json(data, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
