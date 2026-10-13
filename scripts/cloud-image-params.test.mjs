import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";
import sharp from "sharp";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@/lib/")) return next(new URL(`../src/lib/${specifier.slice(6)}.ts`, import.meta.url).href, context);
    return next(specifier, context);
  },
});

const reg = await import("../src/lib/cloud-image-models.ts");
const gen = await import("../src/lib/cloud-image-gen.ts");
const save = await import("../src/lib/save-image.ts");
const { runCloudImage } = await import("../src/lib/cloud-image-run.ts");

const spec = (id) => reg.CLOUD_IMAGE_SPECS.find((s) => s.id === id);
const ok = (s, raw, ctx = { kind: "generate" }) => {
  const v = reg.validateCloudImageParams(s, raw, ctx);
  assert.equal(v.ok, true, `expected ok, got ${JSON.stringify(v)}`);
  return v;
};
const bad = (s, raw, re, ctx = { kind: "generate" }) => {
  const v = reg.validateCloudImageParams(s, raw, ctx);
  assert.equal(v.ok, false, `expected errors for ${JSON.stringify(raw)}`);
  assert.match(v.errors.join(" "), re);
};

const png = (w = 8, h = 8, alpha = 1) => sharp({ create: { width: w, height: h, channels: 4, background: { r: 200, g: 20, b: 20, alpha } } }).png().toBuffer();
const webp = () => sharp({ create: { width: 8, height: 8, channels: 3, background: "#204080" } }).webp().toBuffer();
const jpeg = () => sharp({ create: { width: 8, height: 8, channels: 3, background: "#208040" } }).jpeg().toBuffer();

// ── registry ────────────────────────────────────────────────────────────────

test("every registry entry is internally consistent and cites its docs", () => {
  assert.ok(reg.CLOUD_IMAGE_SPECS.length >= 11);
  for (const s of reg.CLOUD_IMAGE_SPECS) {
    assert.ok(s.docs.length && s.docs.every((u) => u.startsWith("https://")), s.id);
    if (s.quality) assert.ok(s.quality.values.includes(s.quality.default), s.id);
    if (s.background) assert.ok(s.background.values.includes(s.background.default), s.id);
    if (s.size.kind === "fixed") assert.ok(s.size.default === "auto" || s.size.sizes.includes(s.size.default), s.id);
    if (s.size.kind === "flexible") for (const p of s.size.presets) assert.deepEqual(reg.flexibleSizeProblems(s.size, ...p.split("x").map(Number)), [], `${s.id} ${p}`);
    // A fresh form is always valid for its own model.
    ok(s, reg.defaultCloudImageParams(s));
  }
});

test("quality: xhigh and max exist only on the 2.5 models", () => {
  ok(spec("gpt-image-2.5-flare"), { quality: "xhigh" });
  ok(spec("gpt-image-2.5-sunburst"), { quality: "max" });
  bad(spec("gpt-image-2"), { quality: "xhigh" }, /quality must be one of auto, low, medium, high/);
  bad(spec("gpt-image-1-mini"), { quality: "max" }, /quality/);
  bad(spec("gpt-image-1"), { quality: "hd" }, /quality/);
});

test("sizes: fixed models take three shapes, flexible ones OpenAI's constraints", () => {
  const mini = spec("gpt-image-1-mini");
  ok(mini, { size: "1536x1024" });
  ok(mini, { size: "auto" });
  bad(mini, { size: "2048x2048" }, /size must be auto or one of/);

  const flare = spec("gpt-image-2.5-flare");
  assert.equal(ok(flare, { size: "1536x864" }).params.size, "1536x864");
  bad(flare, { size: "1000x1000" }, /multiples of 16/);
  bad(flare, { size: "512x512" }, /At least 655,360 pixels/);
  bad(flare, { size: "3840x1024" }, /Aspect ratio/);
  bad(flare, { size: "4096x2304" }, /exceed 3840px/);
  bad(flare, { size: "big" }, /WIDTHxHEIGHT/);
  const fourK = ok(flare, { size: "3840x2160" });
  assert.match(fourK.warnings.join(" "), /experimental/);
});

