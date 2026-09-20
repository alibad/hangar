// Service Manager — lightweight HTTP server on :8099
// Handles start/stop/restart for every service on THIS host.
// Run: node scripts/manager.cjs
//
// Host-aware. The service list and the commands file both come from the host
// profile in config/hosts/<id>.json — the same file the console reads — so the
// two can no longer drift (the hand-copied list that used to live here had
// already diverged from the console's once). Resolution mirrors next.config.ts:
// HOST_ID env, then hostname, then a Mac is "b5", else "betenshi".

"use strict";
const http = require("http");
const { spawn, execFile } = require("child_process");
const net = require("net");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { ResourceAdmissionError, ResourceCoordinator, buildResourceProfiles } = require("./resource-coordinator.cjs");

const IS_WIN = process.platform === "win32";

function resolveHostId() {
  const known = new Set(["betenshi", "b5"]);
  const env = (process.env.HOST_ID || "").trim().toLowerCase();
  if (known.has(env)) return env;
  const host = os.hostname().trim().toLowerCase().replace(/\.local$/, "");
  if (known.has(host)) return host;
  return process.platform === "darwin" ? "b5" : "betenshi";
}

const HOST_ID = resolveHostId();
const HOST = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "hosts", `${HOST_ID}.json`), "utf8"));

const PORT = parseInt(process.env.MANAGER_PORT || "8099");
// The real commands file is gitignored: start commands are absolute paths into
// one machine's disk, and the list of them names every other project on it. A
// fresh clone therefore has only the template, and falling back to it with a
// loud message beats dying with ENOENT on a file the repo never shipped.
const COMMANDS_FILE = (() => {
  const named = path.join(__dirname, HOST.commandsFile || "service-commands.json");
  if (fs.existsSync(named)) return named;
  const example = named.replace(/\.json$/, ".example.json");
  if (fs.existsSync(example)) {
    console.warn(
      `[manager] ${path.basename(named)} not found — using ${path.basename(example)}.\n` +
      `[manager] Copy it and replace the placeholder paths, or every Start will fail.`,
    );
    return example;
  }
  return named;
})();
const RESOURCE_POLICY_FILE = path.join(__dirname, "..", "config", "resource-policy.json");
const MODEL_META_FILE = path.join(__dirname, "..", "config", "model-meta.json");

// The manager never supervises itself.
const SERVICES = HOST.services
  .filter((s) => s.id !== "manager")
  .map((s) => ({ id: s.id, name: s.name, port: s.localPort, healthPath: s.healthPath, category: s.category }));

// id -> { proc, logs: string[], startedAt }
const managed = new Map();

const rawResourcePolicy = JSON.parse(fs.readFileSync(RESOURCE_POLICY_FILE, "utf8"));
const hostResourcePolicy = rawResourcePolicy.hosts?.[HOST_ID] || {};
const resourcePolicy = {
  ...rawResourcePolicy,
  services: { ...(rawResourcePolicy.services || {}), ...(hostResourcePolicy.services || {}) },
  workloads: { ...(rawResourcePolicy.workloads || {}), ...(hostResourcePolicy.workloads || {}) },
};
const resourceProfiles = buildResourceProfiles(
  resourcePolicy,
  JSON.parse(fs.readFileSync(MODEL_META_FILE, "utf8"))
);

let gpuCapacityCache = { at: 0, value: null };
function readGpuCapacity() {
  if (gpuCapacityCache.value && Date.now() - gpuCapacityCache.at < 1000) {
    return Promise.resolve(gpuCapacityCache.value);
  }
  if (HOST.gpu !== "nvidia") {
    // Unified memory (Apple silicon): the GPU's budget IS system memory. Hand the
    // coordinator the same numbers on both sides so a model's vramGb and ramGb —
    // which model-meta.json records as equal for these hosts — are checked
    // against a real pool instead of an imaginary empty card.
    return readHostRam().then((ram) => {
      const value = { totalGb: ram.totalGb, freeGb: ram.freeGb };
      gpuCapacityCache = { at: Date.now(), value };
      return value;
    });
  }
  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      ["--query-gpu=memory.total,memory.free", "--format=csv,noheader,nounits"],
      { windowsHide: true },
      (error, stdout) => {
        if (error) return resolve(gpuCapacityCache.value || { totalGb: 0, freeGb: 0 });
        const [totalMib, freeMib] = String(stdout).trim().split(/[,\s]+/).map(Number);
        const value = {
          totalGb: Math.round((totalMib / 1024) * 100) / 100,
          freeGb: Math.round((freeMib / 1024) * 100) / 100,
        };
        gpuCapacityCache = { at: Date.now(), value };
        resolve(value);
      }
    );
  });
}

