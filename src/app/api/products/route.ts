import { NextRequest, NextResponse } from "next/server";
import { isHostedRuntime } from "@/lib/runtime";
import { productsReport } from "@/lib/products";

export const dynamic = "force-dynamic";

/**
 * GET                the Products board: feedback, users and releases per product (cached for an hour)
 * GET ?refresh=1     start reading GitHub, Vercel and Google Analytics again; answers at once with the last report
 * GET ?wait=1        wait for a fresh report when the last one is old (the MCP tool)
 */
export async function GET(request: NextRequest) {
  if (isHostedRuntime()) {
    return NextResponse.json({ error: "Products reads this machine's GitHub, Vercel and Google sign-ins. Run Hangar locally.", available: false }, { status: 501 });
  }
  const params = request.nextUrl.searchParams;
  try {
    const report = await productsReport({ force: params.get("refresh") === "1", wait: params.get("wait") === "1" });
    return NextResponse.json(report, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
