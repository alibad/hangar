import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { GATE_PORT, gateAllows, isTailnetIp, peerId, readTailnet, tailnetCaller, tailscaleInstall, validatePeer } from "../src/lib/fleet-policy.ts";
import { createGate } from "../src/lib/tailnet-gate.ts";

// The shape `tailscale status --json` prints (ipnstate.Status in Tailscale's source), with made-up devices.
const node = (HostName, OS, ip, UserID, more = {}) => ({ HostName, DNSName: `${HostName.toLowerCase()}.tailnet.example.`, OS, UserID, TailscaleIPs: [ip, "fd7a:115c:a1e0::1"], Online: true, ...more });
const STATUS = {
  BackendState: "Running", AuthURL: "",
  Self: node("Desk-PC", "windows", "100.101.1.1", 11),
  User: { 11: { LoginName: "owner@example.com" }, 22: { LoginName: "friend@example.com" } },
  Peer: {
    "nodekey:a": node("Travel-Mac", "macOS", "100.101.1.2", 11),
    "nodekey:b": node("Old-Laptop", "linux", "100.101.1.3", 11, { Online: false }),
    "nodekey:c": node("Phone", "iOS", "100.101.1.4", 11),
    "nodekey:d": node("Friends-PC", "windows", "100.101.1.5", 22),
    "nodekey:e": node("Shared-In", "windows", "100.101.1.6", 11, { ShareeNode: true }),
    "nodekey:f": node("Build-Server", "linux", "100.101.1.7", 11, { Tags: ["tag:server"] }),
    "nodekey:g": node("Odd-Address", "windows", "192.168.1.9", 11),
  },
};

test("a Tailscale address is 100.64.0.0/10 and nothing else", () => {
  for (const ip of ["100.64.0.0", "100.101.1.2", "100.127.255.255"]) assert.equal(isTailnetIp(ip), true, ip);
  for (const ip of ["100.63.0.1", "100.128.0.1", "127.0.0.1", "192.168.1.9", "100.64.0.256", "100.64.0", "100.64.0.1:80", "evil.example", "", null, 100]) assert.equal(isTailnetIp(ip), false, String(ip));
});

test("only the owner's own computers are offered, online ones first", () => {
  const net = readTailnet(STATUS);
  assert.equal(net.state, "running");
  assert.deepEqual(net.self, { name: "Desk-PC", os: "windows", ip: "100.101.1.1", online: true, login: "owner@example.com" });
  // No phone, no other person's device, nothing shared in from another network, no tagged server, no odd address.
  assert.deepEqual(net.devices.map(d => [d.name, d.online]), [["Travel-Mac", true], ["Old-Laptop", false]]);
});

test("Tailscale that is signed out, waiting or stopped offers nothing", () => {
  assert.equal(readTailnet({ ...STATUS, BackendState: "NeedsLogin", AuthURL: "https://login.tailscale.com/a/abc" }).state, "signin");
  assert.equal(readTailnet({ ...STATUS, BackendState: "NeedsLogin", AuthURL: "https://login.tailscale.com/a/abc" }).authUrl, "https://login.tailscale.com/a/abc");
  assert.equal(readTailnet({ ...STATUS, BackendState: "NeedsLogin", AuthURL: "https://evil.example/a" }).authUrl, "");
  assert.equal(readTailnet({ ...STATUS, BackendState: "NeedsMachineAuth" }).state, "approval");
  for (const state of ["Stopped", "Starting", "NoState", "Something new"]) assert.equal(readTailnet({ ...STATUS, BackendState: state }).state, "off");
  for (const raw of [{ ...STATUS, BackendState: "Stopped" }, { BackendState: "Running" }, {}, null, "text"]) assert.deepEqual(readTailnet(raw).devices, []);
});

