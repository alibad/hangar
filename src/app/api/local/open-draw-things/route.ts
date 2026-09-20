import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NextResponse } from "next/server";

const run = promisify(execFile);

/** Open the already-installed native image generator on the local Mac. */
export async function POST() {
  if (process.platform !== "darwin") {
    return NextResponse.json(
      { error: "The local image app is only available on the Mac host." },
      { status: 400 },
    );
  }

  try {
    await run("/usr/bin/open", ["-a", "Draw Things"], { timeout: 10_000 });
    return NextResponse.json({ ok: true });
  } catch (cause) {
    return NextResponse.json(
      { error: cause instanceof Error ? cause.message : String(cause) },
      { status: 500 },
    );
  }
}
