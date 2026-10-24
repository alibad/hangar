import test from "node:test";
import assert from "node:assert/strict";
import { localRequestAllowed, validatePeer, atlasPathAllowed } from "../src/lib/fleet-policy.ts";

const request = (host, headers = {}, method = "GET") => new Request(`http://${host}/api/fleet`, { method, headers: { host, ...headers } });
test("fleet rejects hosted, cross-origin, rebinding and mutations without intent", () => {
  assert.equal(localRequestAllowed(request("127.0.0.1:8003"), false), true);
  assert.equal(localRequestAllowed(request("127.0.0.1:8003"), true), false);
  assert.equal(localRequestAllowed(request("evil.example:8003"), false), false);
  assert.equal(localRequestAllowed(request("127.0.0.1:8003", { origin: "https://evil.example" }), false), false);
  assert.equal(localRequestAllowed(request("127.0.0.1:8003", { "sec-fetch-site": "cross-site" }), false), false);
  assert.equal(localRequestAllowed(request("127.0.0.1:8003", { "x-forwarded-host": "public.example" }), false), false);
  assert.equal(localRequestAllowed(request("localhost:8003", {}, "POST"), false), false);
  assert.equal(localRequestAllowed(request("localhost:8003", { origin: "http://localhost:8003", "x-hangar": "1" }, "POST"), false), true);
});
test("Atlas bridge is an allowlist, not an arbitrary filesystem or URL proxy", () => {
  assert.equal(atlasPathAllowed("proxy", ["islands"], "GET"), true);
  assert.equal(atlasPathAllowed("proxy", ["islands"], "POST"), true);
  assert.equal(atlasPathAllowed("proxy", ["islands", "delete"], "POST"), false);
  assert.equal(atlasPathAllowed("view", ["vendor", "three", "build", "three.module.min.js"], "GET"), true);
  for (const path of [["..", "config.json"], ["%2e%2e", "foo.js"], ["js", "..", "atlas.json"], ["atlas.json"], ["js\\other.js"]]) assert.equal(atlasPathAllowed("view", path, "GET"), false);
  assert.equal(atlasPathAllowed("proxy", ["work"], "POST"), true);
  assert.equal(atlasPathAllowed("proxy", ["sessions", "library"], "GET"), true);
  assert.equal(atlasPathAllowed("proxy", ["sessions", "library"], "POST"), true);
  assert.equal(atlasPathAllowed("proxy", ["sessions", "delete"], "POST"), false);
  assert.equal(atlasPathAllowed("proxy", ["git"], "POST"), true);
  assert.equal(atlasPathAllowed("proxy", ["delete"], "POST"), false);
  assert.equal(atlasPathAllowed("proxy", ["git", "delete"], "POST"), false);
  assert.equal(atlasPathAllowed("view", ["js", "main.js"], "POST"), false);
});
test("peer configuration only accepts a loopback port and safe SSH display alias", () => {
  assert.deepEqual(validatePeer({ id: "laptop", name: "Laptop", port: 18003, sshAlias: "my-laptop" }), { id: "laptop", name: "Laptop", port: 18003, sshAlias: "my-laptop" });
  for (const patch of [{ id: "local" }, { port: -1 }, { port: 7788 }, { port: "http://host" }, { sshAlias: "host; rm" }, { id: "../foo" }]) assert.throws(() => validatePeer({ id: "laptop", name: "Laptop", port: 18003, ...patch }));
});