test("a caller is let in only when Tailscale says it is the owner's own computer", () => {
  const who = (LoginName, Node = { ComputedName: "Travel-Mac" }) => ({ Node, UserProfile: { LoginName } });
  assert.deepEqual(tailnetCaller(who("owner@example.com"), "owner@example.com"), { name: "Travel-Mac" });
  assert.deepEqual(tailnetCaller(who("owner@example.com", { Name: "old-laptop.tailnet.example." }), "owner@example.com"), { name: "old-laptop" });
  assert.equal(tailnetCaller(who("friend@example.com"), "owner@example.com"), null);
  assert.equal(tailnetCaller(who("tagged-devices"), "owner@example.com"), null);
  assert.equal(tailnetCaller(who("owner@example.com", { ComputedName: "Build", Tags: ["tag:server"] }), "owner@example.com"), null);
  for (const raw of [{}, null, "text", { UserProfile: {} }]) assert.equal(tailnetCaller(raw, "owner@example.com"), null);
  assert.equal(tailnetCaller(who(""), ""), null);
});

test("the gate passes on what a paired Hangar needs and nothing else", () => {
  assert.equal(gateAllows("GET", "/api/fleet/local/status"), "forward");
  assert.equal(gateAllows("GET", "/api/fleet/local/models"), "forward");
  assert.equal(gateAllows("POST", "/api/fleet/local/inference"), "forward");
  assert.equal(gateAllows("GET", "/api/world/local/proxy/sessions/library"), "forward");
  assert.equal(gateAllows("POST", "/api/world/local/proxy/work"), "forward");
  assert.equal(gateAllows("GET", "/api/world/local/view/index.html"), "forward");
  assert.equal(gateAllows("POST", "/api/fleet/pair"), "pair");
  for (const [method, path] of [
    ["GET", "/"], ["GET", "/api/services"], ["POST", "/api/services/vllm/start"], ["POST", "/api/chat"], ["GET", "/api/fleet"], ["POST", "/api/fleet"],
    ["GET", "/api/fleet/tailnet"], ["POST", "/api/fleet/tailnet"], ["GET", "/api/fleet/pair"], ["POST", "/api/fleet/local/status"], ["GET", "/api/fleet/local/inference"],
    // Another machine's entry on this one must not be reachable through it: no hopping from computer to computer.
    ["GET", "/api/fleet/laptop/status"], ["GET", "/api/world/laptop/proxy/sessions"], ["GET", "/api/atlas/local/proxy/sessions"],
    // A desktop window opens for the person at that desk, never from another computer.
    ["POST", "/api/world/local/proxy/open"], ["POST", "/api/world/local/proxy/sessions/resume"], ["POST", "/api/world/local/proxy/apps"],
    ["GET", "/api/world/local/proxy/../../services"], ["GET", "/api/world/local/proxy/%2e%2e/x"], ["GET", "/api/world/local/files/secret"],
    ["DELETE", "/api/fleet/local/status"], ["PUT", "/api/fleet/pair"],
  ]) assert.equal(gateAllows(method, path), null, `${method} ${path}`);
});

test("a machine found on Tailscale is saved by its Tailscale address", () => {
  assert.deepEqual(validatePeer({ id: "travel-mac", name: "Travel-Mac", port: GATE_PORT, tailnet: "100.101.1.2" }), { id: "travel-mac", name: "Travel-Mac", port: GATE_PORT, tailnet: "100.101.1.2" });
  for (const tailnet of ["192.168.1.9", "evil.example", "100.101.1.2:80", "http://100.101.1.2", ""]) assert.throws(() => validatePeer({ id: "travel-mac", name: "Travel-Mac", port: GATE_PORT, tailnet }), tailnet);
  assert.equal(peerId("Travel-Mac", []), "travel-mac");
  assert.equal(peerId("Travel-Mac", ["travel-mac"]), "travel-mac-2");
  assert.equal(peerId("9 Lives", []), "pc-9-lives");
  assert.equal(peerId("local", []), "pc-local");
  assert.equal(peerId("???", []), "pc-other");
  for (const name of ["Travel-Mac", "9 Lives", "local", "???", "A".repeat(80)]) assert.doesNotThrow(() => validatePeer({ id: peerId(name, []), name: "x", port: GATE_PORT }));
  assert.match(tailscaleInstall("win32").url, /^https:\/\/tailscale\.com\/download\//);
  assert.equal(tailscaleInstall("darwin").command, "");
});

// The gate itself, with a made-up Hangar behind it and a made-up answer to "who is calling".
async function gate(t, caller) {
  const seen = [];
  const hangar = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": "secret=1", "X-Internal": "yes" });
      res.end(JSON.stringify({ protocol: "hangar-fleet-v1", machine: "Desk-PC" }));
    });
  });
  await new Promise(resolve => hangar.listen(0, "127.0.0.1", resolve));
  const paired = [];
  const server = createGate({ caller, decide: gateAllows, upstream: { host: "127.0.0.1", port: hangar.address().port },
    pair: async (ip, body, who) => { paired.push({ ip, body, who }); return { paired: true }; } });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.close(); hangar.close(); });
  return { base: `http://127.0.0.1:${server.address().port}`, seen, paired, port: hangar.address().port };
}

