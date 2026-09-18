// Single text→image path for the studio, dispatching on model.
//
// Both backends land here so their output is persisted identically — same
// saveImage() call, so the same gallery, DuckDB row, and Activity feed entry
// regardless of which model produced it. /api/qwen/generate keeps its existing
// request and response shape by delegating here with the model pinned, so
// external callers (quote-forge, scripts) are unaffected.

import { getServiceUrl, getServiceHeaders } from "@/lib/services";
import { saveImage, safeFolder } from "@/lib/save-image";
import { nodePost } from "@/lib/qwen-http";
import { generateFlux, generateComfyImage } from "@/lib/flux";
import { getImageModel, isImageModelId, type ImageModelId } from "@/lib/image-models";
import { getCatalogue, routerUrl } from "@/lib/providers";
import { mirrorImageHistory } from "@/lib/image-history";
import { ResourceLeaseError, withResourceLease, workloadForImageModel } from "@/lib/resource-manager";

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
 * The local-only knobs used to be sent regardless, on the theory that the router
 * runs with drop_params and a provider that doesn't understand `steps` or `cfg`
 * would ignore them. It does not. litellm forwards them to OpenAI's images
 * endpoint, which rejects them one at a time:
 *   400 Unknown parameter: 'negative_prompt'   → remove it, then
 *   400 Unknown parameter: 'steps'             → and so on.
 * Since the payload defaults negative_prompt to a single space rather than "",
 * one was ALWAYS present, so gpt-image-2 could not be generated from this
 * console by any path — not the model dialog, not a comparison.
 *
 * They are diffusion knobs, and a hosted image API has no denoising loop to
 * configure, so the fix is to send them only to models that actually have one.
 * The router's own catalogue already knows which aliases are backed by a local
 * service, which beats keeping a list of provider quirks here.
 */
async function generateViaRouter(alias: string, p: GenPayload): Promise<Buffer> {
  const { models } = await getCatalogue();
  const isDiffusion = models.find((m) => m.id === alias)?.local ?? false;
  const knobs = isDiffusion
    ? {
        ...(p.negative_prompt.trim() ? { negative_prompt: p.negative_prompt } : {}),
        steps: p.steps,
        cfg: p.cfg,
        seed: p.seed,
      }
    : {};
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
      ...knobs,
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
  signal?: AbortSignal,
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

  const folder = safeFolder(raw.folder == null ? "" : String(raw.folder));
  if (folder === null) return { ok: false, target, status: 400, body: { error: "Invalid destination gallery" } };
  try {
    const generate = async () => {
      if (viaRouter) return generateViaRouter(requested, payload);
      if (model.serviceId === "comfyui" && model.id !== "flux-schnell") return generateComfyImage(model.id, payload, signal);
      if (model.id === "flux-schnell") {
        return generateFlux({
          prompt: payload.prompt,
          width: payload.width,
          height: payload.height,
          steps: payload.steps,
          seed,
        }, 900_000, signal);
      }
      const base = getServiceUrl("qwen");
      const headers = getServiceHeaders("qwen", { "Content-Type": "application/json", "X-Source": "console" });
      return nodePost(base + "/generate", JSON.stringify(payload), headers, signal);
    };

    const modelId = viaRouter ? requested : model.id;
    const workload = workloadForImageModel(modelId);
    const buf = workload
      ? await withResourceLease(workload, { owner: "console:image:" + String(raw.requestId || modelId).slice(0, 100), lane: "interactive", signal }, generate)
      : await generate();

    const latency = Date.now() - start;
    // Record the alias that was actually asked for, not the local fallback —
    // otherwise every cloud comparison would archive as "qwen-image".
    const saved = await saveImage(buf, { kind: "generate", model: modelId, ...payload, latency, folder });
    if (target === "comfyui") await mirrorImageHistory(buf, { kind: "generate", model: modelId, ...payload, ms: latency, folder });

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
    const resource = err instanceof ResourceLeaseError;
    return {
      ok: false,
      target,
      status: resource ? err.status : 500,
      body: { error: message, cause, ...(resource ? { code: err.code, resourceBlocked: true, details: err.details } : {}) },
    };
  }
}
