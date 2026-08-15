import { NextRequest, NextResponse } from "next/server";
import {
  browseStorage,
  getCategoryFiles,
  getDuplicateCandidates,
  getStorageOverview,
  revealStoragePath,
  searchStorage,
  setWatching,
  stopScan,
  startMove,
  startScan,
} from "@/lib/storage-index";

export const dynamic = "force-dynamic";

function errorResponse(error: unknown, status = 500) {
  return NextResponse.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status },
  );
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const view = searchParams.get("view") || "overview";
  try {
    if (view === "browse") {
      const target = searchParams.get("path");
      if (!target) return errorResponse("A path is required.", 400);
      return NextResponse.json(await browseStorage(target));
    }
    if (view === "search") {
      const query = searchParams.get("q") || "";
      const root = searchParams.get("root") || undefined;
      return NextResponse.json({ query, items: await searchStorage(query, root) });
    }
    if (view === "duplicates") {
      const root = searchParams.get("root") || undefined;
      return NextResponse.json({ items: await getDuplicateCandidates(root) });
    }
    if (view === "category") {
      const root = searchParams.get("root");
      const category = searchParams.get("category");
      if (!root || !category) return errorResponse("A drive root and category are required.", 400);
      return NextResponse.json({ items: await getCategoryFiles(root, category) });
    }
    return NextResponse.json(await getStorageOverview());
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const action = String(body.action || "");
  try {
    if (action === "scan") {
      if (typeof body.root !== "string") return errorResponse("A drive root is required.", 400);
      return NextResponse.json({ ok: true, ...(await startScan(body.root)) }, { status: 202 });
    }
    if (action === "cancel-scan") {
      return NextResponse.json({ ok: true, ...(await stopScan()) });
    }
    if (action === "watch") {
      if (typeof body.root !== "string" || typeof body.enabled !== "boolean") return errorResponse("A drive root and enabled state are required.", 400);
      return NextResponse.json({ ok: true, ...(await setWatching(body.root, body.enabled)) }, { status: 202 });
    }
    if (action === "reveal") {
      if (typeof body.path !== "string") return errorResponse("A path is required.", 400);
      return NextResponse.json({ ok: true, ...(await revealStoragePath(body.path)) });
    }
    if (action === "move") {
      if (typeof body.source !== "string" || typeof body.destinationDirectory !== "string") return errorResponse("Source and destination paths are required.", 400);
      const conflict = body.conflict === "rename" ? "rename" : "error";
      return NextResponse.json({ ok: true, ...(await startMove(body.source, body.destinationDirectory, conflict)) }, { status: 202 });
    }
    return errorResponse("Unknown storage action.", 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /required|unknown|protected|cannot|already|inside itself/i.test(message) ? 400 : 500;
    return errorResponse(error, status);
  }
}
