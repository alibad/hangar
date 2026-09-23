/**
 * The rule that decides whether a port really is the service the table names.
 *
 * Tested as a pure function rather than by binding ports, because the ports in
 * that table are in use on any machine actually running Hangar — an
 * integration test of this would be least reliable exactly where it matters.
 *
 * The first case is the bug this exists for, reproduced from life: on
 * 2026-09-21 the detector reported `:4000 ai-router HTTP 200` on a Mac with no
 * AI Router installed, because another project's dev server held the port.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { KNOWN, classifyAnswer, MAX_PROBE_BYTES } from "./detect-host.probe.mjs";

const byId = (id) => KNOWN.find((s) => s.id === id);
const byPort = (port) => KNOWN.find((s) => s.port === port);

/** Build a probe result the way probeHealth() would. */
function answer(body, { status = 200 } = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status, ok: status < 400, text, json };
}

test("a web app on the router's port is rejected, not adopted", () => {
  const verdict = classifyAnswer(byPort(4000), answer("<!DOCTYPE html><html><body>another app</body></html>"));
  assert.equal(verdict.state, "mismatch");
  assert.match(verdict.why, /web page/);
});

test("the real services are still identified", () => {
  // Shapes copied from what these actually returned on B5, 2026-09-21.
  assert.equal(
    classifyAnswer(byId("ollama"), answer({ models: [{ name: "qwen3.8:27b-mlx" }] })).state,
    "identified",
  );
  assert.equal(
    classifyAnswer(byId("manager"), answer([{ id: "ollama", name: "Ollama", status: "running" }])).state,
    "identified",
  );
  assert.equal(
    classifyAnswer(byPort(8111), answer({ ok: true, model: "FLUX.2 Klein 4B", capabilities: ["image", "tts"] })).state,
    "identified",
  );
  assert.equal(
    classifyAnswer(byId("vllm"), answer({ object: "list", data: [{ id: "qwen3-coder" }] })).state,
    "identified",
  );
});

test("a JSON service answering the wrong JSON is a mismatch", () => {
  // The subtler impostor: it speaks JSON, so a content-type check would pass
  // it. Only the shape separates a different API from the expected one.
  const verdict = classifyAnswer(byId("ollama"), answer({ result: "ok", tags: [] }));
  assert.equal(verdict.state, "mismatch");
  assert.match(verdict.why, /shape/);
});

test("nothing listening and nothing answering stay different states", () => {
  // A port that answers NOTHING was already handled correctly and must not be
  // reclassified as an impostor: "I could not tell" and "it is something else"
  // are different things to tell a user.
  assert.equal(classifyAnswer(byId("sam3"), null).state, "silent");
});

test("the browser apps are allowed to answer with HTML", () => {
  // Open WebUI serves a page from `/`, and that is correct. A shape check
  // written without this exception would reject the one service it is right
  // about.
  assert.equal(classifyAnswer(byId("webui"), answer("<!DOCTYPE html><html></html>")).state, "identified");
});

test("Prometheus answering in plain text is identified", () => {
  assert.equal(classifyAnswer(byId("prometheus"), answer("Prometheus Server is Healthy.")).state, "identified");
  assert.equal(classifyAnswer(byId("prometheus"), answer("<!DOCTYPE html><html></html>")).state, "mismatch");
});

test("a pass without a signature is marked weak rather than claimed as verified", () => {
  // Several of this project's own FastAPI services have never had their health
  // payload read from this machine. `expects: json` is a real check but a weak
  // one, and the report must not present it as the same thing as a shape match.
  const verdict = classifyAnswer(byId("whisper"), answer({ status: "ok" }));
  assert.equal(verdict.state, "identified");
  assert.equal(verdict.weak, true);
  assert.equal(classifyAnswer(byId("ollama"), answer({ models: [] })).weak, false);
});

test("an oversized health response is refused", () => {
  const verdict = classifyAnswer(byId("ollama"), { status: 200, ok: true, text: "", json: undefined, oversized: true });
  assert.equal(verdict.state, "mismatch");
  assert.match(verdict.why, new RegExp(String(MAX_PROBE_BYTES / 1024)));
});

test("a signature that throws is a mismatch, not a crash", () => {
  // A malformed reply must not take the whole scan down with it.
  const hostile = { ...byId("manager"), signature: () => { throw new Error("boom"); } };
  assert.equal(classifyAnswer(hostile, answer({})).state, "mismatch");
});

test("every entry declares how it can be recognised", () => {
  // Adding a port to the table without saying what its answer looks like would
  // reintroduce the original bug for that one service, silently.
  for (const svc of KNOWN) {
    assert.ok(
      ["json", "text", "any"].includes(svc.expects),
      `${svc.id} (:${svc.port}) declares no \`expects\` — it would be identified by port number alone`,
    );
  }
});
