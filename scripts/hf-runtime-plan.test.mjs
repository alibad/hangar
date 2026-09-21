import test from "node:test";
import assert from "node:assert/strict";
import { chooseGgufFile, runtimeModelName } from "../src/lib/hf-runtime-plan.ts";

test("GGUF planning prefers a balanced quant and never chooses a projector or shard", () => {
  const picked = chooseGgufFile([
    { path: "model-f16.gguf", size: 20 },
    { path: "mmproj-model-f16.gguf", size: 2 },
    { path: "model-q4_k_m-00001-of-00002.gguf", size: 4 },
    { path: "model-q5_k_m.gguf", size: 8 },
    { path: "model-q4_k_m.gguf", size: 7 },
  ]);
  assert.deepEqual(picked, { path: "model-q4_k_m.gguf", size: 7 });
});

test("runtime model names are stable, safe, and strip the packaging suffix", () => {
  assert.equal(runtimeModelName("Qwen/Qwen3.5-Coder-7B-GGUF"), "hangar-qwen-qwen3.5-coder-7b");
  assert.match(runtimeModelName("owner/A model with spaces"), /^[a-z0-9][a-z0-9._-]{0,63}$/);
});