/**
 * Free RAM meaning "what a new model could take without swapping". os.freemem()
 * is that on Windows; on macOS it counts only literally-free pages and ignores
 * tens of GB of reclaimable cache, so vm_stat's reclaimable classes are summed.
 */
function readHostRam() {
  const totalGb = os.totalmem() / (1024 ** 3);
  if (process.platform !== "darwin") return Promise.resolve({ totalGb, freeGb: os.freemem() / (1024 ** 3) });
  return new Promise((resolve) => {
    execFile("vm_stat", [], (err, stdout) => {
      if (err) return resolve({ totalGb, freeGb: os.freemem() / (1024 ** 3) });
      const out = String(stdout);
      const page = Number((/page size of (\d+)/.exec(out) || [])[1] || 16384);
      const pages = (label) => Number((new RegExp(`${label}:\\s+(\\d+)`).exec(out) || [])[1] || 0);
      const reclaimable = pages("Pages free") + pages("Pages inactive") + pages("Pages speculative") + pages("Pages purgeable");
      resolve({ totalGb, freeGb: (reclaimable * page) / (1024 ** 3) });
    });
  });
}

async function readCapacity() {
  return {
    ram: await readHostRam(),
    vram: await readGpuCapacity(),
    sampledAt: Date.now(),
  };
}

const resourceCoordinator = new ResourceCoordinator({ profiles: resourceProfiles, capacityProvider: readCapacity });
const expectedActiveUntil = new Map();
let reconcilePromise = null;

function reconcileResourceState() {
  if (reconcilePromise) return reconcilePromise;
  reconcilePromise = (async () => {
    const now = Date.now();
    const active = [];
    await Promise.all(SERVICES.map(async (service) => {
      const expected = expectedActiveUntil.get(service.id) || 0;
      if (expected && expected <= now) expectedActiveUntil.delete(service.id);
      if (isProcAlive(managed.get(service.id)) || await isPortOpen(service.port) || expected > now) {
        active.push(service.id);
      }
    }));
    resourceCoordinator.setActiveServices(active);
    resourceCoordinator.reapExpired();
  })().finally(() => { reconcilePromise = null; });
  return reconcilePromise;
}

// Memoised on mtime: status polling asks for this once per service per tick, and
// edits must still take effect without restarting the manager.
let commandsCache = { mtime: 0, value: {} };
function loadCommands() {
  try {
    const mtime = fs.statSync(COMMANDS_FILE).mtimeMs;
    if (mtime !== commandsCache.mtime) {
      commandsCache = { mtime, value: JSON.parse(fs.readFileSync(COMMANDS_FILE, "utf8")) };
    }
    return commandsCache.value;
  } catch (e) {
    console.error("Could not read service-commands.json:", e.message);
    return commandsCache.value || {};
  }
}

/**
 * Read a KEY=VALUE env file for a service's `envFile`.
 *
 * Needed because secrets must NOT live in service-commands.json. That file is
 * gitignored now, but it was tracked for most of this repo's history, so a
 * secret put there is in git forever — the rule stands.
 * and because a library's own dotenv loading can't be relied on: LiteLLM calls
 * load_dotenv() with no arguments, which resolves relative to its own module
 * inside site-packages rather than the process cwd, so a .env sitting next to
 * the config was silently never read.
 *
 * Empty values are skipped deliberately — `FOO=` means "not configured", and
 * exporting it as an empty string makes a provider look configured and then
 * fail at call time.
 */
