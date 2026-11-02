import { NextRequest } from "next/server";
import { isHostedRuntime } from "@/lib/runtime";
import { collectionSamples, libraryConfig, resolveMediaFile } from "@/lib/library";
import { previewFor, type PreviewVariant } from "@/lib/library-previews";
import { serveFile } from "@/lib/http-range";

export const dynamic = "force-dynamic";

const VARIANTS = new Set<PreviewVariant>(["poster", "scrub", "wave"]);

/**
 * GET ?id=&v=poster|scrub|wave&w=480 — a cached preview, made on first ask.
 * A model's poster is its 3D job's picture; a collection's is a mosaic.
 */
export async function GET(request: NextRequest) {
  if (isHostedRuntime()) return new Response("Run Hangar locally", { status: 501 });
  const params = request.nextUrl.searchParams;
  const variant = (params.get("v") ?? "poster") as PreviewVariant;
  if (!VARIANTS.has(variant)) return new Response("Unknown preview", { status: 400 });
  const width = Math.min(Math.max(Number(params.get("w")) || 480, 120), 1600);
  const id = params.get("id") ?? "";
  let file = await resolveMediaFile(id);
  if (!file) return new Response("Not found", { status: 404 });
  if (file.kind === "model") {
    file = await resolveMediaFile(id, { poster: true });
    if (!file) return new Response("No poster", { status: 404 });
  }
  const preview = await previewFor(file, variant, {
    cacheDir: libraryConfig().cacheDir,
    width,
    samples: file.kind === "collection" ? collectionSamples(file.row) : undefined,
  });
  if (!preview) return new Response("No preview", { status: 404 });
  // Keyed by the file's size and time, so the browser may keep it a day.
  return serveFile(request, preview.path, preview.type, { cacheControl: "private, max-age=86400" });
}
