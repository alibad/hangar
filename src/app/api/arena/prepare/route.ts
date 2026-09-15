import { NextRequest, NextResponse } from "next/server";
import { getCatalogue } from "@/lib/providers";
import { SERVICE_REGISTRY } from "@/lib/services";
import { ollamaModelFromTarget, residentModels, unloadOne } from "@/lib/ollama";

export const dynamic = "force-dynamic";
/** Starting vLLM means loading ~20 GB of weights. Two minutes is normal. */
export const maxDuration = 600;

const MANAGER_URL = process.env.MANAGER_URL ?? "http://localhost:8099";

/**
 * Make a model runnable: start its service, stopping whatever is in the way.
 *
 * The Arena used to refuse to select a model whose service was stopped, which
 * put the work on the reader — go to Services, work out what to stop, start the
 * right thing, come back. But the console already knows all of that: which
 * service backs the model, what else is holding the card, and that these models
 * are mutually exclusive. Picking a model is a statement of intent, and the
 * system can carry it out.
 *
 * This is a SEPARATE call from /api/arena/run rather than a step inside it, for
 * one reason: a cold vLLM start is around two minutes, and a tile that says
 * "Running" for two minutes before any token appears looks hung. Preparing is a
 * distinct state with the service's name in it, so the wait is explained.
 *
 * Everything here is reversible and already available by hand on the Services
 * tab — this only saves the trip.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const alias: unknown = body?.model;
  if (typeof alias !== "string" || !alias.trim()) {
    return NextResponse.json({ error: "model is required" }, { status: 400 });
  }

  const { routerUp, models } = await getCatalogue();
  if (!routerUp) {
    return NextResponse.json({ error: "AI Router is not running. Start it from Services." }, { status: 503 });
  }
  const entry = models.find((m) => m.id === alias);
  if (!entry) return NextResponse.json({ error: `Unknown model "${alias}".` }, { status: 400 });

  // Cloud models need no preparation; they cost money, not memory.
  if (!entry.local) return NextResponse.json({ ready: true, model: alias, cloud: true });

  // A local model with no registered service cannot be started by us. Say so
  // rather than pretending to try.
  if (!entry.serviceId) {
    return NextResponse.json(
      { error: `"${alias}" has no BeTenshi service registered on its port.` },
      { status: 400 },
    );
  }
  if (entry.keyEnv) {
    return NextResponse.json({ error: entry.detail ?? `"${alias}" is missing its credential.` }, { status: 409 });
  }

  const target = entry.serviceId;
  const stopped: string[] = [];
  const unloaded: string[] = [];

  /*
   * Which local services conflict.
   *
   * Every service backing a local CHAT model on this box wants 17-26 GB of a
   * 31.8 GB card, so no two can be resident at once. That is the whole reason
   * the Text tab has `exclusiveLocal` and the Arena runs local models in turn.
   * Derived from the catalogue rather than hardcoded, so a new local runtime is
   * covered the day its models appear.
   */
  const conflicting = [
    ...new Set(
      models
        .filter((m) => m.local && m.mode === "chat" && m.serviceId && m.serviceId !== target)
        .map((m) => m.serviceId as string),
    ),
  ];

  for (const id of conflicting) {
    const svc = SERVICE_REGISTRY.find((s) => s.id === id);
    if (!svc) continue;
    if (!(await healthy(svc.id))) continue;
    /*
     * Ollama is evicted, not stopped.
     *
     * It is one runtime hosting several aliases, and it costs nothing while
     * holding no model. Stopping it to free the card would be needlessly
     * destructive — and would take down the sibling aliases with it, which is
     * the same mistake the model picker's Stop button used to make.
     */
    if (id === "ollama") {
      for (const m of await residentModels()) {
        await unloadOne(m.name);
        unloaded.push(m.name);
      }
      continue;
    }
    const res = await manager(`/services/${id}/stop`);
    if (res.ok) stopped.push(svc.name);
  }

  // Ollama itself: the runtime stays up, but a DIFFERENT model of its own must
  // go, since it holds one at a time.
  if (target === "ollama") {
    const want = ollamaModelFromTarget(entry.target);
    for (const m of await residentModels()) {
      if (m.name !== want) {
        await unloadOne(m.name);
        unloaded.push(m.name);
      }
    }
  }

  // Already up? Nothing more to do.
  if (await healthy(target)) {
    return NextResponse.json({ ready: true, model: alias, service: target, stopped, unloaded, started: false });
  }

  const start = await manager(`/services/${target}/start`);
  if (!start.ok) {
    return NextResponse.json(
      {
        error: start.body?.error ?? `Could not start ${target}.`,
        // The coordinator's own refusal, when that is what happened — it names
        // what is holding the card, which is what the reader needs.
        resourceBlocked: Boolean(start.body?.resourceBlocked),
        details: start.body?.denial ?? start.body?.details,
        stopped,
        unloaded,
      },
      { status: start.status === 409 ? 409 : 502 },
    );
  }

  // Started is not ready: vLLM binds its port only after the weights are in.
  const deadline = Date.now() + (maxDuration - 30) * 1000;
  while (Date.now() < deadline) {
    if (await healthy(target)) {
      return NextResponse.json({ ready: true, model: alias, service: target, stopped, unloaded, started: true });
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  return NextResponse.json(
    {
      error: `${target} was started but did not become healthy in time. Check its logs on the Services tab.`,
      stopped,
      unloaded,
    },
    { status: 504 },
  );
}

async function healthy(id: string): Promise<boolean> {
  const svc = SERVICE_REGISTRY.find((s) => s.id === id);
  if (!svc) return false;
  try {
    const res = await fetch(svc.localUrl + svc.healthPath, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function manager(path: string): Promise<{ ok: boolean; status: number; body: Record<string, unknown> | null }> {
  try {
    const res = await fetch(`${MANAGER_URL}${path}`, { method: "POST", signal: AbortSignal.timeout(180_000) });
    const body = await res.json().catch(() => null);
    return { ok: res.ok && !body?.error, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 502, body: { error: `Manager unreachable: ${err}` } };
  }
}
