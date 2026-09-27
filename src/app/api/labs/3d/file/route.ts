import { NextRequest, NextResponse } from "next/server";
import { readFile, stat } from "fs/promises";
import { resolveMeshFile } from "@/lib/mesh3d";

export const dynamic = "force-dynamic";

const TYPES: Record<string, string> = {
  png: "image/png",
  glb: "model/gltf-binary",
  json: "application/json",
};

/**
 * Serve a 3D Lab artifact: only .png/.glb/.json directly inside generated/3d/<job>/.
 *
 * Revalidated rather than immutable: a re-cut overwrites cutout.png under the
 * same name, so a cached copy must be checked — a 304 costs nothing next to
 * re-sending a 10 MB GLB, and a stale one would show the wrong object.
 */
export async function GET(req: NextRequest) {
  const rel = req.nextUrl.searchParams.get("rel");
  const abs = resolveMeshFile(rel);
  if (!abs) return NextResponse.json({ error: "bad path" }, { status: 400 });
  try {
    const st = await stat(abs);
    const lastModified = new Date(Math.floor(st.mtimeMs / 1000) * 1000).toUTCString();
    const since = req.headers.get("if-modified-since");
    const headers = { "Last-Modified": lastModified, "Cache-Control": "private, no-cache" };
    if (since && Date.parse(since) >= Date.parse(lastModified)) return new NextResponse(null, { status: 304, headers });
    const buf = await readFile(abs);
    const ext = abs.split(".").pop()!.toLowerCase();
    return new NextResponse(new Uint8Array(buf), {
      headers: { ...headers, "Content-Type": TYPES[ext] ?? "application/octet-stream", "Content-Length": String(buf.length) },
    });
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}
