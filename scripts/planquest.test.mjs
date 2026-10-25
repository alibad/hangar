import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createPlanQuestClient, hideSecrets, HIDDEN_LINE, loopbackOrigin, validatePlanId, PLANQUEST_MCP } from "../src/lib/planquest.ts";
import { planquestTools } from "./planquest-tools.mjs";

const origin = "http://127.0.0.1:8003";
const response = (value, status = 200) => Response.json(value, { status });
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "hangar-planquest-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  let clock = 1700000000000, refreshes = 0;
  let failRefresh = 0, failRevoke = false, failMcp = false;
  const client = createPlanQuestClient({ directory, now: () => clock, protectDirectory: async () => {}, fetch: async (url, init) => {
    calls.push({ url, init });
    assert.equal(new URL(url).origin, "https://my.plans.quest");
    assert.equal(init.redirect, "error");
    if (url.endsWith("/register")) return response({ client_id: "fixture-client" }, 201);
    if (url.endsWith("/token")) {
      const data = init.body;
      assert.equal(data.get("resource"), PLANQUEST_MCP);
      if (data.get("grant_type") === "refresh_token") { refreshes++; if (failRefresh) return response({}, failRefresh); }
      else assert.ok(data.get("code_verifier"));
      return response({ access_token: `fixture-access-${refreshes}`, refresh_token: `fixture-refresh-${refreshes}`, scope: "plans:read", expires_in: 3600 });
    }
    if (url.endsWith("/revoke")) return response({}, failRevoke ? 503 : 200);
    assert.equal(url, PLANQUEST_MCP);
    const rpc = JSON.parse(init.body);
    assert.match(init.headers.Authorization, /^Bearer fixture-access-/);
    if (failMcp) return response({}, 401);
    if (rpc.method === "initialize") return response({ result: { protocolVersion: "2025-06-18" } });
    if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
    assert.equal(rpc.method, "tools/call");
    assert.ok(["list_plans", "get_plan"].includes(rpc.params.name));
    const plan = { id: "launch", title: "Launch the product", description: "Ship useful work", access: "owner", folder_path: ["Product"], progress: 45, url: "https://untrusted.example/redirect", milestones: [
      { id: "m1", objective: "Ship the beta", progress: 40, key_results: [{ description: "Onboard testers", progress: 30 }, { description: "Removed", scratched: true }] },
      { id: "m2", objective: "Archived", archived: true },
    ] };
    return response({ result: { structuredContent: rpc.params.name === "list_plans" ? { plans: [plan] } : { plan } } });
  } });
  async function authorize() {
    const started = await client.begin(origin, "/#projects");
    await client.finish(origin, new URL(started.url).searchParams.get("state"), started.cookie, "fixture-code");
    return started;
  }
  return { client, calls, directory, authorize, advance: ms => { clock += ms; }, failures: (refresh, revoke = false, mcp = false) => { failRefresh = refresh; failRevoke = revoke; failMcp = mcp; }, refreshes: () => refreshes };
}

test("OAuth requests only read access, with PKCE and browser-bound single-use state", async t => {
  const f = await fixture(t), started = await f.client.begin(origin, "/#projects");
  const url = new URL(started.url), state = url.searchParams.get("state");
  assert.equal(url.searchParams.get("scope"), "plans:read");
  assert.equal(url.searchParams.get("resource"), PLANQUEST_MCP);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  const pending = JSON.parse(await readFile(join(f.directory, "connection.json"), "utf8")).pending;
  assert.equal(url.searchParams.get("code_challenge"), createHash("sha256").update(pending.verifier).digest("base64url"));
  assert.notEqual(pending.hash, state);
  assert.notEqual(pending.cookieHash, started.cookie);
  await assert.rejects(f.client.finish(origin, state, "other-browser", "fixture-code"), /another browser/);
  await assert.rejects(f.client.finish("http://localhost:8003", state, started.cookie, "fixture-code"), /another browser/);
  await assert.rejects(f.client.finish(origin, "wrong-state", started.cookie, "fixture-code"), /another browser/);
  assert.equal((await f.client.finish(origin, state, started.cookie, "fixture-code")).connected, true);
  await assert.rejects(f.client.finish(origin, state, started.cookie, "fixture-code"), /another browser/);
  assert.equal(f.calls.filter(c => c.url.endsWith("/token")).length, 1);
  const status = await f.client.status();
  assert.equal(status.connected, true);
  assert.equal(JSON.stringify(status).includes("fixture-access"), false);
});

test("expired or declined authorization never exchanges a token", async t => {
  const f = await fixture(t), started = await f.client.begin(origin, "https://untrusted.example");
  f.advance(600001);
  await assert.rejects(f.client.finish(origin, new URL(started.url).searchParams.get("state"), started.cookie, "fixture-code"), /expired/);
  const next = await f.client.begin(origin, "https://untrusted.example");
  assert.deepEqual(await f.client.finish(origin, new URL(next.url).searchParams.get("state"), next.cookie, "", true), { returnTo: "/#projects", connected: false });
  assert.equal(f.calls.filter(c => c.url.endsWith("/token")).length, 0);
});