test("legacy pixel requests snap to a size the model accepts", () => {
  assert.equal(reg.nearestValidSize(spec("gpt-image-1"), 1280, 720), "1536x1024");
  assert.equal(reg.nearestValidSize(spec("gpt-image-1"), 768, 1024), "1024x1536");
  for (const [w, h] of [[768, 768], [512, 2048], [5000, 5000], [1280, 720], [100, 1000]]) {
    const s = reg.nearestValidSize(spec("gpt-image-2"), w, h);
    const [W, H] = s.split("x").map(Number);
    assert.deepEqual(reg.flexibleSizeProblems(spec("gpt-image-2").size, W, H), [], `${w}x${h} → ${s}`);
  }
  const v = ok(spec("gpt-image-2"), { width: 768, height: 768 });
  assert.match(v.warnings[0], /768x768 is not a size/);
  assert.equal(reg.nearestValidSize(spec("gemini-3-pro-image"), 1024, 1024), undefined);
});

test("background, format and compression rules", () => {
  const mini = spec("gpt-image-1-mini");
  ok(mini, { background: "transparent", output_format: "webp" });
  bad(mini, { background: "transparent", output_format: "jpeg" }, /transparent background needs png or webp/);
  // Measured: the Images API refuses a transparent gpt-image-2.
  bad(spec("gpt-image-2"), { background: "transparent" }, /background must be one of auto, opaque/);
  assert.equal(ok(mini, { output_format: "jpeg", output_compression: 70 }).params.output_compression, 70);
  const dropped = ok(mini, { output_format: "png", output_compression: 70 });
  assert.equal(dropped.params.output_compression, undefined);
  assert.match(dropped.warnings.join(" "), /jpeg and webp only/);
  bad(mini, { output_format: "webp", output_compression: 101 }, /0 to 100/);
  bad(mini, { output_format: "gif" }, /output_format/);
  bad(mini, { moderation: "off" }, /moderation must be one of auto, low/);
});

test("n is 1–10 on OpenAI and 1 on Gemini", () => {
  assert.equal(ok(spec("gpt-image-1-mini"), { n: 10 }).params.n, 10);
  bad(spec("gpt-image-1-mini"), { n: 11 }, /1 to 10/);
  bad(spec("gpt-image-1-mini"), { n: 0 }, /1 to 10/);
  bad(spec("gpt-image-1-mini"), { n: 1.5 }, /whole number/);
  bad(spec("gemini-3-pro-image"), { n: 2 }, /1 to 1/);
});

test("Gemini takes an aspect ratio and a resolution tier, per model", () => {
  const pro = spec("gemini-3-pro-image");
  const flash = spec("gemini-3.1-flash-image");
  ok(pro, { aspect_ratio: "21:9", image_size: "4K" });
  bad(pro, { aspect_ratio: "1:8" }, /aspect_ratio/);
  ok(flash, { aspect_ratio: "1:8", image_size: "512" });
  bad(pro, { image_size: "512" }, /image_size/);
  bad(flash, { image_size: "2k" }, /uppercase K/);
  bad(spec("gemini-3.1-flash-lite-image"), { image_size: "2K" }, /image_size must be one of 1K/);
  const old = ok(spec("gemini-2.5-flash-image"), { image_size: "2K" });
  assert.equal(old.params.image_size, undefined);
  // OpenAI-only knobs are dropped, not sent.
  const g = ok(pro, { quality: "high", output_format: "webp", size: "1024x1024" });
  assert.deepEqual(Object.keys(g.params).sort(), ["n"]);
  assert.equal(g.warnings.length, 3);
  assert.equal(ok(pro, { web_search: true }).params.web_search, true);
  assert.equal(ok(spec("gemini-3.1-flash-lite-image"), { web_search: true }).params.web_search, undefined);
});

