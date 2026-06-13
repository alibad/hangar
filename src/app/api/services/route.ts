import { NextResponse } from "next/server";

const MANAGER_URL = "http://localhost:8003";

export async function GET() {
  try {
    // /services health-checks every managed service serially and can exceed
    // 10s on a busy box — give it margin so the tab populates instead of 502ing.
    const res = await fetch(`${MANAGER_URL}/services`, {
      signal: AbortSignal.timeout(25000),
    });
    const data = await res.json();
    // Propagate the upstream status so a 404/500 isn't laundered into a 200.
    // The manager must return an array of services; anything else is an error
    // shape (e.g. FastAPI's {detail:"Not Found"}) and must NOT reach the client
    // as success — the dashboard does managedServices.filter(...).
    if (!res.ok || !Array.isArray(data)) {
      return NextResponse.json(
        { error: "Manager returned an unexpected response", upstream: data },
        { status: res.ok ? 502 : res.status }
      );
    }
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: `Manager unreachable: ${err instanceof Error ? err.message : err}` },
      { status: 502 }
    );
  }
}
