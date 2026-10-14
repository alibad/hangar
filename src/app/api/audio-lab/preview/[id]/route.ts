import { NextRequest, NextResponse } from "next/server";
import { audioLibrary } from "@/lib/audio-store";
import { isHostedRuntime } from "@/lib/runtime";
const loopback = (hostname: string) => ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
export const runtime = "nodejs";
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (isHostedRuntime() || !loopback(req.nextUrl.hostname)) return new NextResponse("Local preview only", { status: 404 });
  const origin = req.headers.get("origin"), headers: Record<string, string> = { "Cache-Control": "no-store", Vary: "Origin" };
  if (origin) { try { if (!loopback(new URL(origin).hostname)) return new NextResponse("Local viewer only", { status: 403 }); headers["Access-Control-Allow-Origin"] = origin; } catch { return new NextResponse("Invalid origin", { status: 403 }); } }
  const { id } = await params;
  const revision = (await audioLibrary()).revisions.find(r => r.id === id);
  if (!revision) return NextResponse.json({ error: "Revision no longer available. Current game audio is unchanged." }, { status: 404, headers });
  return NextResponse.json({ revision: revision.id, name: revision.name, event: revision.event, actor: "r2m1a2s", faction: "saudi-arabia", url: `${req.nextUrl.origin}${revision.url}`, loop: revision.recipe.loop }, { headers });
}
