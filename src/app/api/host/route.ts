import { join } from "node:path";

import { NextResponse } from "next/server";
import { getHost } from "@/lib/host";

/**
 * Which machine this console is running on, for the UI.
 *
 * The page uses it to name itself, to label the memory bar correctly (one pool
 * or two), and to show only the tabs whose services exist on this host — the
 * Image studio, SAM 3 and SAM 3D Body are BeTenshi processes, and a tab for a
 * service that is not registered here would be a permanent "unavailable".
 */
export async function GET() {
  const h = getHost();
  return NextResponse.json({
    id: h.id,
    name: h.name,
    platform: h.platform,
    gpu: h.gpu,
    memory: h.memory,
    services: h.services.map((s) => s.id),
    // Absolute path to the MCP server on THIS machine, for the Agent access
    // snippets. Computed rather than written down: it used to be a string
    // literal pointing at one person's Windows checkout, so the config every
    // other user was told to copy named a file they do not have.
    mcpServer: join(process.cwd(), "scripts", "mcp-hangar.mjs"),
  });
}