function loadEnvFile(file) {
  if (!file) return {};
  const out = {};
  try {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue; // comments and blanks
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (v) out[m[1]] = v;
    }
  } catch (e) {
    console.error(`[manager] could not read envFile ${file}: ${e.message}`);
  }
  return out;
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    s.setTimeout(1500);
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => { s.destroy(); resolve(false); });
    s.once("timeout", () => { s.destroy(); resolve(false); });
    s.connect(port, "127.0.0.1");
  });
}

function isProcAlive(entry) {
  if (!entry) return false;
  const { proc } = entry;
  return proc && !proc.killed && proc.exitCode === null && proc.signalCode === null;
}

/**
 * ── ADOPTION ────────────────────────────────────────────────────────────────
 * Who owns the process actually listening on a service's port.
 *
 * The manager used to know only about processes it spawned itself. Anything
 * started by hand (`nohup python server/qwen_image.py &` from a shell) was a
 * ghost: the console showed it "running" — the port is open, after all — but
 * Stop silently did nothing, Restart tried to spawn a second copy that could not
 * bind, and Logs was permanently empty. Worse, a hand-started service misses the
 * env from service-commands.json, which is how Qwen-Image ended up serving with
 * QWEN_EDIT_ENABLED unset and reporting its edit model as "not installed".
 *
 * So: find the PID behind the port and treat it as ours for lifecycle purposes.
 * Output can't be recovered retroactively — the process's stdout was never piped
 * to us — but it CAN be killed, and restarting it through the manager brings it
 * back fully managed, with env and log capture.
 */
function pidOnPort(port) {
  if (!IS_WIN) {
    return new Promise((resolve) => {
      // -t prints bare pids, one per line; exit code 1 just means "no listener".
      execFile("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], (err, stdout) => {
        const pid = Number(String(stdout || "").trim().split(/\s+/)[0]);
        resolve(pid > 1 ? pid : null);
      });
    });
  }
  return new Promise((resolve) => {
    // -ano: numeric, all connections, owning PID. Listing listeners needs no admin.
    execFile("netstat", ["-ano", "-p", "tcp"], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      for (const line of String(stdout).split(/\r?\n/)) {
        if (!/LISTENING/i.test(line)) continue;
        const m = line.trim().match(/^\S+\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
        if (!m || Number(m[2]) !== port) continue;
        const pid = Number(m[3]);
        // 0 = System Idle, 4 = System. Never a service, never killable.
        if (pid > 4) return resolve(pid);
      }
      resolve(null);
    });
  });
}

/**
 * Processes that own a port on behalf of something else. Killing one of these
 * would take down every container on the box, not the one service asked for:
 * Docker publishes all container ports through a single backend process, so
 * webui, grafana and prometheus all resolve to the same PID. A port's owner is
 * only safe to kill when it IS the service.
 */
const SHARED_BROKERS = [
  "com.docker.backend", "com.docker.proxy", "dockerd", "docker",
  "vpnkit", "wslhost", "wslservice", "svchost", "system",
];

function processName(pid) {
  if (!IS_WIN) {
    return new Promise((resolve) => {
      execFile("ps", ["-o", "comm=", "-p", String(pid)], (err, stdout) => {
        if (err) return resolve(null);
        const full = String(stdout).trim();
        resolve(full ? path.basename(full) : null);
      });
    });
  }
  return new Promise((resolve) => {
    execFile("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const m = String(stdout).match(/^"([^"]+)"/m);
      resolve(m ? m[1].replace(/\.exe$/i, "") : null);
    });
  });
}

/**
 * The PID to adopt for a service, or null when there's nothing to adopt.
 *
 * Null means "leave it alone", and covers every case where the port's owner
 * isn't really the service: we spawned it ourselves, it's a container or a
 * Windows service (those have their own stop verbs), or the port belongs to a
 * shared broker.
 */
