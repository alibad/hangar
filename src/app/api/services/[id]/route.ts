import { NextRequest, NextResponse } from "next/server";
import { getManagerHeaders, getManagerUrl } from "@/lib/services";
import { withTraffic } from "@/lib/with-traffic";

async function handlePost(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { action } = await req.json();

  if (!["start", "stop", "restart"].includes(action)) {
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  }

  try {
    const res = await fetch(`${getManagerUrl()}/services/${id}/${action}`, {
      method: "POST",
      headers: getManagerHeaders({ "Content-Type": "application/json" }),
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

export const POST = withTraffic(handlePost);

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const res = await fetch(`${getManagerUrl()}/services/${id}/logs?tail=50`, {
      headers: getManagerHeaders(),
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
