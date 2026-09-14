// Arabic LLM + OCR comparison across local models served by Ollama.
//
//   node scripts/experiment-arabic.mjs [model ...]
//
// Defaults to gemma4:31b-it-qat, qwen3-vl:32b and qwen3:32b. Reads the corpus
// from config/arabic-eval.json and the rendered images from
// var/arabic-eval/fixtures/ (run scripts/arabic-fixtures.py first). Writes raw
// outputs, timings and scores to var/experiments/<ts>-arabic.json.
//
// ── Why Ollama rather than vLLM ─────────────────────────────────────────────
// vLLM is the box's serving runtime and would win on throughput, but the vLLM
// image here is 0.17.1 and does not know the `gemma4` architecture at all —
// Gemma 4 needs vLLM >= 0.19. Comparing Gemma on a freshly pulled 30 GB image
// against Qwen on the old one would compare runtimes as much as models. Ollama
// runs all three under one engine today, which is the fair comparison and the
// cheap one. If a winner becomes a standing service, promoting it to vLLM is a
// separate decision with its own measurement.
//
// ── Why temperature 0 ───────────────────────────────────────────────────────
// Every task here is convergent: transcribe, translate, extract, correct. None
// rewards sampling diversity, and a re-run has to reproduce. This does mean the
// models run OFF their published sampling recommendations (Gemma 4's card asks
// for temperature 1.0 / top_p 0.95 / top_k 64), which is recorded as a caveat in
// the write-up rather than hidden — it is the single biggest threat to these
// numbers being read as "how good is this model" instead of "how good is this
// model, greedily decoded".
//
// ── One run each, not an average ────────────────────────────────────────────
// Greedy decoding makes the OUTPUT stable, so repeats would measure timing
// jitter rather than quality. The latency figures are therefore single
// observations and are reported as such; do not read a 10% gap between two
// models' tokens/sec as real.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  cer,
  wer,
  chrF,
  scoreFields,
  arabicRatio,
  normalizeArabic,
} from "../src/lib/text-scoring.ts";

const exec = promisify(execFile);

const ROOT = path.resolve(import.meta.dirname, "..");
const FIXTURES = path.join(ROOT, "var", "arabic-eval", "fixtures");
const OLLAMA = process.env.OLLAMA_URL ?? "http://localhost:11434";
const SEED = 20260914;
/**
 * Generation budget per request.
 *
 * 8192 rather than something smaller because one model in this comparison
 * (qwen3-vl:32b) cannot be told to stop reasoning, and at 4096 it exhausted the
 * whole budget thinking on two items and returned no answer at all. The budget
 * has to be large enough that "no answer" means the model failed, not that the
 * harness ran out of room. Referenced everywhere rather than repeated - the
 * exhaustion check below compares against it, and a drifted copy would make that
 * check silently stop firing.
 */
const MAX_TOKENS = 8192;

const DEFAULT_MODELS = ["gemma4:31b-it-qat", "qwen3-vl:32b", "qwen3:32b"];

/** Per-request ceiling. A cold 20 GB model load plus a long vision prompt is minutes. */
const TIMEOUT_MS = 15 * 60 * 1000;

// ── GPU sampling ────────────────────────────────────────────────────────────

/**
 * Whole-card VRAM, sampled while a request is in flight.
 *
 * Whole-card, not per-process: this box shares the GPU with the desktop
 * compositor and several Electron apps, and nvidia-smi cannot attribute WDDM
 * memory per process anyway. The number is therefore an upper bound that
 * includes everything else on the card — the same convention, and the same
 * caveat, as docs/image-model-experiment-2026-09-12.md.
 */
function gpuSampler() {
  let peak = 0;
  let samples = 0;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const { stdout } = await exec(
        "nvidia-smi",
        ["--query-gpu=memory.used", "--format=csv,noheader,nounits"],
        { windowsHide: true },
      );
      peak = Math.max(peak, Number(stdout.trim()) || 0);
      samples++;
    } catch {
      /* a sampling failure must never fail the run it is observing */
    } finally {
      busy = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), 500);
  return {
    stop() {
      clearInterval(timer);
      return { peakWholeGpuMiB: peak, gpuSamples: samples };
    },
  };
}

