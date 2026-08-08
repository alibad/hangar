import { NextRequest, NextResponse } from "next/server";
import { generateAndSave } from "@/lib/image-gen";
import { getCatalogue } from "@/lib/providers";
import { IMAGE_MODELS, isImageModelId } from "@/lib/image-models";

// One prompt, N models, side by side.
//
// This is the question the router was built to answer — "is the local 20B good
// enough, or is a cloud model worth the money?" — and it was previously
// unanswerable without running each model by hand and eyeballing the results.
//
// Deliberately N parallel STANDARD calls rather than a bespoke fan-out endpoint:
// each one is independently cancellable, retryable, logged in the Requests view
// and costed by LiteLLM. A custom multi-model endpoint would give all of that up
// and re-introduce exactly the routing code the router exists to avoid.
export const maxDuration = 800;

/** Same seed across every model, or the comparison measures luck, not quality. */
function pickSeed(raw: Record<string, unknown>): number {
  const s = raw.seed;
  return Number.isFinite(s as number) && s != null
    ? Math.floor(s as number)
    : Math.floor(Math.random() * 2_147_483_647);
}

export async function POST(req: NextRequest) {
  const raw = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const prompt = String(raw.prompt ?? "").trim();
  const models = Array.isArray(raw.models) ? raw.models.map(String).filter(Boolean) : [];

  if (!prompt) return NextResponse.json({ error: "Prompt is required" }, { status: 400 });
  if (models.length < 2) {
    return NextResponse.json({ error: "Pick at least two models to compare" }, { status: 400 });
  }
  if (models.length > 6) {
    return NextResponse.json({ error: "At most six models per run" }, { status: 400 });
  }

  // Published rates, for the cost column. Read from the router's own model_info
  // rather than hardcoded here, so a price change lands in one place.
  const priced = new Map<string, number | undefined>();
  try {
    const { models: catalogue } = await getCatalogue();
    for (const m of catalogue) {
      priced.set(m.id, m.costPerImage);
    }
  } catch {
    /* catalogue unavailable — the run still works, just without prices */
  }

  const seed = pickSeed(raw);
  const base = {
    prompt,
    negative_prompt: raw.negative_prompt,
    width: raw.width,
    height: raw.height,
    steps: raw.steps,
    cfg: raw.cfg,
    seed,
  };

  // All at once. Cloud calls really do run in parallel; local ones queue behind
  // the manager's measured GPU/RAM admission policy.
  const results = await Promise.all(
    models.map(async (id) => {
      const started = Date.now();
      try {
        const r = await generateAndSave({ ...base, model: id });
        const local = isImageModelId(id);
        return {
          model: id,
          label: local ? (IMAGE_MODELS.find((m) => m.id === id)?.name ?? id) : id,
          local,
          ok: r.ok,
          ms: Date.now() - started,
          costUsd: local ? 0 : priced.get(id),
          ...(r.ok
            ? { image: r.body.image, saved: r.body.saved, savedPath: r.body.savedPath }
            : { error: String(r.body.error ?? "failed") }),
        };
      } catch (e) {
        // One model failing must not lose the others' results — a cloud 429 is
        // itself a useful comparison outcome.
        return {
          model: id,
          label: id,
          local: isImageModelId(id),
          ok: false,
          ms: Date.now() - started,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }),
  );

  return NextResponse.json({ prompt, seed, results });
}
