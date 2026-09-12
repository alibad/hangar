import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { getEventListeners } from "node:events";
import { nodePost } from "../src/lib/qwen-http.ts";

async function upstream(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}/generate`;
}

test("image transport waits for the whole response and cleans up abort listeners", async (t) => {
  const url = await upstream(t, (_req, res) => {
    res.write("image-");
    setImmediate(() => res.end("bytes"));
  });
  const controller = new AbortController();
  const result = await nodePost(url, "{}", {}, controller.signal);
  await new Promise(setImmediate);
  assert.equal(result.toString(), "image-bytes");
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("image transport exposes an upstream failure rather than waiting forever", async (t) => {
  const url = await upstream(t, (_req, res) => { res.writeHead(503); res.end("model busy"); });
  await assert.rejects(nodePost(url, "{}", {}), /Qwen 503: model busy/);
});

test("image transport rejects a truncated image response", async (t) => {
  const url = await upstream(t, (_req, res) => {
    res.writeHead(200, { "Content-Length": "1000" });
    res.write("partial");
    setImmediate(() => res.destroy());
  });
  await assert.rejects(nodePost(url, "{}", {}), /interrupted|aborted|hang up/);
});

test("stopping waiting cancels the pending transport", async (t) => {
  const controller = new AbortController();
  const url = await upstream(t, () => controller.abort());
  await assert.rejects(nodePost(url, "{}", {}, controller.signal), /Cancelled/);
});
