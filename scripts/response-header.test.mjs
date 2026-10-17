import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../src/lib/response-header.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { asciiHeaderValue } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

test("successful media responses can carry a fallback explanation in HTTP headers", () => {
  const explanation = 'AI Router is down — used the local model instead of "local-chatterbox".';
  assert.throws(() => new Headers({ "X-TTS-Degraded": explanation }), /ByteString/);
  for (const name of ["X-TTS-Degraded", "X-Video-Degraded"]) {
    const response = new Response(new Uint8Array([1, 2]), { headers: { [name]: asciiHeaderValue(explanation) } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get(name), explanation.replace("—", "-"));
  }
});

test("header metadata excludes control characters while preserving ordinary model ids", () => {
  assert.equal(asciiHeaderValue("kokoro-82m"), "kokoro-82m");
  assert.doesNotThrow(() => new Headers({ "X-TTS-Engine": asciiHeaderValue("voice\r\nإيراني") }));
  assert.match(asciiHeaderValue("voice\r\nإيراني"), /^[\x20-\x7e]+$/);
});
