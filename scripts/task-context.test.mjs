import test from "node:test";
import assert from "node:assert/strict";
import { taskContext, taskDraft, taskPrompt } from "../src/lib/task-context.ts";

const project = { name: "Example", meaning: { purpose: "A useful app", next: "Fix the empty state" }, sites: [{ role: "canonical", branch: "main", dirty: 2, ahead: 1 }] };
test("new tasks carry recorded next steps and explicit historical context", () => {
  const context = taskContext(project, [{ id: "s1", provider: "codex", title: "Empty state", updatedAt: "2026-10-24", summary: "Investigated the empty state", archived: false }]);
  assert.match(context, /2 changed files/);
  assert.match(context, /Investigated the empty state/);
  assert.match(context, /not proof/);
  assert.match(taskDraft(project), /Fix the empty state/);
  assert.match(taskPrompt(context, "My chosen task"), /User task \(authoritative\):\nMy chosen task$/);
});
test("no next step means review first; continuation does not pretend a new session has history", () => {
  assert.match(taskDraft({ ...project, meaning: {} }), /before changing code/);
  assert.match(taskDraft(project, { id: "existing" }), /Continue this session/);
  assert.doesNotMatch(taskContext(project, [{ archived: true, summary: "Archived private text" }]), /Archived private text/);
});
