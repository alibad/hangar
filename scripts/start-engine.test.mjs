import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const START = join(dirname(fileURLToPath(import.meta.url)), "start-engine.mjs");

// Fake interpreters: each passes the version probe (-c) or not, and names itself when run as the engine.
async function fakePython(dir, name, newEnough) {
  const file = join(dir, name);
  await writeFile(file, `#!/bin/sh\n[ "$1" = "-c" ] && exit ${newEnough ? 0 : 1}\necho "engine ran with ${name}"\n`);
  await chmod(file, 0o755);
}

test("the engine skips a python3 older than 3.10, as launchd's PATH gives on macOS", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "hangar-python-"));
  try {
    await fakePython(dir, "python3", false);
    await fakePython(dir, "python3.12", true);
    const run = spawnSync(process.execPath, [START], { env: { PATH: dir, HANGAR_ENGINE_PORT: "0" }, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /engine ran with python3\.12/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an explicit HANGAR_ENGINE_PYTHON is used as given", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "hangar-python-"));
  try {
    await fakePython(dir, "python3", true);
    await fakePython(dir, "chosen-python", false);
    const run = spawnSync(process.execPath, [START], { env: { PATH: dir, HANGAR_ENGINE_PYTHON: join(dir, "chosen-python") }, encoding: "utf8" });
    assert.match(run.stdout, /engine ran with chosen-python/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
