import { NextResponse } from "next/server";

const MANAGER_URL = "http://localhost:8003";

export async function GET() {
  try {
    const res = await fetch(`${MANAGER_URL}/services`, {
      signal: AbortSignal.timeout(10000),
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