test("edits: reference limits, mask and input fidelity per model", () => {
  const e = (n, extra = {}) => ({ kind: "edit", imageCount: n, ...extra });
  ok(spec("gpt-image-1-mini"), {}, e(16));
  bad(spec("gpt-image-1-mini"), {}, /1 to 16 reference images \(got 17\)/, e(17));
  bad(spec("gemini-3-pro-image"), {}, /1 to 14/, e(15));
  bad(spec("gemini-2.5-flash-image"), {}, /1 to 3/, e(4));
  bad(spec("gpt-image-2"), {}, /got 0/, e(0));
  assert.match(ok(spec("gemini-3-pro-image"), {}, e(1, { hasMask: true })).warnings[0], /no mask input/);
  assert.equal(ok(spec("gpt-image-1"), { input_fidelity: "high" }, e(1)).params.input_fidelity, "high");
  const g2 = ok(spec("gpt-image-2"), { input_fidelity: "high" }, e(1));
  assert.equal(g2.params.input_fidelity, undefined);
  assert.match(g2.warnings[0], /always uses high input fidelity/);
  assert.match(ok(spec("gpt-image-1"), { input_fidelity: "high" }).warnings[0], /edits only/);
  assert.match(ok(spec("gemini-3-pro-image"), { web_search: true }, e(1)).warnings[0], /grounding on edits/);
});

test("router aliases resolve through the catalogue's vendor id, unknowns stay conservative", () => {
  assert.equal(reg.resolveCloudImageSpec("gemini-image").id, "gemini-3-pro-image");
  assert.equal(reg.resolveCloudImageSpec("gemini-image-fast").id, "gemini-3.1-flash-image");
  assert.equal(reg.resolveCloudImageSpec("house-style", "openai/gpt-image-2.5-flare").id, "gpt-image-2.5-flare");
  const unknown = reg.resolveCloudImageSpec("gpt-image-9", "openai/gpt-image-9");
  assert.equal(unknown.status, "undocumented");
  assert.equal(unknown.edit, null);
  assert.equal(unknown.size.kind, "fixed");
  assert.equal(reg.resolveCloudImageSpec("imagen-x", "gemini/imagen-x").family, "gemini");
});

test("cost: OpenAI's own token formula, checked against measured bills", () => {
  // Measured through the router 2026-10-03.
  assert.equal(reg.gridOutputTokens(64, 1024, 640), 1700); // 2.5 flare xhigh → 1700 tokens
  assert.equal(reg.gridOutputTokens(16, 1536, 864), 120); // 2.5 flare low → 120 tokens
  assert.equal(reg.gridOutputTokens(16, 1024, 1024), 196); // gpt-image-2 low: OpenAI's $0.006
  const mini = reg.estimateCloudImageCost(spec("gpt-image-1-mini"), { n: 1, quality: "low", size: "1024x1024" }, { kind: "generate", promptChars: 0 });
  assert.equal(mini.usd.toFixed(6), (272 * 8 / 1e6).toFixed(6)); // measured 272 tokens
  const two = reg.estimateCloudImageCost(spec("gpt-image-1-mini"), { n: 2, quality: "medium", size: "1024x1024" }, { kind: "generate", promptChars: 0 });
  assert.equal(two.usd.toFixed(6), (2 * 1056 * 8 / 1e6).toFixed(6));
  const auto = reg.estimateCloudImageCost(spec("gpt-image-2"), { n: 1, quality: "auto", size: "auto" });
  assert.ok(auto.low < auto.usd && auto.usd < auto.high);
  const g = reg.estimateCloudImageCost(spec("gemini-3.1-flash-image"), { n: 1, image_size: "4K" }, { kind: "edit", imageCount: 2 });
  assert.equal(g.usd.toFixed(5), (0.151 + 2 * 0.00056).toFixed(5));
  const edit = reg.estimateCloudImageCost(spec("gpt-image-1-mini"), { n: 1, quality: "low", size: "1024x1024" }, { kind: "edit", imageCount: 2 });
  assert.equal(edit.rough, true);
});

