import { NextResponse } from "next/server";

const MANAGER_URL = process.env.MANAGER_URL ?? "http://localhost:8099";

export async function GET() {
  try {
    const response = await fetch(`${MANAGER_URL}/resources`, {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    const body = await response.json();
    return NextResponse.json(body, { status: response.status });
  } catch (error) {
    return NextResponse.json(
      { error: `Manager error: ${error instanceof Error ? error.message : String(error)}` },
      { status: 502 },
    );
  }
}
