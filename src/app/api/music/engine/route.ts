import { NextRequest, NextResponse } from "next/server";
import { getServiceHeaders, getServiceUrl } from "@/lib/services";
import { ResourceLeaseError, withResourceLease } from "@/lib/resource-manager";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * What the running music engine is doing and can do — asked of it, not
 * declared here. `status` is the load phase (so the Lab can say "loading the
 * planner" instead of "offline"); `capabilities` is the task list for whichever
 * DiT is loaded, which is how the Lab knows stems need the base model.
 */
export async function GET() {
  let base: string;
  try {
    base = getServiceUrl("music");
  } catch {
    return NextResponse.json({ up: false, error: "No music service is declared on this host." });
  }
  const get = async (p: string) => {
    const r = await fetch(`${base}${p}`, { headers: getServiceHeaders("music"), signal: AbortSignal.timeout(3000), cache: "no-store" });
    if (!r.ok) throw new Error(`${p} answered ${r.status}`);
    return r.json();
  };
  try {
    const [status, capabilities] = await Promise.all([get("/status"), get("/v1/music/capabilities")]);
    // Something answering on the port is not proof it is this engine: a
    // different app once held it and its 404 JSON crashed the Lab.
    if (typeof status?.phase !== "string" || !Array.isArray(capabilities?.tasks)) {
      return NextResponse.json({ up: false, error: `Something else is answering on ${base} — not the music engine.` });
    }
    return NextResponse.json({ up: true, status, capabilities });
  } catch (e) {
    return NextResponse.json({ up: false, error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Swap the DiT (turbo <-> base). Under the same lease as generation, so a swap
 * cannot land in the middle of someone's run, and the coordinator can refuse it.
 */
export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  const dit = typeof b?.dit === "string" ? b.dit : "";
  if (!dit) return NextResponse.json({ error: "dit is required" }, { status: 400 });
  try {
    const res = await withResourceLease(
      "music-generate",
      { owner: "lab:music:swap", lane: "interactive", ttlMs: maxDuration * 1000, signal: req.signal },
      () =>
        fetch(`${getServiceUrl("music")}/v1/music/model`, {
          method: "POST",
          headers: getServiceHeaders("music", { "Content-Type": "application/json" }),
          body: JSON.stringify({ dit }),
          signal: req.signal,
        }),
    );
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return NextResponse.json({ error: j.detail ?? `Music service returned ${res.status}` }, { status: res.status });
    return NextResponse.json({ capabilities: j });
  } catch (e) {
    if (e instanceof ResourceLeaseError) {
      return NextResponse.json({ error: e.message, resourceBlocked: true }, { status: e.status });
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