async function externalPid(svc) {
  if (isProcAlive(managed.get(svc.id))) return null;
  const cfg = loadCommands()[svc.id] || {};
  if (cfg.docker || cfg.windowsService) return null;
  if (!(await isPortOpen(svc.port))) return null;
  const pid = await pidOnPort(svc.port);
  if (!pid || pid === process.pid) return null;
  const name = await processName(pid);
  if (name && SHARED_BROKERS.includes(name.toLowerCase())) {
    console.log(`[manager] ${svc.id}: port ${svc.port} is held by ${name} (pid ${pid}) — not adopting`);
    return null;
  }
  return pid;
}

/** taskkill the whole tree — Windows has no SIGTERM, and a python server that
 *  spawned workers must not leave them holding the port. */
function killTree(pid, force) {
  if (!IS_WIN) {
    // POSIX: TERM the process group (a manager-spawned service is its own group
    // leader — see `detached` below), escalate to KILL after a grace period.
    return new Promise((resolve) => {
      const sig = force ? "SIGKILL" : "SIGTERM";
      try {
        try { process.kill(-pid, sig); } catch { process.kill(pid, sig); }
      } catch (e) {
        return resolve(e.code === "ESRCH" ? { ok: true } : { error: e.message });
      }
      if (force) return resolve({ ok: true });
      setTimeout(() => {
        try { process.kill(pid, 0); } catch { return resolve({ ok: true }); }
        resolve(killTree(pid, true));
      }, 4000);
    });
  }
  return new Promise((resolve) => {
    const args = ["/PID", String(pid), "/T"];
    if (force) args.push("/F");
    execFile("taskkill", args, { windowsHide: true }, (err, stdout, stderr) => {
      const out = `${stdout || ""}${stderr || ""}`;
      // Console apps refuse a polite close; that answer means "use /F".
      if (err && !force && /forcefully/i.test(out)) return resolve(killTree(pid, true));
      resolve(err ? { error: (out || err.message).trim().slice(0, 300) } : { ok: true });
    });
  });
}

// Surface the most informative line from a crashed service's logs for the UI.
function lastError(logs) {
  const lines = (logs || []).filter((l) => !/\[exit\]/.test(l));
  const err = [...lines].reverse().find((l) => /error|traceback|exception|cannot|no module|not found|refused|fatal/i.test(l));
  return (err || lines[lines.length - 1] || "").replace(/^\[[^\]]+\]\s*/, "").slice(0, 300);
}

async function getStatus(svc) {
  const entry = managed.get(svc.id);
  const alive = isProcAlive(entry);
  const open = await isPortOpen(svc.port);

  let status = "stopped";
  let error = null;
  if (open) status = "running";
  else if (alive) status = "starting";
  // Spawned by us, then died non-zero without a stop request → a real failure.
  else if (entry && !entry.stopping && (entry.spawnError || (entry.exitCode != null && entry.exitCode !== 0))) {
    status = "failed";
    error = entry.spawnError || lastError(entry.logs);
  }

  // Something is on the port that we didn't spawn — report it as ours to control,
  // but say plainly that its output was never captured. Containers and Windows
  // services come back null here: they're managed, just not by us.
  const adopted = open && !alive ? await externalPid(svc) : null;

  return {
    id: svc.id,
    name: svc.name,
    type: "process",
    port: svc.port,
    category: svc.category,
    status,
    healthy: open,
    error,
    pid: entry?.proc?.pid ?? adopted ?? null,
    /** "manager" when we spawned it, "external" when it was started elsewhere. */
    owner: alive ? "manager" : adopted ? "external" : null,
    container: null,
    log_tail: entry?.logs?.slice(-100) ?? [],
  };
}

