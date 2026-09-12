import assert from "node:assert/strict";
import test from "node:test";
import { qwenCheckpointState } from "../src/lib/qwen-checkpoint.ts";

const health = {
  up: true, model: "Qwen/Qwen-Image", loaded: true,
  edit: { enabled: true, model: "Qwen/Qwen-Image-Edit-2509", loaded: false },
};

test("Edit selects the edit checkpoint, not the loaded generation checkpoint", () => {
  const edit = qwenCheckpointState(true, health);
  assert.equal(edit.name, health.edit.model);
  assert.equal(edit.status, "Selected · not loaded");
  assert.equal(edit.loaded, false);
  assert.match(edit.note, /Run Edit loads/);
  assert.equal(qwenCheckpointState(false, health).status, "Loaded · ready to run");
});
test("an online service is not proof that either selected checkpoint is loaded", () => {
  assert.equal(qwenCheckpointState(false, { ...health, loaded: false }).status, "Selected · not loaded");
  assert.equal(qwenCheckpointState(true, health, true).status, "Loading checkpoint…");
  assert.equal(qwenCheckpointState(false, { ...health, loaded: false, load: { state: "loading" } }).status, "Loading checkpoint…");
});
test("offline health never reports stale loaded flags as ready", () => {
  const offline = { ...health, up: false, edit: { ...health.edit, loaded: true } };
  for (const editing of [false, true]) {
    const state = qwenCheckpointState(editing, offline);
    assert.equal(state.loaded, false);
    assert.equal(state.status, "Selected · service unavailable");
    assert.match(state.note, /Start it to use either checkpoint/);
  }
  assert.equal(qwenCheckpointState(true, null).status, "Checking service…");
  assert.equal(qwenCheckpointState(true, { up: false }).name, "Qwen-Image-Edit");
});
test("edit-only residency and disabled editing have distinct states", () => {
  const editOnly = { ...health, loaded: false, edit: { ...health.edit, loaded: true } };
  assert.equal(qwenCheckpointState(true, editOnly).status, "Loaded · ready to run");
  assert.equal(qwenCheckpointState(false, editOnly).status, "Selected · not loaded");
  assert.equal(qwenCheckpointState(true, { ...health, edit: { ...health.edit, enabled: false } }).status, "Editing disabled on service");
  assert.equal(qwenCheckpointState(true, { up: true }).status, "Edit availability unknown");
});
test("a failed generation load does not read as ready", () => {
  assert.equal(qwenCheckpointState(false, { ...health, loaded: false, load: { state: "error" } }).status, "Checkpoint load failed");
});