// ── forwarding (mocked router) ──────────────────────────────────────────────

function parseMultipart(body, contentType) {
  const boundary = /boundary=(.+)$/.exec(contentType)[1];
  const fields = {};
  const files = [];
  for (const part of body.toString("latin1").split(`--${boundary}`)) {
    const i = part.indexOf("\r\n\r\n");
    if (i < 0) continue;
    const head = part.slice(0, i);
    const value = part.slice(i + 4).replace(/\r\n$/, "");
    const name = /name="([^"]+)"/.exec(head)?.[1];
    if (/filename="/.test(head)) files.push({ field: name, type: /Content-Type: (.+)/.exec(head)?.[1].trim(), bytes: Buffer.from(value, "latin1") });
    else fields[name] = value;
  }
  return { fields, files };
}

async function mockRouter(t, reply) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const body = Buffer.concat(chunks);
      const rec = { path: req.url, headers: req.headers, body };
      seen.push(rec);
      const r = await reply(rec);
      res.writeHead(r.status ?? 200, { "Content-Type": "application/json", ...(r.headers ?? {}) });
      res.end(JSON.stringify(r.json));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

test("generation: OpenAI knobs travel in extra_body, Activity tags and cost survive", async (t) => {
  const img = await webp();
  const router = await mockRouter(t, async () => ({
    headers: { "x-litellm-response-cost": "0.0044" },
    json: { created: 1, output_format: "webp", quality: "low", size: "1024x1024", background: "opaque", data: [{ b64_json: img.toString("base64") }, { b64_json: img.toString("base64") }], usage: { input_tokens: 17, output_tokens: 544, total_tokens: 561, input_tokens_details: { text_tokens: 17, image_tokens: 0 }, output_tokens_details: { image_tokens: 544 } } },
  }));
  const s = spec("gpt-image-1-mini");
  const params = ok(s, { n: 2, quality: "low", size: "1024x1024", background: "opaque", moderation: "low", output_format: "webp", output_compression: 60 }).params;
  const r = await gen.generateCloudImages({ alias: "gpt-image-1-mini", spec: s, prompt: "cup", params, source: "console/test", baseUrl: router.url });

  const sent = JSON.parse(router.seen[0].body.toString());
  assert.equal(router.seen[0].path, "/v1/images/generations");
  assert.equal(router.seen[0].headers["x-source"], "console/test");
  // Top level: what LiteLLM 1.94.0 maps. Nested: the four it would drop.
  assert.deepEqual(sent, { model: "gpt-image-1-mini", prompt: "cup", n: 2, quality: "low", size: "1024x1024", extra_body: { background: "opaque", moderation: "low", output_format: "webp", output_compression: 60 } });
  assert.equal("response_format" in sent, false);
  assert.equal(r.images.length, 2);
  assert.equal(r.costUsd, 0.0044);
  assert.equal(r.usage.outputTokens, 544);
  assert.equal(r.usage.outputImageTokens, 544);
  assert.deepEqual(r.response, { background: "opaque", output_format: "webp", quality: "low", size: "1024x1024" });
  assert.equal(r.transcoded, false);
});

test("generation: Gemini gets imageConfig and grounding, nothing OpenAI-only", async (t) => {
  const router = await mockRouter(t, async () => ({ json: { data: [{ b64_json: (await png()).toString("base64") }] } }));
  const s = spec("gemini-3-pro-image");
  const params = ok(s, { aspect_ratio: "16:9", image_size: "2K", web_search: true }).params;
  const r = await gen.generateCloudImages({ alias: "gemini-image", spec: s, prompt: "map", params, baseUrl: router.url });
  assert.deepEqual(JSON.parse(router.seen[0].body.toString()), { model: "gemini-image", prompt: "map", imageConfig: { aspectRatio: "16:9", imageSize: "2K" }, web_search_options: {} });
  assert.equal(router.seen[0].headers["x-source"], gen.DEFAULT_CLOUD_IMAGE_SOURCE);
  assert.equal(r.costUsd, null);
});

