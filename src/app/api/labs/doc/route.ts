import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";

export const dynamic = "force-dynamic";

/**
 * GET ?path=docs/<file>.md — an experiment write-up, for a Lab to render.
 *
 * Takes the path rather than a Lab id so this route never imports the Labs
 * registry, whose entries reference client components. Confined to .md files
 * directly under docs/ — the same rule validateLabs() enforces on `doc`.
 */
export async function GET(req: NextRequest) {
  const rel = req.nextUrl.searchParams.get("path") ?? "";
  if (!/^docs\/[\w.-]+\.md$/.test(rel)) {
    return NextResponse.json({ error: "path must be docs/<name>.md" }, { status: 400 });
  }
  const docsDir = path.join(process.cwd(), "docs");
  const abs = path.join(process.cwd(), rel);
  if (path.dirname(abs) !== docsDir) return NextResponse.json({ error: "Outside docs/" }, { status: 400 });
  try {
    return NextResponse.json({ path: rel, markdown: await fs.readFile(abs, "utf8") });
  } catch {
    return NextResponse.json({ error: `${rel} does not exist yet.` }, { status: 404 });
  }
}