async function startServiceRaw(id) {
  const commands = loadCommands();
  const cfg = commands[id];

  if (!cfg) {
    return { error: `No command configured for "${id}". Edit scripts/service-commands.json.` };
  }
  if (cfg.skip) {
    return { error: `"${id}" is marked skip (externally managed). Start it manually.` };
  }
  if (cfg.TODO && cfg.skip) {
    return { error: `"${id}" needs configuration. Edit scripts/service-commands.json (see TODO field).` };
  }

  const entry = managed.get(id);
  if (isProcAlive(entry)) {
    return { ok: true, message: "Already running", pid: entry.proc.pid };
  }

  // Don't spawn a second copy that can't bind. Say who has the port instead —
  // "port in use" with no owner was the least actionable failure this could give.
  const svc = SERVICES.find((s) => s.id === id);
  if (svc && !cfg.docker && !cfg.windowsService) {
    const foreign = await externalPid(svc);
    if (foreign) {
      return {
        ok: true,
        pid: foreign,
        owner: "external",
        message:
          `Already running as pid ${foreign}, started outside the manager. ` +
          `Restart to hand it over (that reapplies its configured env and starts capturing logs).`,
      };
    }
  }

  // Docker container
  if (cfg.docker) {
    return new Promise((resolve) => {
      execFile("docker", ["start", cfg.docker], (err, stdout, stderr) => {
        if (err) resolve({ error: `docker start ${cfg.docker}: ${stderr || err.message}` });
        else resolve({ ok: true, message: `Container ${cfg.docker} started` });
      });
    });
  }

  // Windows service via sc.exe
  if (cfg.windowsService) {
    return new Promise((resolve) => {
      execFile("sc", ["start", cfg.windowsService], (err, stdout) => {
        if (err && !stdout.includes("RUNNING")) {
          resolve({ error: `sc start failed: ${err.message}` });
        } else {
          resolve({ ok: true, message: `Windows service ${cfg.windowsService} started` });
        }
      });
    });
  }

  const logs = [];
  const fileEnv = loadEnvFile(cfg.envFile);
  if (cfg.envFile) {
    const names = Object.keys(fileEnv);
    // Names only — never log a secret value.
    console.log(`[manager] ${id}: loaded ${names.length} var(s) from envFile: ${names.join(", ") || "(none set)"}`);
  }
  const opts = {
    env: { ...process.env, ...fileEnv, ...(cfg.env || {}) },
    cwd: cfg.cwd || process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    // Own process group on POSIX so a stop can signal the whole tree.
    detached: !IS_WIN,
  };

  let proc;
  try {
    proc = spawn(cfg.cmd, cfg.args || [], opts);
  } catch (e) {
    return { error: `Failed to spawn "${cfg.cmd}": ${e.message}` };
  }

  const tag = (line) => `[${new Date().toISOString()}] ${line}`;
  const onData = (buf) => {
    buf.toString().split(/\r?\n/).filter(Boolean).forEach((l) => {
      logs.push(tag(l));
      if (logs.length > 2000) logs.splice(0, logs.length - 2000);
    });
  };
  // Track exit info on the entry so getStatus() can tell a crash from a clean stop.
  const newEntry = { proc, logs, startedAt: Date.now(), stopping: false, exitCode: null, exitSignal: null, spawnError: null };
  proc.stdout.on("data", onData);
  proc.stderr.on("data", onData);
  proc.on("error", (e) => { newEntry.spawnError = e.message; logs.push(tag(`[spawn-error] ${e.message}`)); });
  proc.on("exit", (code, sig) => {
    newEntry.exitCode = code;
    newEntry.exitSignal = sig;
    logs.push(tag(`[exit] code=${code} signal=${sig}`));
  });

  managed.set(id, newEntry);
  console.log(`[manager] started ${id} pid=${proc.pid}`);
  return { ok: true, pid: proc.pid };
}