// ── Ollama ──────────────────────────────────────────────────────────────────

/**
 * Native /api/chat rather than the OpenAI-compatible /v1 face.
 *
 * Two things only the native API gives, both of which this experiment needs:
 * `options.num_ctx` (the OpenAI face silently uses the 4096 default, which
 * truncates a vision prompt mid-image and would look like a model failure), and
 * `prompt_eval_count` / `eval_count` / `eval_duration`, which are the server's
 * own token counts and generation time rather than wall-clock guesses.
 */
async function chat({ model, prompt, imageBase64, numCtx = 16384, maxTokens = MAX_TOKENS, thinking = false }) {
  const message = { role: "user", content: prompt };
  // Gemma 4's card asks for image content BEFORE text; the native API carries
  // images as a sibling field of the message, so ordering is the server's job.
  if (imageBase64) message.images = [imageBase64];

  const body = {
    model,
    messages: [message],
    stream: false,
    keep_alive: "10m",
    options: { temperature: 0, seed: SEED, num_ctx: numCtx, num_predict: maxTokens },
  };
  // Thinking OFF for models that support it - see the note in main(). Sent only
  // when the model actually has the capability; Ollama rejects the field
  // outright for models that do not.
  if (thinking === false) body.think = false;

  const started = Date.now();
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const wallMs = Date.now() - started;
  const text = await res.text();
  if (!res.ok) throw new Error(`ollama ${res.status}: ${text.slice(0, 400)}`);

  const data = JSON.parse(text);
  const evalMs = (data.eval_duration ?? 0) / 1e6;
  return {
    raw: data.message?.content ?? "",
    // Ollama returns reasoning in its OWN field, not as inline <think> tags.
    // Missing this is how the first run produced empty answers scored as total
    // failures: a thinking model spent its whole token budget inside
    // `message.thinking`, `message.content` came back "", and the harness
    // reported 0 chrF for a model that had never been asked a fair question.
    serverThinking: data.message?.thinking ?? null,
    wallMs,
    loadMs: Math.round((data.load_duration ?? 0) / 1e6),
    tokensIn: data.prompt_eval_count ?? null,
    tokensOut: data.eval_count ?? null,
    // Generation rate only — excludes prompt processing and model load, which is
    // what makes it comparable between a warm and a cold call.
    tokensPerSec: data.eval_count && evalMs > 0 ? +(data.eval_count / (evalMs / 1000)).toFixed(1) : null,
  };
}

/**
 * Strip a reasoning model's thinking block.
 *
 * qwen3:32b emits <think>...</think> inline. Scoring that as part of the answer
 * would report a near-total error for a model that answered correctly after
 * thinking — and would make the reasoning model look uniquely bad at Arabic,
 * which is a conclusion about the harness, not the model.
 */
function splitThinking(content) {
  const closed = content.match(/^\s*<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>\s*/i);
  if (closed) return { answer: content.slice(closed[0].length).trim(), thinking: closed[1].trim() };
  // Unterminated means it spent the whole budget thinking: no answer exists.
  const open = content.match(/^\s*<think(?:ing)?>([\s\S]*)$/i);
  if (open) return { answer: "", thinking: open[1].trim(), truncated: true };
  return { answer: content.trim(), thinking: null };
}

/** Free the card between models: two 20 GB models do not coexist on 32 GB. */
async function unload(model) {
  try {
    await exec("ollama", ["stop", model], { windowsHide: true, timeout: 60_000 });
  } catch {
    /* not loaded is not an error */
  }
}

// ── scoring ─────────────────────────────────────────────────────────────────

function countSentences(text) {
  return (normalizeArabic(text).match(/[.!?]+/g) ?? []).length;
}

function countBullets(text) {
  return text.split("\n").filter((l) => /^\s*[-*•]\s*\S/.test(l)).length;
}

