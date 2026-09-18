import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";

/**
 * The host profiles are data, and data that nothing validates drifts.
 *
 * config/hosts/*.json is read by three things that cannot check each other:
 * the console (via src/lib/host.ts), scripts/manager.cjs (CommonJS, so it
 * cannot import the TypeScript), and a human adding a machine. A typo in a
 * capability id is invisible until a tab silently reports itself unavailable.
 *
 * Read with fs rather than imported, because Node's test runner wants import
 * attributes for JSON and this suite must run without a bundler.
 */
const HOSTS = readdirSync(new URL("../config/hosts", import.meta.url))
  .filter((f) => f.endsWith(".json"))
  .map((f) => [f.replace(/\.json$/, ""), JSON.parse(readFileSync(new URL(`../config/hosts/${f}`, import.meta.url), "utf8"))]);

/** Mirrors CAPABILITIES in src/lib/providers.ts. */
const CAPABILITY_IDS = new Set(["text", "vision", "image", "stt", "tts"]);

test("there is at least one host profile and every one has the basics", () => {
  assert.ok(HOSTS.length > 0, "config/hosts must contain at least one profile");
  for (const [id, h] of HOSTS) {
    assert.equal(h.id, id, `${id}.json declares id "${h.id}" — the filename is the host id`);
    assert.ok(h.name, `${id} has no name`);
    assert.ok(["win32", "darwin", "linux"].includes(h.platform), `${id} has no valid platform`);
    assert.ok(["nvidia", "apple", "none"].includes(h.gpu), `${id} has no valid gpu`);
    assert.ok(Array.isArray(h.services) && h.services.length, `${id} declares no services`);
  }
});

test("every declared capability is a real one", () => {
  // The typo case: "sst" instead of "stt" produces a host that silently cannot
  // transcribe, with no error anywhere — the tab just reports unavailable.
  for (const [id, h] of HOSTS) {
    for (const s of h.services) {
      for (const cap of Object.keys(s.serves ?? {})) {
        assert.ok(
          CAPABILITY_IDS.has(cap),
          `${id}/${s.id} serves "${cap}", which is not a capability id (${[...CAPABILITY_IDS].join(", ")})`,
        );
        assert.ok(
          typeof s.serves[cap] === "string" && s.serves[cap].length,
          `${id}/${s.id} serves "${cap}" with no served-model-name`,
        );
      }
    }
  }
});

test("`serves` and the older `llm.model` never contradict each other", () => {
  // Two fields carrying the same fact is a bug waiting to happen, and this is
  // the check that makes the overlap safe rather than merely documented.
  for (const [id, h] of HOSTS) {
    for (const s of h.services) {
      if (s.llm?.model && s.serves?.text) {
        assert.equal(
          s.serves.text,
          s.llm.model,
          `${id}/${s.id}: serves.text "${s.serves.text}" disagrees with llm.model "${s.llm.model}"`,
        );
      }
    }
  }
});

test("a host that declares an LLM service also declares what it serves", () => {
  // Not every service needs `serves` — monitoring and app services serve no
  // capability. But a service the LLM picker offers must be routable too, or
  // the picker and the router disagree about what this box can do.
  for (const [id, h] of HOSTS) {
    for (const s of h.services) {
      if (s.llm?.model) {
        assert.ok(s.serves?.text, `${id}/${s.id} is in the LLM picker but declares no serves.text`);
      }
    }
  }
});

test("service ids are unique within a host and every one is addressable", () => {
  for (const [id, h] of HOSTS) {
    const ids = h.services.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length, `${id} has duplicate service ids`);
    for (const s of h.services) {
      assert.ok(s.localUrl, `${id}/${s.id} has no localUrl`);
      assert.ok(s.healthPath, `${id}/${s.id} has no healthPath`);
    }
  }
});

test("BeTenshi's audio capabilities are declared, not inferred from a name", () => {
  // The regression this whole change exists to prevent: the Speech tab used to
  // resolve on a service literally called "whisper", so renaming it — or
  // putting a better ASR model behind it — reported the tab unavailable.
  const betenshi = HOSTS.find(([id]) => id === "betenshi")?.[1];
  assert.ok(betenshi, "the betenshi profile must exist");
  const serving = (cap) => betenshi.services.filter((s) => s.serves?.[cap]);
  assert.equal(serving("stt").length, 1, "exactly one service should serve stt today");
  // ...and the fallback a caller gets is a real, addressable service.
  const stt = serving("stt")[0];
  assert.ok(betenshi.services.some((s) => s.id === stt.id));
  assert.ok(stt.serves.stt.length, "the stt service must name what to send as `model`");

  // Two engines serve tts since voice cloning arrived, which makes ORDER load-
  // bearing rather than incidental: defaultServiceFor() takes the first match,
  // and that is what a router outage falls back to. Kokoro answers in ~300ms
  // from baked-in voicepacks; Chatterbox is ~1.4x realtime and needs a
  // reference clip. Reordering this list would silently make every degraded
  // request take twenty times longer, so it is asserted rather than assumed.
  const tts = serving("tts");
  assert.ok(tts.length >= 1, "something must serve tts");
  assert.equal(tts[0].id, "tts", "Kokoro must stay the first tts service — it is the outage fallback");
  for (const s of tts) {
    assert.ok(s.serves.tts.length, `${s.id} must name what to send as \`model\``);
    assert.ok(betenshi.services.some((x) => x.id === s.id));
  }
});
