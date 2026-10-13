import { NextRequest, NextResponse } from "next/server";
import { SERVICE_REGISTRY, getServiceUrl, getServiceHeaders } from "@/lib/services";
import { servicesForCapability } from "@/lib/host";

export const dynamic = "force-dynamic";
/** Starting a simulation renders its documents first; a few seconds, not minutes. */
export const maxDuration = 120;

/**
 * The Process Lab's window onto the process lab service
 * (C:\Users\Admin\Code\AI\process-lab — its own project, see its README).
 *
 *   GET  /api/labs/process/status   → the services the lab depends on, with health
 *   *    /api/labs/process/<path>   → proxied to the process-lab service
 *
 * Which service that is comes from this host's profile (`serves.process`), so
 * the console on a machine without the lab says so instead of calling a port
 * that is not there. Everything the lab exposes is loopback-only; this route is
 * the only way the browser reaches it.
 */

/** Services the lab leans on, in the order the page shows them. */
const DEPENDENCIES: { id: string; role: string }[] = [
  { id: "process-engine", role: "Runs the BPMN processes and DMN decisions (Operaton)" },
  { id: "process-lab", role: "Workers, simulator and this page's API" },
  { id: "ai-router", role: "Carries every AI call: the local model first, the cloud when the GPU is busy" },
  { id: "laya", role: "Decision model for the triage step (/api/decide)" },
  { id: "ollama", role: "Local LLM: document reading, emails, case briefs (Gemma 4)" },
  { id: "voice", role: "Spoken status update, when it earns its place" },
];

function labService() {
  return servicesForCapability("process")[0] ?? null;
}

async function health(id: string): Promise<boolean | null> {
  const svc = SERVICE_REGISTRY.find((s) => s.id === id);
  if (!svc) return null; // not on this host
  try {
    const res = await fetch(getServiceUrl(id) + svc.healthPath, { headers: getServiceHeaders(id), signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function status() {
  const lab = labService();
  const services = await Promise.all(
    DEPENDENCIES.map(async (d) => {
      const svc = SERVICE_REGISTRY.find((s) => s.id === d.id);
      return { id: d.id, name: svc?.name ?? d.id, role: d.role, onHost: !!svc, up: await health(d.id) };
    }),
  );
  return { lab: lab ? { id: lab.id, name: lab.name } : null, services };
}

async function proxy(req: NextRequest, path: string[]) {
  const lab = labService();
  if (!lab) {
    return NextResponse.json({ error: "No service on this host serves the process capability. See config/hosts/<host>.json." }, { status: 404 });
  }
  const sub = path.map(encodeURIComponent).join("/");
  // Only the lab's own API and its files — never an arbitrary path on the box.
  if (!/^(api|files)\//.test(sub)) return NextResponse.json({ error: "not a process-lab path" }, { status: 400 });
  const target = `${getServiceUrl(lab.id)}/${sub}${req.nextUrl.search}`;
  let res: Response;
  try {
    res = await fetch(target, {
      method: req.method,
      headers: { "content-type": req.headers.get("content-type") ?? "application/json" },
      body: req.method === "GET" ? undefined : await req.text(),
      signal: AbortSignal.timeout(maxDuration * 1000),
    });
  } catch (e) {
    return NextResponse.json({ error: `${lab.name} is not answering: ${e instanceof Error ? e.message : String(e)}`, down: true }, { status: 503 });
  }
  const type = res.headers.get("content-type") ?? "application/octet-stream";
  if (type.startsWith("application/json")) return NextResponse.json(await res.json(), { status: res.status });
  return new NextResponse(await res.arrayBuffer(), { status: res.status, headers: { "content-type": type, "cache-control": res.headers.get("cache-control") ?? "no-store" } });
}

type Ctx = { params: Promise<{ path: string[] }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const { path } = await ctx.params;
  if (path.length === 1 && path[0] === "status") return NextResponse.json(await status());
  return proxy(req, path);
}

export async function POST(req: NextRequest, ctx: Ctx) {
  return proxy(req, (await ctx.params).path);
}
