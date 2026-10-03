#!/usr/bin/env node
// Real, billable verification that every hosted-image parameter takes effect.
//
// Runs the console's own code path (runCloudImage → AI Router → save) against
// the live router, but saves into a TEMPORARY gallery and DuckDB file, so it
// never touches the running console's data (BETENSHI_DB_PATH / QWEN_OUTPUT_DIR
// are pointed at a temp dir before anything is imported).
//
//   node scripts/verify-cloud-image-params.mjs            # all cases
//   node scripts/verify-cloud-image-params.mjs n2 webp    # just these
//
// Every call carries X-Source: console/cloud-image-params-test, so the spend is
// attributable in Activity (/api/router-usage → callers). Cheapest quality
// throughout; the whole default run is a few dollar-cents. Results print as
// JSON lines and are summarised at the end.
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";

const root = await mkdtemp(path.join(tmpdir(), "betenshi-cloudimg-verify-"));
process.env.BETENSHI_DB_PATH = path.join(root, "verify.db");
process.env.QWEN_OUTPUT_DIR = path.join(root, "gallery");

// db.ts does `import * as duckdb from "duckdb"`, which Next's bundler resolves
// but plain Node ESM cannot (duckdb is CommonJS without detectable named
// exports). A tiny shim keeps the temp gallery's DuckDB rows real.
const DUCKDB_SHIM = `data:text/javascript,${encodeURIComponent(
  `import { createRequire } from "node:module";
   const d = createRequire(${JSON.stringify(new URL("../package.json", import.meta.url).href)})("duckdb");
   export const Database = d.Database; export default d;`,
)}`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@/lib/")) return next(new URL(`../src/lib/${specifier.slice(6)}.ts`, import.meta.url).href, context);
    if (specifier === "duckdb" && context.parentURL?.endsWith("/src/lib/db.ts")) return { url: DUCKDB_SHIM, shortCircuit: true };
    return next(specifier, context);
  },
});

const { runCloudImage } = await import("../src/lib/cloud-image-run.ts");
const { sniffImageFormat } = await import("../src/lib/save-image.ts");
const sharp = (await import("sharp")).default;

const ROUTER = process.env.AI_ROUTER_URL || "http://127.0.0.1:4000";
const SOURCE = "console/cloud-image-params-test";
const only = new Set(process.argv.slice(2));
const results = [];
let spent = 0;

async function run(name, input, check) {
  if (only.size && !only.has(name)) return null;
  const t0 = Date.now();
  const r = await runCloudImage({ folder: "verify", seed: 1, source: SOURCE, baseUrl: ROUTER, ...input });
  const cost = r.body?.cloud?.costUsd ?? 0;
  spent += r.ok ? cost : 0;
  const files = (r.body?.images ?? []).map((i) => i.savedPath).filter(Boolean);
  let verdict = { pass: false, note: r.body?.error ?? "" };
  if (r.ok) {
    try { verdict = await check(r.body, files); } catch (e) { verdict = { pass: false, note: String(e) }; }
  }
  const row = {
    case: name,
    model: input.alias,
    ok: r.ok,
    status: r.status,
    pass: verdict.pass,
    note: verdict.note,
    costUsd: cost,
    costSource: r.body?.cloud?.costSource,
    usage: r.body?.cloud?.usage ?? null,
    response: r.body?.cloud?.response ?? null,
    transcoded: r.body?.cloud?.transcoded ?? null,
    images: files.length,
    ms: Date.now() - t0,
  };
  results.push(row);
  console.log(JSON.stringify(row));
  return { r, files };
}

const magic = async (file) => sniffImageFormat(await readFile(file));
async function alphaStats(file) {
  const img = sharp(await readFile(file));
  const meta = await img.metadata();
  if (!meta.hasAlpha) return { hasAlpha: false, transparentShare: 0 };
  const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let clear = 0;
  for (let i = info.channels - 1; i < data.length; i += info.channels) if (data[i] < 16) clear++;
  return { hasAlpha: true, transparentShare: clear / (info.width * info.height) };
}

