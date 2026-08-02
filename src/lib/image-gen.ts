// Single text→image path for the studio, dispatching on model.
//
// Both backends land here so their output is persisted identically — same
// saveImage() call, so the same gallery, DuckDB row, and Activity feed entry
// regardless of which model produced it. /api/qwen/generate keeps its existing
// request and response shape by delegating here with the model pinned, so
// external callers (quote-forge, scripts) are unaffected.

import { getServiceUrl, getServiceHeaders } from "@/lib/services";
import { saveImage } from "@/lib/save-image";
import { nodePost } from "@/lib/qwen-http";
import { generateFlux } from "@/lib/flux";
import { getImageModel, isImageModelId, type ImageModelId } from "@/lib/image-models";
import { routerUrl } from "@/lib/providers";

/**
 * Which backend served (or would have served) the call.
 *
 * Reported back so the Requests view can say where a console route sent the
 * work: the three paths below are indistinguishable from the outside, and the
 * row for all of them just read "console · POST /api/image/generate".
 */
export type GenerateTarget = "qwen" | "comfyui" | "ai-router";

export type GenerateResult =
  | { ok: true; target: GenerateTarget; body: Record<string, unknown> }
  | { ok: false; target: GenerateTarget; status: number; body: Record<string, unknown> };

type GenPayload = {
  prompt: string;
  negative_prompt: string;
  width: number;
  height: number;
  steps: number;
  cfg: number;
  seed: number;
};

/**
 * A cloud image model, reached through the AI Router.
 *
 * Local models are called directly (see resolveCallTarget's reasoning: no extra
 * hop, and the studio keeps working when the router is down). Cloud models have
 * no such option — the router is the only place vendor ids and keys live — so
 * this is the one image path that must go through it.
 *
 * The local-only knobs are sent regardless: the router runs with drop_params, so
 * a provider that doesn't understand `steps` or `cfg` ignores them instead of
 * 400-ing, which is what lets one prompt fan out across every model unchanged.
 */
async function generateViaRouter(alias: string, p: GenPayload): Promise<Buffer> {
  // nodePost, NOT fetch. undici caps headersTimeout at 300s regardless of any
  // AbortSignal you pass, and a routed local generation blows straight through
  // that — measured: a 308s run died with a bare "fetch failed" that looked like
  // the router was down. This is the same reason the direct Qwen path uses it.
  const raw = await nodePost(
    `${routerUrl()}/v1/images/generations`,
    JSON.stringify({
      model: alias,
      prompt: p.prompt,
      size: `${p.width}x${p.height}`,
      n: 1,
      response_format: "b64_json",
      negative_prompt: p.negative_prompt,
      steps: p.steps,
      cfg: p.cfg,
      seed: p.seed,
    }),
    { "Content-Type": "application/json", "X-Source": "console/compare" },
    undefined,
    "AI Router",
  );

  const json = JSON.parse(raw.toString("utf8"));
  const b64 = json?.data?.[0]?.b64_json;
  if (typeof b64 !== "string" || !b64) throw new Error("AI Router returned no image data");
  return Buffer.from(b64, "base64");
}

export async function generateAndSave(
  raw: Record<string, unknown>,
  forceModel?: ImageModelId,
): Promise<GenerateResult> {
  const start = Date.now();
  const requested = forceModel ?? (raw.model as string);
  // Anything not in the local registry is treated as a router alias. Checked
  // BEFORE getImageModel(), which silently falls back to the first local model —
  // that fallback would quietly run a cloud comparison on Qwen instead.
  const viaRouter = !!requested && !isImageModelId(requested);
  const model = getImageModel(requested);
  const target: GenerateTarget = viaRouter ? "ai-router" : model.serviceId;

  const seed =
    Number.isFinite(raw.seed as number) && raw.seed != null
      ? Math.floor(raw.seed as number)
      : Math.floor(Math.random() * 2_147_483_647);

  const payload = {
    prompt: String(raw.prompt ?? "").trim(),
    negative_prompt: (raw.negative_prompt as string) || " ",
    width: Math.max(256, Math.floor((raw.width as number) ?? 1024)),
    height: Math.max(256, Math.floor((raw.height as number) ?? 1024)),
    steps: Math.max(1, Math.floor((raw.steps as number) ?? model.steps[0])),
    cfg: model.supportsCfg ? Number(raw.cfg ?? model.defaultCfg) : model.defaultCfg,
    seed,
  };

  if (!payload.prompt) {
    return { ok: false, target, status: 400, body: { error: "Prompt is required" } };
  }

  try {
    let buf: Buffer;

    if (viaRouter) {
      buf = await generateViaRouter(requested, payload);
    } else if (model.id === "flux-schnell") {
      buf = await generateFlux({
        prompt: payload.prompt,
        width: payload.width,
        height: payload.height,
        steps: payload.steps,
        seed,
      });
    } else {
      const base = getServiceUrl("qwen");
      const headers = getServiceHeaders("qwen", { "Content-Type": "application/json", "X-Source": "console" });
      buf = await nodePost(`${base}/generate`, JSON.stringify(payload), headers);
    }

    const latency = Date.now() - start;
    // Record the alias that was actually asked for, not the local fallback —
    // otherwise every cloud comparison would archive as "qwen-image".
    const modelId = viaRouter ? requested : model.id;
    const saved = await saveImage(buf, { kind: "generate", model: modelId, ...payload, latency });

    return {
      ok: true,
      target,
      body: {
        status: "success",
        image: `data:image/png;base64,${buf.toString("base64")}`,
        bytes: buf.length,
        latency,
        model: modelId,
        saved: saved?.file ?? null,
        savedPath: saved?.path ?? null,
        ...payload,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const cause = err instanceof Error && err.cause ? String(err.cause) : "";
    return { ok: false, target, status: 500, body: { error: message, cause } };
  }
}
