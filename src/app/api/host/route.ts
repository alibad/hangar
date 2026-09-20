import { hostname } from "node:os";
import { join } from "node:path";

import { NextResponse } from "next/server";
import { getHost } from "@/lib/host";
import { isHostedRuntime } from "@/lib/runtime";

/**
 * Which machine this console is running on, for the UI.
 *
 * The page uses it to name itself, to label the memory bar correctly (one pool
 * or two), and to show only the tabs whose services exist on this host — the
 * Image studio, SAM 3 and SAM 3D Body are BeTenshi processes, and a tab for a
 * service that is not registered here would be a permanent "unavailable".
 */
const MACHINE = hostname();

export async function GET() {
  const h = getHost();
  const hosted = isHostedRuntime();
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
    mcpServer: hosted ? null : join(process.cwd(), "scripts", "mcp-hangar.mjs"),
    runtime: hosted ? "hosted" : "local",

    // ── Is the profile being shown actually THIS machine? ─────────────────
    //
    // Host resolution ends in a guess: a Mac with no matching profile resolves
    // to `b5`, anything else to the default. That is right for the two machines
    // this was built on and wrong for everyone else — a stranger's first run
    // renders another person's services under another person's machine name,
    // with nothing saying so. The page needs to be able to tell them.
    machine: MACHINE,
    matchesProfile: hosted ? null : MACHINE.toLowerCase().replace(/\.local$/, "") === h.id.toLowerCase(),
  });
}