test("a format the router dropped is transcoded locally, and says so", async (t) => {
  const router = await mockRouter(t, async () => ({ json: { output_format: "png", data: [{ b64_json: (await png()).toString("base64") }] } }));
  const s = spec("gpt-image-1-mini");
  const params = ok(s, { output_format: "webp", output_compression: 40 }, { kind: "edit", imageCount: 1 }).params;
  const r = await gen.editCloudImages({ alias: "gpt-image-1-mini", spec: s, prompt: "x", params, images: [{ bytes: await png(), mime: "image/png" }], baseUrl: router.url });
  assert.equal(save.sniffImageFormat(r.images[0]), "webp");
  assert.equal(r.transcoded, true);
});

test("safety refusals, quota and empty replies become readable errors", async (t) => {
  const refusal = { error: { message: "litellm.BadRequestError: OpenAIException - {\"error\":{\"message\":\"Your request was rejected by the safety system.\",\"type\":\"image_generation_user_error\",\"code\":\"moderation_blocked\"}}", code: "400" } };
  let reply = { status: 400, json: refusal };
  const router = await mockRouter(t, async () => reply);
  const s = spec("gpt-image-1-mini");
  const call = () => gen.generateCloudImages({ alias: "gpt-image-1-mini", spec: s, prompt: "x", params: { n: 1 }, baseUrl: router.url });

  await assert.rejects(call(), (e) => e instanceof gen.CloudImageError && e.kind === "safety" && /fictional|game|fiction/i.test(e.message) && /moderation_blocked/.test(e.detail));
  reply = { status: 429, json: { error: { message: "Quota exceeded for metric: generate_content_free_tier_requests, limit: 0" } } };
  await assert.rejects(call(), (e) => e.status === 429 && /free tier/.test(e.message) && /billing/.test(e.message));
  reply = { status: 400, json: { error: { message: "litellm.BadRequestError: OpenAIException - Invalid value: 'x'." } } };
  await assert.rejects(call(), (e) => e.kind === "invalid" && /^AI Router 400: Invalid value/.test(e.message));
  reply = { status: 200, json: { data: [] } };
  await assert.rejects(call(), (e) => e.kind === "empty");
});

// ── multipart edit builder ──────────────────────────────────────────────────

test("edit form: one image[] per reference, a mask, OpenAI field names", async () => {
  const s = spec("gpt-image-1.5");
  const refs = [{ bytes: await webp(), mime: "image/webp" }, { bytes: await jpeg(), mime: "image/jpeg" }];
  const mask = { bytes: await png(8, 8, 0), mime: "image/png" };
  const params = ok(s, { n: 2, quality: "low", size: "1024x1024", background: "opaque", input_fidelity: "high", moderation: "low", output_format: "jpeg", output_compression: 80 }, { kind: "edit", imageCount: 2, hasMask: true }).params;
  const form = gen.buildEditForm(s, "gpt-image-1.5", "merge them", params, refs, mask, "TESTBOUNDARY");
  assert.equal(form.contentType, "multipart/form-data; boundary=TESTBOUNDARY");
  const parsed = parseMultipart(form.body, form.contentType);
  assert.deepEqual(parsed.fields, { model: "gpt-image-1.5", prompt: "merge them", n: "2", quality: "low", size: "1024x1024", background: "opaque", input_fidelity: "high", moderation: "low", output_format: "jpeg", output_compression: "80" });
  assert.deepEqual(parsed.files.map((f) => [f.field, f.type]), [["image[]", "image/webp"], ["image[]", "image/jpeg"], ["mask", "image/png"]]);
  assert.ok(parsed.files[0].bytes.equals(refs[0].bytes), "reference bytes survive byte-for-byte");
  assert.ok(parsed.files[2].bytes.equals(mask.bytes));
});