/** Apply whichever checks the corpus item declares. Unknown checks are ignored. */
function score(item, answer, groundTruth) {
  const out = {};
  for (const check of item.checks ?? []) {
    const [name, arg] = check.split(":");
    if (name === "cer" && groundTruth) {
      out.cerNormalized = +cer(groundTruth, answer, "normalized").rate.toFixed(4);
      out.cerStrict = +cer(groundTruth, answer, "strict").rate.toFixed(4);
      out.werNormalized = +wer(groundTruth, answer, "normalized").rate.toFixed(4);
    } else if (name === "chrf" && item.reference) {
      out.chrf = +chrF(item.reference, answer).toFixed(4);
    } else if (name === "fields" && item.expectFields) {
      const f = scoreFields(answer, item.expectFields);
      out.fieldAccuracy = +f.accuracy.toFixed(4);
      out.jsonParsed = f.parsed;
      out.fieldsMissed = f.missed;
    } else if (name === "arabic") {
      out.arabicRatio = +arabicRatio(answer).toFixed(4);
    } else if (name === "sentences") {
      out.sentences = countSentences(answer);
      out.sentencesExpected = Number(arg);
      out.sentencesOk = out.sentences === Number(arg);
    } else if (name === "bullets") {
      out.bullets = countBullets(answer);
      out.bulletsExpected = Number(arg);
      out.bulletsOk = out.bullets === Number(arg);
    } else if (name === "qualitative") {
      out.qualitative = true;
    }
  }
  return out;
}

// ── run ─────────────────────────────────────────────────────────────────────

async function loadFixtures() {
  const manifestPath = path.join(FIXTURES, "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    throw new Error(
      `No fixtures at ${manifestPath}. Run: python scripts/arabic-fixtures.py`,
    );
  }
  const byId = new Map();
  for (const f of manifest.fixtures) {
    const bytes = await readFile(path.join(FIXTURES, f.file));
    byId.set(f.id, { ...f, base64: bytes.toString("base64") });
  }
  return byId;
}

/**
 * What a model can do, asked of the server rather than inferred from its name.
 *
 * `ollama show` reports capabilities directly, and a name-matching heuristic would wrongly exclude a
 * multimodal model whose tag does not say "vl" — which is exactly the case for
 * gemma4, the model this whole comparison is about.
 */
