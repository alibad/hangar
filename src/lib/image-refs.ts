// A hosted image model drawing from reference images, through the AI Router.
//
// The Video Forge draws each story's characters once (a character sheet) and
// then makes every shot from those sheets, so a face and a costume stay the
// same across a film — drawn from text alone, every shot reinvented them.
// gpt-image-2.5-sunburst takes up to 16 input images on the router's
// /v1/images/edits; measured 3 Oct: ~20 s with one 1536×1024 reference, and a
// bald man in a linen tunic came back the same man on a different path.
//
// Saved through saveImage(), like every other generation, so the image lands in
// the same gallery and Activity feed; the router records the spend.

import fs from "node:fs/promises";
import path from "node:path";
import { saveImage } from "@/lib/save-image";
import { routerUrl } from "@/lib/providers";

/** The sizes hosted models accept everywhere; the nearest in aspect ratio. */
function hostedSize(width: number, height: number): [number, number] {
  const r = width / height;
  return r > 1.2 ? [1536, 1024] : r < 1 / 1.2 ? [1024, 1536] : [1024, 1024];
}

export type RefImageResult = { ok: true; savedPath: string | null; latency: number; model: string; width: number; height: number } | { ok: false; error: string };

/**
 * One image from a hosted model, with reference images (absolute paths) when
 * given — none makes it a plain generation. Never throws.
 */
export async function generateWithReferences(opts: {
  model: string;
  prompt: string;
  width: number;
  height: number;
  references?: string[];
  folder?: string;
  source?: string;
}): Promise<RefImageResult> {
  const t0 = Date.now();
  const [w, h] = hostedSize(opts.width, opts.height);
  const refs = (opts.references ?? []).slice(0, 8);
  try {
    let res: Response;
    if (refs.length) {
      const form = new FormData();
      form.set("model", opts.model);
      form.set("prompt", opts.prompt);
      form.set("size", `${w}x${h}`);
      form.set("n", "1");
      for (const file of refs) form.append("image[]", new Blob([await fs.readFile(file)], { type: "image/png" }), path.basename(file));
      res = await fetch(`${routerUrl()}/v1/images/edits`, { method: "POST", body: form, headers: { "X-Source": opts.source ?? "console/forge" }, signal: AbortSignal.timeout(240_000) });
    } else {
      res = await fetch(`${routerUrl()}/v1/images/generations`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Source": opts.source ?? "console/forge" },
        body: JSON.stringify({ model: opts.model, prompt: opts.prompt, size: `${w}x${h}`, n: 1, response_format: "b64_json" }),
        signal: AbortSignal.timeout(240_000),
      });
    }
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `AI Router ${refs.length ? "image edit" : "image"}: HTTP ${res.status} ${text.slice(0, 300)}` };
    const b64 = JSON.parse(text)?.data?.[0]?.b64_json;
    if (typeof b64 !== "string" || !b64) return { ok: false, error: "AI Router returned no image data" };
    const latency = Date.now() - t0;
    const saved = await saveImage(Buffer.from(b64, "base64"), {
      kind: refs.length ? "edit" : "generate",
      model: opts.model,
      prompt: opts.prompt,
      width: w,
      height: h,
      seed: 0,
      latency,
      folder: opts.folder ?? "forge",
      ...(refs.length ? { references: refs.map((r) => path.basename(r)) } : {}),
    });
    return { ok: true, savedPath: saved?.path ?? null, latency, model: opts.model, width: w, height: h };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** A model id the router serves from the cloud (anything not a local image model). */
export const isHostedImageModel = (id: string) => /^(gpt-image|chatgpt-image|dall-e|imagen|gemini-.*image|flux-pro|ideogram|recraft)/.test(id);
