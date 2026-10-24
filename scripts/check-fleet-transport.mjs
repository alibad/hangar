/** Real HTTP path with a temporary second-node fixture. Never starts an agent or model. */
import { createServer } from "node:http";
import assert from "node:assert/strict";
const base = process.env.HANGAR_URL || "http://127.0.0.1:8003";
const peerId = `qa-${Date.now()}`;
const received = [];
const fixture = createServer(async (req, res) => {
  let raw = ""; for await (const chunk of req) raw += chunk;
  received.push({ url: req.url, method: req.method, body: raw, intent: req.headers["x-hangar"] });
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/api/fleet/local/status") return res.end(JSON.stringify({ protocol: "hangar-fleet-v1", machine: "fixture-second-machine", atlas: true }));
  if (req.url.startsWith("/api/atlas/local/proxy/work")) return res.end(JSON.stringify({ jobs: [], fixture: true }));
  if (req.url === "/api/fleet/local/inference") return res.end(JSON.stringify({ content: "fixture response", machine: "fixture-second-machine" }));
  res.statusCode = 404; res.end("{}");
});
await new Promise(resolve => fixture.listen(0, "127.0.0.1", resolve));
const post = (path, body, headers = {}) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", "X-Hangar": "1", ...headers }, body: JSON.stringify(body) });
try {
  assert.equal((await fetch(`${base}/api/fleet`, { headers: { Origin: "https://other.example" } })).status, 403);
  const add = await post("/api/fleet", { id: peerId, name: "Temporary transport fixture", port: fixture.address().port });
  assert.equal(add.status, 200, await add.text());
  const work = await fetch(`${base}/api/atlas/${peerId}/proxy/work`);
  assert.equal(work.status, 200);
  assert.equal((await work.json()).fixture, true);
  assert.equal((await post(`/api/atlas/${peerId}/proxy/open`, { repo: "test", with: "codex" })).status, 400);
  const inference = await post(`/api/fleet/${peerId}/inference`, { model: "fixture-model", prompt: "fixture prompt" });
  assert.equal(inference.status, 200, await inference.clone().text());
  assert.equal((await inference.json()).content, "fixture response");
  const request = received.find(r => r.url.endsWith("/inference"));
  assert.equal(request.intent, "1");
  assert.deepEqual(JSON.parse(request.body), { model: "fixture-model", prompt: "fixture prompt" });
  assert.equal((await post("/api/fleet/local/inference", { model: "no-such-model", prompt: "never run" })).status, 409);
  assert.equal((await fetch(`${base}/api/atlas/local/view/atlas.json`)).status, 404);
  assert.equal((await post("/api/atlas/local/proxy/git", { action: "push" })).status, 404);
  await new Promise(resolve => fixture.close(resolve));
  assert.equal((await fetch(`${base}/api/fleet/${peerId}/status`)).status, 503);
  assert.equal((await fetch(`${base}/api/atlas/${peerId}/proxy/work`)).status, 503);
  assert.equal((await post(`/api/fleet/${peerId}/inference`, { model: "fixture-model", prompt: "disconnected fixture" })).status, 502);
  console.log("PASS: second-node verification, scoped job reads, exact model forwarding, remote desktop rejection, origin guard, no arbitrary proxy/model fallback, disconnected node returns errors.");
} finally {
  await post("/api/fleet", { action: "remove", id: peerId });
  if (fixture.listening) await new Promise(resolve => fixture.close(resolve));
}