test("plan reads use MCP, sanitize URLs and exclude archived milestones", async t => {
  const f = await fixture(t);
  await assert.rejects(f.client.plans(), /Connect PlanQuest/);
  await f.authorize();
  const plans = await f.client.plans(), plan = await f.client.plan("launch");
  assert.equal(plans[0].url, "https://my.plans.quest/plans/launch");
  assert.equal(plan.progress, 45);
  assert.equal(plan.milestones.length, 1);
  assert.equal(plan.milestones[0].keyResults.length, 1);
  const calls = f.calls.filter(c => c.url === PLANQUEST_MCP).map(c => JSON.parse(c.init.body));
  assert.deepEqual(calls.filter(c => c.method === "tools/call").map(c => c.params), [{ name: "list_plans", arguments: { include_archived: false } }, { name: "get_plan", arguments: { plan_id: "launch" } }]);
});

test("sign-in details in plan text are hidden before they leave the server", () => {
  const text = ["Website: https://example.test/", "Admin URL: https://example.test/wp-admin/", "Username: someone", "WordPress password: hunter2",
    "Email password: hunter3", "API key = sk-test", "Token: abc", "Plan the launch and the password reset flow"].join("\n");
  const out = hideSecrets(text).split("\n");
  assert.deepEqual(out.slice(0, 2), ["Website: https://example.test/", "Admin URL: https://example.test/wp-admin/"]);
  assert.deepEqual(out.slice(2, 7), Array(5).fill(HIDDEN_LINE));
  assert.equal(out[7], "Plan the launch and the password reset flow");  // prose about passwords is not a credential
  assert.ok(!/hunter|sk-test|abc|someone/.test(out.join(" ")));
});

test("the plan list is read at most once a minute unless a refresh asks for fresh data", async t => {
  const f = await fixture(t);
  await f.authorize();
  const lists = () => f.calls.filter(c => c.url === PLANQUEST_MCP).map(c => JSON.parse(c.init.body)).filter(c => c.params?.name === "list_plans").length;
  await f.client.plans(); await f.client.plans();
  assert.equal(lists(), 1);
  f.advance(61_000); await f.client.plans();
  assert.equal(lists(), 2);
  await f.client.plans(true);
  assert.equal(lists(), 3);
  await f.client.disconnect(); await f.authorize(); await f.client.plans();
  assert.equal(lists(), 4);  // a new connection never sees the old list
});

test("concurrent reads rotate an expired refresh token exactly once", async t => {
  const f = await fixture(t); await f.authorize(); f.advance(3600000);
  await Promise.all([f.client.plans(), f.client.plan("launch"), f.client.plans()]);
  assert.equal(f.refreshes(), 1);
  const stored = JSON.parse(await readFile(join(f.directory, "connection.json"), "utf8"));
  assert.equal(stored.token.refresh_token, "fixture-refresh-1");
});

test("revoked authorization clears invalid credentials and disconnect reports revocation failure", async t => {
  const f = await fixture(t); await f.authorize(); f.advance(3600000); f.failures(400);
  await assert.rejects(f.client.plans(), /sign-in/);
  assert.equal((await f.client.status()).connected, false);
  f.failures(0); await f.authorize(); f.failures(0, true);
  assert.deepEqual(await f.client.disconnect(), { disconnected: true, revoked: false });
  const stored = await readFile(join(f.directory, "connection.json"), "utf8");
  assert.equal(stored.includes("fixture-access"), false);
  assert.equal(stored.includes("fixture-refresh"), false);
});

test("unavailable provider preserves refresh credentials; revoked MCP access is actionable", async t => {
  const f = await fixture(t); await f.authorize(); f.advance(3600000); f.failures(503);
  await assert.rejects(f.client.plans());
  assert.equal((await f.client.status()).connected, true);
  f.failures(0, false, true);
  await assert.rejects(f.client.plans(), /revoked/);
});

test("origins and plan IDs cannot escape the intended API", () => {
  for (const value of ["https://untrusted.example", "http://127.0.0.1.evil:8003", "http://name:pass@127.0.0.1:8003", "http://127.0.0.1"]) assert.throws(() => loopbackOrigin(value));
  for (const value of ["../private", "a/b", "a?x=1", null, ""]) assert.throws(() => validatePlanId(value));
  assert.equal(loopbackOrigin(origin), origin);
});

test("agent tools perform readonly lookups and explicit ID-only local linkage", async () => {
  const calls = [];
  const tools = planquestTools(async (path, init) => { calls.push({ path, init }); return { res: response({ ok: true }) }; });
  await tools.find(t => t.name === "planquest_plans").run({ query: "beta & release" });
  await tools.find(t => t.name === "planquest_plan").run({ plan_id: "launch" });
  await tools.find(t => t.name === "planquest_link").run({ repo: "sample/project", plan_id: "launch", machine: "laptop" });
  assert.equal(calls[0].path, "/api/planquest/plans?q=beta%20%26%20release");
  assert.equal(calls[0].init, undefined);
  assert.equal(calls[1].path, "/api/planquest/plans/launch");
  assert.equal(calls[2].init.headers["X-Hangar"], "1");
  assert.deepEqual(JSON.parse(calls[2].init.body), { repo: "sample/project", plan_id: "launch", machine: "laptop" });
});