test("edit form: Gemini sends imageConfig JSON, no mask and no OpenAI fields", async () => {
  const s = spec("gemini-3.1-flash-image");
  const params = ok(s, { aspect_ratio: "4:5", image_size: "1K" }, { kind: "edit", imageCount: 1, hasMask: true }).params;
  const form = gen.buildEditForm(s, "gemini-image-fast", "recolour", params, [{ bytes: await png(), mime: "image/png" }], { bytes: await png(), mime: "image/png" });
  const parsed = parseMultipart(form.body, form.contentType);
  assert.deepEqual(parsed.fields, { model: "gemini-image-fast", prompt: "recolour", imageConfig: JSON.stringify({ aspectRatio: "4:5", imageSize: "1K" }) });
  assert.deepEqual(parsed.files.map((f) => f.field), ["image[]"]);
});

test("data URLs are decoded by their bytes, not their label", async () => {
  const w = await webp();
  assert.deepEqual(gen.decodeDataUrl(`data:image/png;base64,${w.toString("base64")}`).mime, "image/webp");
  assert.equal(gen.decodeDataUrl("data:image/gif;base64,R0lGODlhAQABAAAAACw="), null);
  assert.equal(gen.decodeDataUrl("not a data url"), null);
});

// ── non-PNG saving ──────────────────────────────────────────────────────────

async function tempGallery(t) {
  const root = await mkdtemp(path.join(tmpdir(), "betenshi-cloudimg-test-"));
  const previousOutput = process.env.QWEN_OUTPUT_DIR;
  const previousDb = globalThis.__bDb;
  const rows = [];
  process.env.QWEN_OUTPUT_DIR = root;
  globalThis.__bDb = Promise.resolve({ run: async (sql, values) => rows.push({ sql, values }) });
  t.after(async () => {
    if (previousOutput === undefined) delete process.env.QWEN_OUTPUT_DIR;
    else process.env.QWEN_OUTPUT_DIR = previousOutput;
    globalThis.__bDb = previousDb;
    assert.ok(path.basename(root).startsWith("betenshi-cloudimg-test-"));
    await rm(root, { recursive: true });
  });
  return { root, rows };
}

test("saveImage keeps WebP and JPEG as what they are, with sidecar and DB row to match", async (t) => {
  const { root, rows } = await tempGallery(t);
  for (const [make, ext, format] of [[webp, ".webp", "webp"], [jpeg, ".jpg", "jpeg"], [png, ".png", "png"]]) {
    const saved = await save.saveImage(await make(), { kind: "generate", folder: "Cloud", seed: 3, prompt: "a cup", model: "gpt-image-1-mini" });
    assert.ok(saved, ext);
    assert.equal(path.extname(saved.path), ext);
    assert.equal(save.sniffImageFormat(await readFile(saved.path)), format);
    const meta = JSON.parse(await readFile(path.join(root, save.sidecarRelFor(saved.file)), "utf8"));
    assert.equal(meta.format, format);
    assert.equal(meta.file, path.basename(saved.path));
    assert.equal(rows.at(-1).values[1], saved.file); // rel
    assert.equal(rows.at(-1).values[3], path.basename(saved.path)); // filename
  }
});

test("n images saved in the same millisecond never overwrite each other", async (t) => {
  const { root } = await tempGallery(t);
  const buf = await webp();
  const meta = { kind: "generate", folder: "", seed: 1, prompt: "same" };
  const saved = await Promise.all([save.saveImage(buf, meta), save.saveImage(buf, meta), save.saveImage(buf, meta)]);
  assert.equal(new Set(saved.map((s) => s.file)).size, 3);
  const files = await readdir(root);
  assert.equal(files.filter((f) => f.endsWith(".webp")).length, 3);
  assert.equal(files.filter((f) => f.endsWith(".json")).length, 3);
});

