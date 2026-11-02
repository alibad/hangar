import { NextRequest, NextResponse } from "next/server";
import { isHostedRuntime } from "@/lib/runtime";
import { countMedia, facetCounts, getMedia, libraryConfig, librarySummary, listMedia, projectMedia, scanIfStale, scanStudios, startScan, type LibraryFilter } from "@/lib/library";
import { revealInExplorer } from "@/lib/reveal-in-explorer";

export const dynamic = "force-dynamic";

const local = () =>
  isHostedRuntime() ? NextResponse.json({ error: "The Library reads this machine's drives. Run Hangar locally.", available: false }, { status: 501 }) : null;

function filterFrom(params: URLSearchParams): LibraryFilter {
  const pick = (key: string) => params.get(key)?.trim() || undefined;
  const num = (key: string) => (params.get(key) ? Number(params.get(key)) || undefined : undefined);
  return {
    shelf: pick("shelf"), project: pick("project"), group: pick("group"), studio: pick("studio"), kind: pick("kind"),
    faction: pick("faction"), status: pick("status"), q: pick("q"), from: num("from"), to: num("to"), dir: pick("dir"),
  };
}

/**
 * GET ?view=summary            shelves, banner posters, filter values, scan state
 * GET ?view=list&<filters>     one page of the wall (cursor, limit)
 * GET ?view=item&id=           everything known about one file
 * GET ?view=project&repo=      a World project's newest posters
 * GET ?view=roots               the folders the Library reads, and their shelves
 */
export async function GET(request: NextRequest) {
  const refused = local();
  if (refused) return refused;
  const params = request.nextUrl.searchParams;
  const view = params.get("view") || "list";
  try {
    if (view === "summary") {
      await scanIfStale();
      return NextResponse.json(await librarySummary());
    }
    if (view === "item") {
      const item = await getMedia(params.get("id") ?? "");
      return item ? NextResponse.json(item) : NextResponse.json({ error: "Not in the Library" }, { status: 404 });
    }
    if (view === "roots") {
      return NextResponse.json({ roots: libraryConfig().roots.map((r) => ({ path: r.path, shelf: r.shelf })) });
    }
    if (view === "project") {
      return NextResponse.json(await projectMedia(params.get("repo") ?? "", Number(params.get("limit")) || 8));
    }
    const filter = filterFrom(params);
    const cursor = params.get("cursor") ?? undefined;
    const page = await listMedia({ ...filter, cursor, limit: Number(params.get("limit")) || undefined });
    // The total and the filters' counts only on the first page; scrolling doesn't change them.
    if (cursor) return NextResponse.json(page);
    const [total, facets] = await Promise.all([countMedia(filter), facetCounts(filter)]);
    return NextResponse.json({ ...page, total, facets });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

/**
 * POST {action:"scan"}                    rescan everything, in the background
 * POST {action:"scan", scope:"studios"}   re-read Hangar's studio folders, and answer when done
 * POST {action:"reveal", id}              show the file in Explorer
 */
export async function POST(request: NextRequest) {
  const refused = local();
  if (refused) return refused;
  const body = (await request.json().catch(() => ({}))) as { action?: string; id?: string; scope?: string };
  try {
    if (body.action === "scan" && body.scope === "studios") return NextResponse.json(await scanStudios());
    if (body.action === "scan") return NextResponse.json(startScan());
    if (body.action === "reveal") {
      const item = await getMedia(body.id ?? "");
      if (!item) return NextResponse.json({ error: "Not in the Library" }, { status: 404 });
      return NextResponse.json(await revealInExplorer(item.path, { select: item.kind !== "collection" }));
    }
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