async function stopServiceRaw(id) {
  const commands = loadCommands();
  const cfg = commands[id] || {};

  // Docker and Windows services stop regardless of whether we started them
  if (cfg.docker) {
    return new Promise((resolve) => {
      execFile("docker", ["stop", cfg.docker], (err, stdout, stderr) => {
        if (err) resolve({ error: `docker stop ${cfg.docker}: ${stderr || err.message}` });
        else resolve({ ok: true, message: `Container ${cfg.docker} stopped` });
      });
    });
  }

  if (cfg.windowsService) {
    return new Promise((resolve) => {
      execFile("sc", ["stop", cfg.windowsService], (err) => {
        resolve(err ? { error: `sc stop failed: ${err.message}` } : { ok: true });
      });
    });
  }

  // Spawned process
  const entry = managed.get(id);
  if (!isProcAlive(entry)) {
    // Not ours — but if something is holding the port, stop means stop.
    const svc = SERVICES.find((s) => s.id === id);
    const foreign = svc ? await externalPid(svc) : null;
    if (!foreign) return { ok: true, message: "Not running" };
    console.log(`[manager] stopping ${id} — adopting external pid ${foreign}`);
    const killed = await killTree(foreign, false);
    if (killed.error) return { error: `Could not stop pid ${foreign}: ${killed.error}` };
    return { ok: true, pid: foreign, owner: "external", message: `Stopped external pid ${foreign}` };
  }

  entry.stopping = true; // so the ensuing exit reads as a clean stop, not a failure
  entry.proc.kill("SIGTERM");
  // Escalate to SIGKILL only for THIS process. Re-looking the service up by id
  // at fire time was a bug: a restart that spawned a replacement within the
  // grace window had the replacement killed by the previous stop's timer, so
  // the service ended up down with a healthy-looking {ok:true} restart reply.
  const target = entry;
  setTimeout(() => {
    if (isProcAlive(target) && managed.get(id) === target) {
      target.proc.kill("SIGKILL");
    }
  }, 6000);
  console.log(`[manager] stopping ${id}`);
  return { ok: true };
}

async function startService(id) {
  await reconcileResourceState();
  const reservation = await resourceCoordinator.reserveServiceStart(id);
  if (!reservation.ok) {
    return {
      error: `Cannot start ${id}: ${reservation.error}`,
      code: "resource-blocked",
      resourceBlocked: true,
      denial: reservation.denial,
      capacity: reservation.capacity,
      usage: reservation.usage,
    };
  }

  try {
    const result = await startServiceRaw(id);
    if (result?.error) return result;
    expectedActiveUntil.set(id, Date.now() + 60_000);
    resourceCoordinator.promoteServiceStart(reservation.reservationId, id);
    return result;
  } finally {
    resourceCoordinator.releaseServiceStart(reservation.reservationId);
  }
}

async function stopService(id) {
  const result = await stopServiceRaw(id);
  if (!result?.error) {
    expectedActiveUntil.delete(id);
    resourceCoordinator.markServiceActive(id, false);
  }
  return result;
}

async function restartService(id) {
  const prev = managed.get(id);
  const svc = SERVICES.find((s) => s.id === id);
  const stopped = await stopService(id);
  if (stopped && stopped.error) return stopped;
  // Wait for the old process to actually let go rather than guessing. A model
  // server holding tens of GB can take many seconds to unwind, and starting
  // while it is still alive makes startService() answer "Already running"
  // without spawning anything.
  //
  // The PORT is the condition, not just our process handle: for an adopted
  // process there is no handle to watch, and it's the port a restart is really
  // waiting on either way.
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (!isProcAlive(prev) && svc && !(await isPortOpen(svc.port))) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const started = await startService(id);
  // Restarting an adopted process is the documented way to hand it over, so say
  // that's what happened rather than reporting a plain start.
  if (stopped && stopped.owner === "external" && started && !started.error) {
    return { ...started, message: `Handed over from external pid ${stopped.pid} — now manager-owned.` };
  }
  return started;
}

// ── HTTP server ──────────────────────────────────────────────────────────────

