import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "@/lib/services") return next("data:text/javascript,export const getServiceUrl=()=> 'http://comfy.test';", context);
  if (specifier === "./comfy-image-workflows") return next(new URL("../src/lib/comfy-image-workflows.ts", import.meta.url).href, context);
  return next(specifier, context);
} });
const { generateComfyImage } = await import("../src/lib/flux.ts");
test("an accepted ComfyUI image survives client disconnect and releases cached models", async (t) => {
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  const controller = new AbortController();
  const paths = [];
  globalThis.fetch = async (url, options) => {
    const pathname = new URL(url).pathname;
    paths.push(pathname);
    if (pathname === "/prompt") { controller.abort(); return Response.json({ prompt_id: "job" }); }
    assert.equal(options?.signal, undefined);
    if (pathname === "/history/job") return Response.json({ job: { status: { status_str: "success" }, outputs: { 12: { images: [{ filename: "image.png" }] } } } });
    if (pathname === "/view") return new Response("png-bytes");
    if (pathname === "/queue") return Response.json({ queue_running: [], queue_pending: [] });
    if (pathname === "/free") { assert.equal(JSON.parse(options.body).unload_models, true); return Response.json({}); }
    throw new Error(pathname);
  };
  const png = await generateComfyImage("flux2-klein-4b", { prompt: "test", width: 1024, height: 1024, seed: 7, steps: 4 }, controller.signal);
  assert.equal(png.toString(), "png-bytes");
  assert.equal(paths.at(-1), "/free");
});
