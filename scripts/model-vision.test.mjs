import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

/**
 * Vision is a DECLARED capability. The router reports `mode: "chat"` for every
 * conversational model, multimodal or not, so modelsFor("vision") filters on a
 * flag in config/model-meta.json instead of on the mode.
 *
 * That fix shipped as two halves and only one landed: the filter went into
 * providers.ts, the flags were never written, and Vision therefore offered
 * NOTHING on either machine. Nothing caught it, because a capability that
 * returns an empty list looks exactly like one whose models are all stopped.
 *
 * These assertions are that catch. They are about the DATA, which is the half
 * that was missing — the filter itself is one line and tsc covers it. Kept off
 * providers.ts on purpose: it imports the whole service registry through
 * extensionless specifiers that node --test cannot resolve, and reaching for a
 * bundler here would buy nothing, since the bug was never in the code.
 */

const META = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "..", "config", "model-meta.json"), "utf8"),
);
const entries = Object.entries(META).filter(([k, v]) => !k.startsWith("_") && v && typeof v === "object");

test("some model declares vision — otherwise the capability is empty everywhere", () => {
  const seeing = entries.filter(([, v]) => v.vision === true).map(([k]) => k);
  assert.ok(
    seeing.length > 0,
    "no entry sets vision: true, so modelsFor('vision') returns [] on every host",
  );
});

test("the local multimodal models declare it", () => {
  // These are the two the console can actually run on-box, and the reason the
  // capability exists at all. Measured in ai/b5/bench, 2026-09-14.
  for (const alias of ["local-gemma4", "local-qwen3-vl"]) {
    assert.ok(META[alias], `${alias} is routed in ai-router.yaml but has no model-meta entry`);
    assert.equal(META[alias].vision, true, `${alias} is multimodal but does not declare it`);
  }
});

test("text-only local models are pinned to false, not left silent", () => {
  // An undeclared model falls through to LiteLLM's own supports_vision, which
  // knows nothing about a locally-served checkpoint. For these the declaration
  // is the only source, so silence is not the same as "no".
  for (const alias of ["local-coder", "local-small", "local-ollama"]) {
    assert.equal(META[alias]?.vision, false, `${alias} should declare vision: false`);
  }
});

test("every vision flag is a real boolean", () => {
  for (const [alias, v] of entries) {
    if ("vision" in v) {
      assert.equal(typeof v.vision, "boolean", `${alias}.vision must be a boolean, not ${typeof v.vision}`);
    }
  }
});

test("a model that declares vision is a chat model, not an image generator", () => {
  // vision means "accepts image INPUT". An image generator has mode "image" and
  // would never reach the filter, so a flag on one is a sign of a mix-up.
  for (const [alias, v] of entries) {
    if (v.vision === true) {
      assert.ok(
        !/image|flux|hidream|z-image|qwen-image/.test(alias),
        `${alias} looks like an image generator but declares vision (image input)`,
      );
    }
  }
});