async function capabilities(model) {
  try {
    const res = await fetch(`${OLLAMA}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    });
    if (!res.ok) return [];
    return (await res.json()).capabilities ?? [];
  } catch {
    return [];
  }
}

async function main() {
  const models = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_MODELS;
  const corpus = JSON.parse(await readFile(path.join(ROOT, "config", "arabic-eval.json"), "utf8"));
  const fixtures = await loadFixtures();

  const available = new Set(
    (await (await fetch(`${OLLAMA}/api/tags`)).json()).models.map((m) => m.name),
  );
  for (const m of models) {
    if (!available.has(m)) throw new Error(`model not pulled: ${m} (have: ${[...available].join(", ")})`);
  }

  const results = [];
  for (const model of models) {
    const caps = await capabilities(model);
    const vision = caps.includes("vision");
    const canThink = caps.includes("thinking");
    console.log(`\n=== ${model} ${vision ? "(vision)" : "(text only)"}${canThink ? " thinking:off" : ""} ===`);

    // Grouped by model, and every other model unloaded first: the card holds one
    // 20 GB model at a time, so interleaving would pay a full reload per item.
    for (const other of models) if (other !== model) await unload(other);

    const items = [
      ...corpus.ocr.map((i) => ({ ...i, suite: "ocr" })),
      ...corpus.text.map((i) => ({ ...i, suite: "text" })),
    ];

    for (const item of items) {
      const isOcr = item.suite === "ocr";
      if (isOcr && !vision) {
        results.push({ model, item: item.id, suite: item.suite, skipped: "model has no vision capability" });
        console.log(`  ${item.id.padEnd(26)} skipped (text-only model)`);
        continue;
      }
      const fixture = isOcr ? fixtures.get(item.id) : null;
      if (isOcr && !fixture) {
        results.push({ model, item: item.id, suite: item.suite, skipped: "fixture not rendered" });
        console.log(`  ${item.id.padEnd(26)} skipped (no fixture)`);
        continue;
      }

      const sampler = gpuSampler();
      let record;
      try {
        const r = await chat({
          model,
          prompt: item.prompt,
          imageBase64: fixture?.base64,
          thinking: canThink ? false : undefined, // only for models that have it
        });
        const split = splitThinking(r.raw);
        const answer = split.answer;
        const truncated = split.truncated;
        // Either shape counts: the server's own field, or inline tags.
        const thinking = [r.serverThinking, split.thinking].filter(Boolean).join("\n\n") || null;
        const groundTruth = fixture?.groundTruth ?? null;
        // A model that spends its entire budget reasoning and emits no answer has
        // not been measured on the task - it ran out of room. Scoring that as a
        // 100% error rate would read as "cannot do Arabic" when the true finding
        // is "cannot be told to stop thinking". Flagged so the write-up can say
        // which one happened; the score is still recorded, never silently dropped.
        const exhaustedByThinking =
          !answer.trim() && (thinking?.length ?? 0) > 0 && r.tokensOut >= MAX_TOKENS;
        record = {
          model,
          item: item.id,
          suite: item.suite,
          title: item.title,
          ok: true,
          wallMs: r.wallMs,
          loadMs: r.loadMs,
          tokensIn: r.tokensIn,
          tokensOut: r.tokensOut,
          tokensPerSec: r.tokensPerSec,
          thinkingChars: thinking?.length ?? 0,
          truncated: Boolean(truncated),
          exhaustedByThinking,
          scores: score(item, answer, groundTruth),
          answer,
          groundTruth,
        };
      } catch (err) {
        record = { model, item: item.id, suite: item.suite, ok: false, error: String(err) };
      }
      Object.assign(record, sampler.stop());
      results.push(record);

      const s = record.scores ?? {};
      const brief = record.ok
        ? [
            record.exhaustedByThinking ? "NO ANSWER (budget spent thinking)" : null,
            s.cerNormalized != null ? `CER ${(s.cerNormalized * 100).toFixed(1)}%` : null,
            s.chrf != null ? `chrF ${(s.chrf * 100).toFixed(1)}` : null,
            s.fieldAccuracy != null ? `fields ${(s.fieldAccuracy * 100).toFixed(0)}%` : null,
            s.bulletsOk != null ? `bullets ${s.bullets}/${s.bulletsExpected}` : null,
            s.sentencesOk != null ? `sent ${s.sentences}/${s.sentencesExpected}` : null,
            record.thinkingChars ? `think ${record.thinkingChars}c` : null,
            `${(record.wallMs / 1000).toFixed(1)}s`,
            record.tokensPerSec ? `${record.tokensPerSec} tok/s` : null,
          ].filter(Boolean).join("  ")
        : `FAILED ${record.error?.slice(0, 120)}`;
      console.log(`  ${item.id.padEnd(26)} ${brief}`);
    }

    await unload(model);
  }

  const out = {
    generatedAt: new Date().toISOString(),
    corpusVersion: corpus.version,
    models,
    runtime: "ollama",
    sampling: { temperature: 0, seed: SEED, numCtx: 16384, maxTokens: MAX_TOKENS, thinking: false },
    caveats: [
      "Single run per item, greedy decoding. Latency figures are individual observations, not averages.",
      "qwen3-vl:32b ADVERTISES a thinking capability but IGNORES think:false - it emits reasoning regardless, verified on a one-word prompt. Its latency therefore includes reasoning the other two were told to skip, and the comparison is not like-for-like on speed. Budget raised to 8192 tokens so it can finish thinking AND answer.",
      "Thinking is DISABLED on every model that HONOURS the flag (think: false), so all three answer directly. This is both the apples-to-apples comparison and the realistic setting for these tasks - nobody wants 2000 tokens of deliberation to read an invoice. These are therefore NOT the scores a reasoning model would post with its reasoning switched on.",
      "Models run at temperature 0 rather than their published sampling recommendations, for reproducibility.",
      "peakWholeGpuMiB is whole-card and includes the desktop and other applications; it is not a model-only allocation.",
      "The two Wikimedia specimen items have no ground truth and are scored by hand, not by CER.",
    ],
    results,
  };
  const dir = path.join(ROOT, "var", "experiments");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}-arabic.json`);
  await writeFile(file, JSON.stringify(out, null, 2), "utf8");
  console.log(`\nwrote ${file}`);
}

await main();