function respond(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try { resolve(JSON.parse(data || "{}")); }
      catch { resolve({}); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST", "Access-Control-Allow-Headers": "Content-Type" });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");

  try {
    // GET /resources — live capacity, modeled usage, leases, and queue.
    if (req.method === "GET" && parts[0] === "resources" && !parts[1]) {
      await reconcileResourceState();
      return respond(res, 200, await resourceCoordinator.snapshot());
    }

    // POST /resources/leases/acquire
    if (req.method === "POST" && parts[0] === "resources" && parts[1] === "leases" && parts[2] === "acquire") {
      const body = await readBody(req);
      const controller = new AbortController();
      req.once("aborted", () => controller.abort());
      res.once("close", () => { if (!res.writableEnded) controller.abort(); });
      try {
        const lease = await resourceCoordinator.acquire(body.workload, {
          owner: body.owner,
          lane: body.lane,
          waitMs: body.waitMs,
          ttlMs: body.ttlMs,
          signal: controller.signal,
        });
        return respond(res, 201, { ok: true, lease });
      } catch (error) {
        if (error instanceof ResourceAdmissionError) {
          const status = error.code === "unknown-workload" ? 400 : error.code === "resource-cancelled" ? 499 : 409;
          return respond(res, status, { error: error.message, code: error.code, details: error.details });
        }
        throw error;
      }
    }

    // POST /resources/leases/:id/release
    if (req.method === "POST" && parts[0] === "resources" && parts[1] === "leases" && parts[3] === "release") {
      const released = resourceCoordinator.release(parts[2]);
      return respond(res, released ? 200 : 404, released ? { ok: true } : { error: "Lease not found" });
    }

    // GET /services
    if (req.method === "GET" && parts[0] === "services" && !parts[1]) {
      const statuses = await Promise.all(SERVICES.map(getStatus));
      return respond(res, 200, statuses);
    }

    // GET /services/:id/logs
    if (req.method === "GET" && parts[0] === "services" && parts[2] === "logs") {
      const id = parts[1];
      const entry = managed.get(id);
      const tail = parseInt(url.searchParams.get("tail") || "50");
      if (entry?.logs?.length) {
        return respond(res, 200, { logs: entry.logs.slice(-tail) });
      }
      // An empty array reads as "this service is silent", which is wrong and
      // unactionable when the real reason is that we never had its stdout.
      const svc = SERVICES.find((s) => s.id === id);
      const foreign = svc ? await externalPid(svc) : null;
      if (foreign) {
        return respond(res, 200, {
          owner: "external",
          pid: foreign,
          logs: [
            `[manager] ${svc.name} is running as pid ${foreign}, started outside the manager.`,
            `[manager] Its output goes wherever that shell sent it — the manager never had a pipe to it, so there is nothing to show here.`,
            `[manager] Restart it from the console to hand it over: that reapplies the env from service-commands.json and starts capturing output.`,
          ],
        });
      }
      return respond(res, 200, { logs: [] });
    }

    // POST /services/:id/start|stop|restart
    if (req.method === "POST" && parts[0] === "services" && parts[2]) {
      const [, id, action] = parts;
      let result;
      if (action === "start")        result = await startService(id);
      else if (action === "stop")    result = await stopService(id);
      else if (action === "restart") result = await restartService(id);
      else return respond(res, 400, { error: "Unknown action" });

      if (result && result.error) return respond(res, result.resourceBlocked ? 409 : 400, result);
      return respond(res, 200, result || { ok: true });
    }

    respond(res, 404, { error: "Not found" });
  } catch (e) {
    console.error("[manager] error:", e);
    respond(res, 500, { error: e.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`${HOST.name} Manager listening on :${PORT}  (host profile: ${HOST_ID}, commands: ${path.basename(COMMANDS_FILE)})`);
  const commands = loadCommands();
  const configured = Object.entries(commands)
    .filter(([k, v]) => !v.skip && (v.cmd || v.windowsService || v.docker))
    .map(([k]) => k);
  const todo = Object.entries(commands)
    .filter(([k, v]) => v.skip)
    .map(([k]) => k);
  if (configured.length) console.log(`  Ready:  ${configured.join(", ")}`);
  if (todo.length)       console.log(`  TODO:   ${todo.join(", ")} — edit scripts/service-commands.json`);
});

const resourceTimer = setInterval(() => {
  reconcileResourceState().catch((error) => console.error("[resources] reconcile failed:", error.message));
}, 5000);
resourceTimer.unref();
reconcileResourceState().catch((error) => console.error("[resources] initial reconcile failed:", error.message));

process.on("SIGINT", () => {
  console.log("\n[manager] shutting down — stopping managed services");
  for (const [id, entry] of managed) {
    if (isProcAlive(entry)) {
      entry.proc.kill("SIGTERM");
      console.log(`  stopped ${id}`);
    }
  }
  server.close(() => process.exit(0));
});
