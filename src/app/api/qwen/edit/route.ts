import { NextRequest, NextResponse } from "next/server";
import { getServiceUrl, getServiceHeaders } from "@/lib/services";
import { saveImage, safeFolder } from "@/lib/save-image";
import { nodePost } from "@/lib/qwen-http";
import { withTraffic, TARGET_HEADER } from "@/lib/with-traffic";
import { ResourceLeaseError, withResourceLease } from "@/lib/resource-manager";

export const maxDuration = 800;

export const POST = withTraffic(async (req: NextRequest) => {
  const reply = (body: object, status = 200) => {
    const res = NextResponse.json(body, { status });
    res.headers.set(TARGET_HEADER, "qwen");
    return res;
  };
  const start = Date.now();
  try {
    const body = await req.json();
    const images: string[] = Array.isArray(body.images) ? body.images : [];
    const prompt = String(body.prompt ?? "").trim();
    const folder = safeFolder(body.folder == null ? "" : String(body.folder));
    if (!prompt) return reply({ error: "An edit instruction is required" }, 400);
    if (!images.length || images.some((image) => typeof image !== "string")) return reply({ error: "Choose at least one input image" }, 400);
    if (folder === null) return reply({ error: "Invalid destination gallery" }, 400);
    const seed = Number.isFinite(body.seed) ? Math.floor(body.seed) : Math.floor(Math.random() * 2_147_483_647);
    const payload = { prompt, images, negative_prompt: body.negative_prompt || " ", steps: Math.max(1, Math.floor(body.steps ?? 28)), cfg: Number(body.cfg ?? 4), seed };
    // Keep the lease until the entire image arrives, including a cold model swap.
    // node:http avoids the optional undici dispatcher's five-minute timeout.
    const buf = await withResourceLease("qwen-edit", {
      owner: "console:image:" + String(body.requestId || "qwen-edit").slice(0, 100),
      lane: "interactive", signal: req.signal,
    }, () => nodePost(getServiceUrl("qwen") + "/edit", JSON.stringify(payload),
      getServiceHeaders("qwen", { "Content-Type": "application/json", "X-Source": "console" }), req.signal));
    const health = await fetch(getServiceUrl("qwen") + "/health", { signal: AbortSignal.timeout(3000) }).then((r) => r.json()).catch(() => null);
    const model = health?.edit?.model || "qwen-image-edit";
    const latency = Date.now() - start;
    const width = buf.length >= 24 ? buf.readUInt32BE(16) : undefined;
    const height = buf.length >= 24 ? buf.readUInt32BE(20) : undefined;
    const saved = await saveImage(buf, { kind: "edit", model, prompt, seed, width, height, steps: payload.steps, cfg: payload.cfg, inputCount: images.length, latency, folder });
    return reply({ status: "success", enabled: true, image: "data:image/png;base64," + buf.toString("base64"), bytes: buf.length, latency, model, inputCount: images.length, prompt, seed, saved: saved?.file ?? null, savedPath: saved?.path ?? null });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof ResourceLeaseError) return reply({ error: message, code: err.code, resourceBlocked: true, details: err.details }, err.status);
    if (/Qwen (404|501):/.test(message)) return reply({ enabled: false, error: "edit_not_enabled", message: "Image editing is not enabled on the Qwen service." });
    return reply({ error: message }, 502);
  }
});
