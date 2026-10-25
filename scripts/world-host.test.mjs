import test from "node:test";
import assert from "node:assert/strict";

test("viewer re-confirms readiness and errors only to its same-origin parent", async t => {
  const messages = [], listeners = [];
  const previousWindow = globalThis.window, previousLocation = globalThis.location;
  globalThis.location = { search: "?embed=hangar", pathname: "/api/world/local/view/index.html", origin: "http://localhost" };
  const parent = { postMessage: (data, origin) => messages.push({ data, origin }) };
  globalThis.window = { parent, addEventListener: (_, listener) => listeners.push(listener) };
  t.after(() => { globalThis.window = previousWindow; globalThis.location = previousLocation; });
  const { tellHost } = await import("../engine/world/js/host.js");
  const probe = (source = parent, origin = location.origin) => listeners.forEach(listener => listener({ source, origin, data: { source: "hangar", type: "status" } }));
  probe(); assert.equal(messages.length, 0, "loading must not be reported as ready");
  tellHost("ready"); messages.length = 0;
  probe({}, location.origin); probe(parent, "https://untrusted.example");
  assert.equal(messages.length, 0);
  probe(); assert.equal(messages[0].data.type, "ready"); assert.equal(messages[0].origin, location.origin);
  tellHost("error", { message: "Module unavailable" }); messages.length = 0;
  probe(); assert.deepEqual(messages[0].data, { source: "atlas", type: "error", message: "Module unavailable" });
  tellHost("ready"); messages.length = 0;
  probe(); assert.equal(messages[0].data.type, "ready", "recovery supersedes the old error");
});
