import { NextRequest, NextResponse } from "next/server";
import { getCatalogue } from "@/lib/providers";
import { ollamaModelFromTarget, residentModels, loadOne } from "@/lib/ollama";

export const dynamic = "force-dynamic";

/**
 * Load ONE Ollama model onto the card, without asking it anything.
 *
 * The mirror of ../unload. Ollama loads a model on first use, so strictly this
 * is not required — but "not required" produced a picker showing a model as
 * "ready to load" beside a greyed-out Unload and no other control, which is a
 * dead end from the user's side. Pressing Load and watching the row go green is
 * a different thing from sending a prompt and waiting thirty seconds on a
 * spinner, wondering whether it is stuck.
 *
 * Resolution goes through the catalogue for the same reason unload does: the
 * router's alias table is the authority on which names are ours to act on.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const alias: unknown = body?.model;

  if (typeof alias !== "string" || !alias.trim()) {
    return NextResponse.json({ error: "model is required" }, { status: 400 });
  }

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
      { error: `"${alias}" is not served by Ollama — start its service instead.` },
      { status: 400 },
    );
  }

  const target = ollamaModelFromTarget(entry.target);
  if (!target) {
    return NextResponse.json({ error: `Could not resolve an Ollama model for "${alias}".` }, { status: 400 });
  }

  // Already resident is success, not an error: the button's purpose is the end
  // state, and reporting a failure for it would be noise.
  const before = await residentModels();
  if (before.some((m) => m.name === target)) {
    return NextResponse.json({ ok: true, model: alias, target, loaded: true, message: "Already loaded." });
  }

  const loaded = await loadOne(target);
  return NextResponse.json({
    ok: true,
    model: alias,
    target,
    loaded,
    ...(loaded
      ? {}
      : { message: "Ollama accepted the request but the model is not resident yet — it may still be reading from disk." }),
  });
}
