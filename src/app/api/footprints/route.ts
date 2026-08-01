import { NextResponse } from "next/server";
import { getFootprintsByService } from "@/lib/providers";

/**
 * What each local model costs on the card, keyed by BeTenshi service id.
 *
 * Read straight from config/model-meta.json rather than the router catalogue,
 * for the reason getFootprintsByService() exists: the router being down is
 * exactly when you're staring at a stopped service wondering whether it fits.
 * It also lets models that aren't router aliases carry a footprint at all —
 * FLUX runs through ComfyUI and the console builds its graph directly, so it
 * appears nowhere in ai-router.yaml.
 */
export async function GET() {
  return NextResponse.json({ footprints: getFootprintsByService() });
}
