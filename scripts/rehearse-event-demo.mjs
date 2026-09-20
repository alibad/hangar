/**
 * Exercise the live-demo spine against a production build and leave a JSON
 * receipt. This is intentionally HTTP-level: the browser walk captures what an
 * operator sees, while this script proves the controls reached the machine.
 *
 *   HANGAR_URL=http://127.0.0.1:8013 node scripts/rehearse-event-demo.mjs --label round-1
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const base = (process.env.HANGAR_URL || "http://127.0.0.1:8013").replace(/\/$/, "");
const labelAt = process.argv.indexOf("--label");
const label = labelAt >= 0 ? process.argv[labelAt + 1] : "rehearsal";
const startedAt = new Date();
const checks = [];

function record(name, ok, detail, started = Date.now()) {
  const check = { name, ok, detail, durationMs: Date.now() - started };
  checks.push(check);
  console.log(`${ok ? "✓" : "✗"} ${name} — ${detail}`);
  return check;
}

async function request(path, init = {}, timeoutMs = 120_000) {
  const started = Date.now();
  const response = await fetch(`${base}${path}`, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "content-type": "application/json", ...(init.headers || {}) },
  });
  const body = await response.json().catch(() => null);
  return { response, body, started };
}

async function waitForService(id, wanted, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // A cold Ollama boot can make its first health probe spend ten seconds
      // discovering Metal. That probe timing out is not the same as the
      // service start timing out; keep polling until the enclosing bound.
      const { body } = await request("/api/health", {}, 10_000);
      const service = body?.services?.find((item) => item.id === id);
      if (service?.status === wanted) return service;
    } catch {
      // The next probe is the evidence. A transient timeout is recorded in the
      // overall duration rather than turning one cold probe into a false fail.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

try {
  let result = await request("/api/host", {}, 10_000);
  record(
    "host identity",
    result.response.ok && result.body?.id === "b5" && result.body?.matchesProfile === true,
    `${result.body?.name ?? "unknown"}; profile=${result.body?.id ?? "unknown"}; match=${String(result.body?.matchesProfile)}`,
    result.started,
  );

  result = await request("/api/providers", {}, 20_000);
  const local = result.body?.models?.find((model) => model.id === "local-ollama");
  record(
    "installed model and route",
    result.response.ok && local?.status === "ready" && result.body?.routing?.text === "local-ollama",
    `text=${result.body?.routing?.text ?? "unknown"}; local-ollama=${local?.status ?? "missing"}`,
    result.started,
  );

  result = await request(
    "/api/services/ollama",
    { method: "POST", body: JSON.stringify({ action: "stop" }) },
  );
  const stopped = await waitForService("ollama", "down", 20_000);
  record(
    "bounded stop",
    result.response.ok && Boolean(stopped),
    `HTTP ${result.response.status}; final=${stopped?.status ?? "timeout"}`,
    result.started,
  );

  result = await request(
    "/api/services/ollama",
    { method: "POST", body: JSON.stringify({ action: "start" }) },
  );
  const ready = await waitForService("ollama", "up", 30_000);
  record(
    "bounded start",
    result.response.ok && Boolean(ready),
    `HTTP ${result.response.status}; final=${ready?.status ?? "timeout"}`,
    result.started,
  );

  const prompt = "In one sentence, explain why unified memory changes AI model scheduling on Apple silicon.";
  result = await request(
    "/api/chat",
    { method: "POST", body: JSON.stringify({ message: prompt, history: [] }) },
    180_000,
  );
  record(
    "visible local result",
    result.response.ok && typeof result.body?.content === "string" && result.body.content.trim().length >= 20 && !result.body?.degraded,
    `HTTP ${result.response.status}; model=${result.body?.model ?? "unknown"}; ${result.body?.latency ?? "?"}ms; answer=${JSON.stringify(result.body?.content?.slice(0, 180) ?? "")}`,
    result.started,
  );

  result = await request("/api/scout", {}, 20_000);
  const occupant = result.body?.occupants?.find((item) => item.serviceId === "ollama");
  record(
    "resident-memory accounting",
    result.response.ok && occupant?.name === "Ollama · local-ollama" && occupant?.ramGb > 0,
    occupant ? `${occupant.name}; ${occupant.ramGb} GB unified memory` : "no resident Ollama model reported",
    result.started,
  );

  result = await request("/api/traffic", {}, 20_000);
  const relevant = (result.body?.events || []).filter((event) =>
    event.path === "/api/chat" || event.path === "/api/services/ollama"
  );
  const hasChat = relevant.some((event) => event.path === "/api/chat" && event.status === 200 && event.target === "ollama");
  const hasControl = relevant.some((event) => event.path === "/api/services/ollama" && event.status === 200 && event.target === "ollama");
  record(
    "call history",
    result.response.ok && hasChat && hasControl,
    `${relevant.length} operator events; chat=${hasChat}; service-control=${hasControl}`,
    result.started,
  );
} catch (error) {
  record("rehearsal execution", false, error instanceof Error ? error.message : String(error));
}

const finishedAt = new Date();
const passed = checks.every((check) => check.ok);
const report = {
  label,
  base,
  startedAt: startedAt.toISOString(),
  finishedAt: finishedAt.toISOString(),
  elapsedMs: finishedAt.getTime() - startedAt.getTime(),
  passed,
  checks,
};
const outDir = join(import.meta.dirname, "..", "docs", "walkthrough");
mkdirSync(outDir, { recursive: true });
const stamp = startedAt.toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = join(outDir, `event-rehearsal-${stamp}-${label}.json`);
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(`report ${out}`);
process.exitCode = passed ? 0 : 1;
