import { NextResponse } from "next/server";
import { listHolders } from "@/lib/gpu-holders-live";

export const dynamic = "force-dynamic";

/** What is holding the box's RAM and VRAM right now. See src/lib/gpu-holders-live.ts. */
export async function GET() {
  return NextResponse.json({ holders: await listHolders() });
}
