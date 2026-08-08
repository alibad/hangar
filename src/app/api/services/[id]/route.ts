import { NextRequest, NextResponse } from "next/server";

const MANAGER_URL = process.env.MANAGER_URL ?? "http://localhost:8099";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { action } = await req.json();

  if (!["start", "stop", "restart"].includes(action)) {
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  }

  try {
    const res = await fetch(`${MANAGER_URL}/services/${id}/${action}`, {
      method: "POST",
      signal: AbortSignal.timeout(120000),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    return NextResponse.json(
      { error: `Manager error: ${err instanceof Error ? err.message : err}` },
      { status: 502 }
    );
  }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const res = await fetch(`${MANAGER_URL}/services/${id}/logs?tail=50`, {
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    return NextResponse.json(
      { error: `Manager error: ${err instanceof Error ? err.message : err}` },
      { status: 502 }
    );
  }
}