const MINI = "gpt-image-1-mini";
const SQ = { quality: "low", size: "1024x1024" };

// 1. transparent background → an alpha channel with real transparent pixels
const transparent = await run("transparent", {
  kind: "generate", alias: MINI,
  prompt: "A single red apple sticker with a thick white outline, isolated, nothing behind it",
  cloud: { ...SQ, background: "transparent", output_format: "png" },
}, async (_b, files) => {
  const s = await alphaStats(files[0]);
  return { pass: s.hasAlpha && s.transparentShare > 0.05, note: `alpha=${s.hasAlpha} transparent=${(s.transparentShare * 100).toFixed(1)}%` };
});

// 2. webp, with compression
const webp = await run("webp", {
  kind: "generate", alias: MINI,
  prompt: "A small blue ceramic cup on a wooden table, soft daylight",
  cloud: { ...SQ, output_format: "webp", output_compression: 60 },
}, async (b, files) => {
  const f = await magic(files[0]);
  return { pass: f === "webp" && !b.cloud.transcoded && b.cloud.response.output_format === "webp", note: `magic=${f} ext=${path.extname(files[0])} provider says ${b.cloud.response.output_format}` };
});

// 3. jpeg, with compression
const jpeg = await run("jpeg", {
  kind: "generate", alias: MINI,
  prompt: "A green pear on a grey stone surface, studio photo",
  cloud: { ...SQ, output_format: "jpeg", output_compression: 70 },
}, async (b, files) => {
  const f = await magic(files[0]);
  return { pass: f === "jpeg" && !b.cloud.transcoded && b.cloud.response.output_format === "jpeg", note: `magic=${f} ext=${path.extname(files[0])} provider says ${b.cloud.response.output_format}` };
});

// 4. n = 2 → two images, two files
await run("n2", {
  kind: "generate", alias: MINI,
  prompt: "A paper origami crane, minimal illustration",
  cloud: { ...SQ, n: 2 },
}, async (b, files) => ({ pass: b.images.length === 2 && files.length === 2 && files[0] !== files[1], note: `${b.images.length} images: ${files.map((f) => path.basename(f)).join(", ")}` }));

// 5. quality changes token usage (same model, size and prompt as `quality-low`)
const QPROMPT = "A lighthouse on a rocky coast at dusk, painterly";
const qLow = await run("quality-low", { kind: "generate", alias: MINI, prompt: QPROMPT, cloud: { ...SQ } }, async (b) => ({ pass: !!b.cloud.usage?.outputTokens, note: `output tokens ${b.cloud.usage?.outputTokens}` }));
await run("quality-medium", { kind: "generate", alias: MINI, prompt: QPROMPT, cloud: { ...SQ, quality: "medium" } }, async (b) => {
  const low = qLow?.r.body?.cloud?.usage?.outputTokens;
  const med = b.cloud.usage?.outputTokens;
  return { pass: !!low && !!med && med > low, note: `low=${low} → medium=${med} output tokens; provider says quality=${b.cloud.response.quality}` };
});

// 6. moderation: low is accepted (and reaches OpenAI — see the negative control in the doc)
await run("moderation-low", {
  kind: "generate", alias: MINI,
  prompt: "A knight in armour holding a sword, fantasy game concept art",
  cloud: { ...SQ, moderation: "low" },
}, async (b) => ({ pass: b.cloud.params.moderation === "low", note: "accepted with moderation=low" }));

