import { NextRequest, NextResponse } from "next/server";
import { getCatalogue } from "@/lib/providers";
import { ollamaModelFromTarget, residentModels, unloadOne } from "@/lib/ollama";

export const dynamic = "force-dynamic";

/**
 * Unload ONE Ollama model, freeing the card without stopping the runtime.
 *
 * Why this exists rather than reusing `POST /api/services/ollama {stop}`: three
 * router aliases share the single `ollama` service, so the service-level Stop is
 * the wrong verb for all of them. Pressing it on one row killed the runtime and
 * took the other two down with it — and in the Text tab, where the picker stops
 * the *other* local models before switching, that resolved to stopping the
 * service hosting the model you had just selected.
 *
 * A model and a service are different things here. Stopping the runtime is still
 * available on the Services tab, where it means what it says.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const alias: unknown = body?.model;

  if (typeof alias !== "string" || !alias.trim()) {
    return NextResponse.json({ error: "model is required" }, { status: 400 });
  }

  // Resolve through the catalogue rather than trusting the body: this endpoint
  // hands a name to a runtime, and the router's own alias table is the only
  // authority on which names are ours to unload.
  const { routerUp, models } = await getCatalogue();
  if (!routerUp) {
    return NextResponse.json({ error: "AI Router is not running." }, { status: 503 });
  }
  const entry = models.find((m) => m.id === alias);
  if (!entry) {
    return NextResponse.json({ error: `Unknown model "${alias}".` }, { status: 400 });
  }
  if (entry.serviceId !== "ollama") {
    return NextResponse.json(
      { error: `"${alias}" is not served by Ollama — stop its service instead.` },
      { status: 400 },
    );
  }

  const target = ollamaModelFromTarget(entry.target);
  if (!target) {
    return NextResponse.json({ error: `Could not resolve an Ollama model for "${alias}".` }, { status: 400 });
  }

  const before = await residentModels();
  if (!before.some((m) => m.name === target)) {
    // Already gone is success, not an error: the button's purpose is the end
    // state, and reporting a failure for it would be noise.
    return NextResponse.json({ ok: true, model: alias, target, released: true, message: "Not loaded." });
  }

  const released = await unloadOne(target);
  return NextResponse.json({
    ok: true,
    model: alias,
    target,
    released,
    ...(released ? {} : { message: "Ollama accepted the unload but the card has not released it yet." }),
  });
}
