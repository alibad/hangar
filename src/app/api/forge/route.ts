import { NextRequest, NextResponse } from "next/server";
import { SEARXNG_URL } from "@/lib/forge/sources";
import {
  forge,
  getSettings,
  listItems,
  nextWindowStart,
  updateSettings,
  windowMinutesLeft,
  type ForgeSettings,
} from "@/lib/forge/forge";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function up(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(3000) })).ok;
  } catch {
    return false;
  }
}

/** Everything the Forge page shows: settings, what it is doing, the items. */
export async function GET() {
  const [settings, items, searchUp, smallUp] = await Promise.all([
    getSettings(),
    listItems(80),
    up(`${SEARXNG_URL}/healthz`),
    up("http://127.0.0.1:8006/health"),
  ]);
  const left = windowMinutesLeft(settings.window);
  return NextResponse.json({
    settings,
    runtime: forge.runtime,
    window: { open: left != null, minutesLeft: left, nextStart: nextWindowStart(settings.window).toISOString() },
    services: { search: searchUp, smallModel: smallUp },
    items,
  });
}

/**
 * { action: "listen" }                          one listen now (~1 min), returns the item
 * { action: "settings", patch }                 change settings
 * { action: "review", id, verdict, reason? }    approve / reject a finished clip
 * { action: "discard", id }                     remove an item (cancels its render)
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    patch?: Partial<ForgeSettings>;
    id?: string;
    verdict?: string;
    reason?: string;
  };
  try {
    switch (body.action) {
      case "listen":
        return NextResponse.json({ item: await forge.listen() });
      case "settings":
        return NextResponse.json({ settings: await updateSettings(body.patch ?? {}) });
      case "review":
        if (!body.id || (body.verdict !== "approved" && body.verdict !== "rejected")) {
          return NextResponse.json({ error: "Pass id and verdict (approved | rejected)" }, { status: 400 });
        }
        return NextResponse.json({ item: await forge.review(body.id, body.verdict, body.reason) });
      case "discard":
        if (!body.id) return NextResponse.json({ error: "Pass id" }, { status: 400 });
        return NextResponse.json({ removed: await forge.discard(body.id) });
      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 409 });
  }
}