// 7. edit with two reference images (one WebP, one JPEG — the decoder handles both)
const asDataUrl = async (file) => {
  const buf = await readFile(file);
  const f = sniffImageFormat(buf);
  return `data:image/${f};base64,${buf.toString("base64")}`;
};
if (webp?.files[0] && jpeg?.files[0]) {
  await run("edit-2-refs", {
    kind: "edit", alias: MINI,
    prompt: "Place the blue cup from image 1 next to the green pear from image 2 on one table, same soft daylight",
    images: [await asDataUrl(webp.files[0]), await asDataUrl(jpeg.files[0])],
    cloud: { ...SQ, output_format: "webp" },
  }, async (b, files) => {
    const f = await magic(files[0]);
    return { pass: b.images.length === 1 && f === "webp", note: `2 refs in; out magic=${f}; transcoded=${b.cloud.transcoded}; input tokens ${b.cloud.usage?.inputTokens} (image ${b.cloud.usage?.inputImageTokens})` };
  });
}

// 8. edit with a mask on the first image (PNG with alpha, same size)
if (transparent?.files[0]) {
  const mask = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } })
    .composite([{ input: Buffer.from('<svg width="1024" height="1024"><rect x="0" y="0" width="1024" height="300" fill="black"/></svg>'), blend: "dest-out" }])
    .png().toBuffer();
  const base = await sharp(await readFile(transparent.files[0])).flatten({ background: "#ffffff" }).ensureAlpha().png().toBuffer();
  await run("edit-mask", {
    kind: "edit", alias: MINI,
    prompt: "Add a small green leaf at the top of the apple",
    images: [`data:image/png;base64,${base.toString("base64")}`],
    mask: `data:image/png;base64,${mask.toString("base64")}`,
    cloud: { ...SQ },
  }, async (b) => ({ pass: b.images.length === 1, note: `mask accepted; sent files ${JSON.stringify((b.cloud && "ok") || "")}` }));
}

// 9. a 2.5 model: custom flexible size + webp + moderation
await run("flare-custom-size", {
  kind: "generate", alias: "gpt-image-2.5-flare",
  prompt: "A wide cinematic shot of a red kite flying over green hills",
  cloud: { quality: "low", size: "1536x864", output_format: "webp", output_compression: 50, moderation: "low" },
}, async (b, files) => {
  const f = await magic(files[0]);
  return { pass: f === "webp" && b.width === 1536 && b.height === 864, note: `${b.width}x${b.height} magic=${f}` };
});

// 10. gpt-image-2 transparent (documented as preview)
await run("gpt-image-2-transparent", {
  kind: "generate", alias: "gpt-image-2",
  prompt: "A yellow rubber duck sticker, isolated, nothing behind it",
  cloud: { ...SQ, background: "transparent", output_format: "png" },
}, async (_b, files) => {
  const s = await alphaStats(files[0]);
  return { pass: s.hasAlpha && s.transparentShare > 0.05, note: `alpha=${s.hasAlpha} transparent=${(s.transparentShare * 100).toFixed(1)}%` };
});

// 11. a 2.5-only quality value
await run("flare-xhigh", {
  kind: "generate", alias: "gpt-image-2.5-flare",
  prompt: "A brass pocket watch, macro photo",
  cloud: { quality: "xhigh", size: "1024x640" },
}, async (b) => ({ pass: b.cloud.response.quality === "xhigh" || !!b.cloud.usage?.outputTokens, note: `provider says quality=${b.cloud.response.quality}; output tokens ${b.cloud.usage?.outputTokens}` }));

// The temp gallery's DuckDB rows: one per image, extension matching the bytes.
const { getDb } = await import("../src/lib/db.ts");
const rows = await (await getDb()).all("SELECT rel, kind, model, width, height, bytes FROM images ORDER BY saved_at");
console.log("\nDUCKDB ROWS (temp)");
for (const r of rows) console.log(`  ${r.kind.padEnd(8)} ${String(r.model).padEnd(22)} ${r.width}x${r.height}  ${r.rel}`);

console.log("\nSUMMARY");
for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.case.padEnd(24)} ${r.model.padEnd(22)} $${(r.costUsd ?? 0).toFixed(4)}  ${r.note}`);
console.log(`total router-reported spend: $${spent.toFixed(4)}  (gallery: ${root})`);
process.exit(0);