test("the gate turns away anyone Tailscale does not name as the owner's computer", async t => {
  const { base, seen, paired } = await gate(t, async () => null);
  for (const [path, init] of [["/api/fleet/local/status", {}], ["/api/fleet/pair", { method: "POST", body: "{}" }], ["/api/world/local/proxy/work", { method: "POST", body: "{}" }]]) {
    const response = await fetch(base + path, init);
    assert.equal(response.status, 403, path);
  }
  assert.deepEqual(seen, []);
  assert.deepEqual(paired, []);
  // An error while asking is a refusal too, never a way in.
  const broken = await gate(t, async () => { throw new Error("tailscale is not answering"); });
  assert.equal((await fetch(`${broken.base}/api/fleet/local/status`)).status, 403);
  assert.deepEqual(broken.seen, []);
});

test("the gate passes an allowed request to Hangar on loopback without the caller's headers", async t => {
  const { base, seen, port } = await gate(t, async () => ({ name: "Travel-Mac" }));
  const response = await fetch(`${base}/api/world/local/proxy/sessions/library?days=7`, { headers: { Cookie: "session=stolen", Origin: "https://evil.example", "X-Forwarded-Host": "evil.example", Authorization: "Bearer x" } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).machine, "Desk-PC");
  // Hangar's own cookies and internal headers do not travel back either.
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("x-internal"), null);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "/api/world/local/proxy/sessions/library?days=7");
  assert.equal(seen[0].headers.host, `127.0.0.1:${port}`);
  assert.equal(seen[0].headers["x-hangar"], "1");
  for (const name of ["cookie", "origin", "x-forwarded-host", "authorization"]) assert.equal(seen[0].headers[name], undefined, name);

  const posted = await fetch(`${base}/api/fleet/local/inference`, { method: "POST", body: JSON.stringify({ model: "m", prompt: "hello" }) });
  assert.equal(posted.status, 200);
  assert.deepEqual(JSON.parse(seen[1].body), { model: "m", prompt: "hello" });
});

test("the gate refuses everything else of Hangar, and oversized bodies", async t => {
  const { base, seen } = await gate(t, async () => ({ name: "Travel-Mac" }));
  for (const [path, init] of [["/api/services", {}], ["/api/chat", { method: "POST", body: "{}" }], ["/api/world/local/proxy/open", { method: "POST", body: "{}" }], ["/api/fleet/laptop/status", {}]]) {
    assert.equal((await fetch(base + path, init)).status, 404, path);
  }
  assert.equal((await fetch(`${base}/api/fleet/local/inference`, { method: "POST", body: "x".repeat(70000) })).status, 413);
  assert.deepEqual(seen, []);
});

test("pairing takes the address from the connection and the name from Tailscale", async t => {
  const { base, paired, seen } = await gate(t, async () => ({ name: "Travel-Mac" }));
  const response = await fetch(`${base}/api/fleet/pair`, { method: "POST", body: JSON.stringify({ port: GATE_PORT, name: "Pretender", tailnet: "100.99.99.99" }) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { paired: true });
  assert.equal(paired.length, 1);
  assert.equal(paired[0].ip, "127.0.0.1");
  assert.deepEqual(paired[0].who, { name: "Travel-Mac" });
  assert.deepEqual(seen, []);
  assert.equal((await fetch(`${base}/api/fleet/pair`, { method: "POST", body: "not json" })).status, 400);
});
