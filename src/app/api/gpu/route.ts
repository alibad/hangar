import { NextResponse } from "next/server";

const MANAGER_URL = "http://localhost:8003";

export async function GET() {
  try {
    // /gpu enumerates every GPU process (nvidia-smi) and routinely takes ~10s
    // on a busy box — give it margin so the dashboard doesn't flap at the edge.
    const res = await fetch(`${MANAGER_URL}/gpu`, {
      signal: AbortSignal.timeout(25000),
    });
    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: `Manager unreachable: ${err instanceof Error ? err.message : err}` },
      { status: 502 }
    );
  }
}