test("gallery paths accept the new formats and nothing else", () => {
  for (const ok of ["a.png", "f/b.webp", "f/g/c.jpg", "d.JPEG"]) assert.equal(save.safeRelImage(ok), ok);
  for (const no of ["a.gif", "../a.webp", "a.webp.exe", "a/../../b.png"]) assert.equal(save.safeRelImage(no), null);
  assert.equal(save.sidecarRelFor("f/x.webp"), "f/x.json");
  assert.equal(save.sidecarRelFor("x.jpeg"), "x.json");
  assert.equal(save.imageContentType("x.webp"), "image/webp");
  assert.equal(save.imageContentType("x.JPG"), "image/jpeg");
  assert.equal(save.imageContentType("x.png"), "image/png");
});

// ── end to end, router mocked ───────────────────────────────────────────────

test("a two-image hosted run saves both, each with the full parameter set and its share of the cost", async (t) => {
  const { root } = await tempGallery(t);
  const img = await sharp({ create: { width: 32, height: 16, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).webp().toBuffer();
  const router = await mockRouter(t, async () => ({ headers: { "x-litellm-response-cost": "0.01" }, json: { output_format: "webp", background: "transparent", data: [{ b64_json: img.toString("base64") }, { b64_json: img.toString("base64") }], usage: { output_tokens: 544 } } }));
  const r = await runCloudImage({
    kind: "generate", alias: "gpt-image-2.5-flare", target: "openai/gpt-image-2.5-flare", prompt: "two stickers",
    cloud: { n: 2, quality: "low", size: "1536x864", background: "transparent", output_format: "webp", bogus: 1 },
    folder: "Cloud", seed: 9, source: "console/test", baseUrl: router.url,
  });
  assert.equal(r.ok, true, JSON.stringify(r.body));
  assert.equal(r.body.images.length, 2);
  assert.equal(r.body.width, 32);
  assert.match(r.body.image, /^data:image\/webp;base64,/);
  assert.equal(r.body.cloud.costUsd, 0.01);
  assert.equal(r.body.cloud.costSource, "router");
  const metas = await Promise.all(r.body.images.map(async (i) => JSON.parse(await readFile(path.join(root, save.sidecarRelFor(i.saved)), "utf8"))));
  assert.deepEqual(metas.map((m) => m.cloud.index), [1, 2]);
  assert.equal(metas[0].cloud.group, metas[1].cloud.group);
  assert.equal(metas[0].cloud.costUsd, 0.005);
  assert.deepEqual(metas[0].cloud.params, { n: 2, quality: "low", size: "1536x864", background: "transparent", output_format: "webp" });
  assert.equal(metas[0].cloud.source, "console/test");
  assert.equal(metas[0].model, "gpt-image-2.5-flare");
});

test("invalid parameters are refused before anything is billed", async (t) => {
  const router = await mockRouter(t, async () => ({ json: {} }));
  const r = await runCloudImage({ kind: "generate", alias: "gpt-image-1-mini", prompt: "x", cloud: { size: "2048x2048" }, folder: "", seed: 1, baseUrl: router.url });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /size must be auto or one of/);
  assert.equal(router.seen.length, 0);
  const e = await runCloudImage({ kind: "edit", alias: "gpt-image-1-mini", prompt: "x", images: ["data:image/gif;base64,R0lGODlhAQABAAAAACw="], folder: "", seed: 1, baseUrl: router.url });
  assert.equal(e.status, 400);
  assert.equal(router.seen.length, 0);
});

test("X-Source stays inside the console namespace", async () => {
  const { cloudSource } = await import("../src/lib/cloud-image-run.ts");
  assert.equal(cloudSource("console/cloud-image-params-test"), "console/cloud-image-params-test");
  assert.equal(cloudSource("quote-forge"), "console/image-studio");
  assert.equal(cloudSource("console/a\nb"), "console/image-studio");
});
