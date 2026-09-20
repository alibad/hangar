import { NextResponse } from "next/server";
import { getManagerHeaders, getManagerUrl } from "@/lib/services";

export async function GET() {
  try {
    const response = await fetch(`${getManagerUrl()}/resources`, {
      headers: getManagerHeaders(),
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
