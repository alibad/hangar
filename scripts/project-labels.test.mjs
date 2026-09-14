import assert from "node:assert/strict";
import test from "node:test";
import { projectLabels } from "../src/lib/assistant-usage-data.ts";

test("projectLabels: a unique folder name stays short", () => {
  const labels = projectLabels([
    "C:/Code/hq/games",
    "C:/Code/AI/betenshi-console",
  ]);
  assert.equal(labels.get("C:/Code/hq/games"), "games");
  assert.equal(labels.get("C:/Code/AI/betenshi-console"), "betenshi-console");
});

test("projectLabels: colliding names grow leftwards only as far as needed", () => {
  const labels = projectLabels([
    "C:/runs/2026-09-04-export-fidelity/shots",
    "C:/runs/2026-09-05-media-fallback/shots",
    "C:/Code/hq/games",
  ]);
  assert.equal(
    labels.get("C:/runs/2026-09-04-export-fidelity/shots"),
    "2026-09-04-export-fidelity/shots",
  );
  assert.equal(
    labels.get("C:/runs/2026-09-05-media-fallback/shots"),
    "2026-09-05-media-fallback/shots",
  );
  assert.equal(labels.get("C:/Code/hq/games"), "games");
});

test("projectLabels: identical tails separate at the drive", () => {
  const labels = projectLabels(["C:/a/OpenRA", "D:/a/OpenRA"]);
  assert.equal(labels.get("C:/a/OpenRA"), "C:/a/OpenRA");
  assert.equal(labels.get("D:/a/OpenRA"), "D:/a/OpenRA");
});

test("projectLabels: backslash paths and trailing separators normalise", () => {
  const windows = "C:\\Code\\hq\\games\\";
  const labels = projectLabels([windows, "C:/Code/hq/quote-forge"]);
  assert.equal(labels.get(windows), "games");
  assert.equal(labels.get("C:/Code/hq/quote-forge"), "quote-forge");
});

test("projectLabels: a placeholder project survives unchanged", () => {
  const labels = projectLabels(["(unknown)", "C:/Code/hq/games"]);
  assert.equal(labels.get("(unknown)"), "(unknown)");
});

test("projectLabels: nesting does not loop when one path contains another", () => {
  const labels = projectLabels(["C:/hq", "C:/hq/games", "C:/other/hq"]);
  assert.equal(labels.get("C:/hq"), "C:/hq");
  assert.equal(labels.get("C:/other/hq"), "other/hq");
  assert.equal(labels.get("C:/hq/games"), "games");
});

test("projectLabels: every label is unique across a realistic set", () => {
  const paths = [
    "C:/Code/hq/globe_quest",
    "C:/Code/hq/games",
    "C:/Code/hq",
    "C:/Code/hq/quote-forge",
    "C:/Code",
    "C:/Code/AI/betenshi-console",
    "C:/Code/hq/move-quest",
    "C:/Code/hq/runs/2026-08-28-move-prevalence/shots",
    "C:/Code/hq/runs/2026-08-29-deploy-truth/shots",
    "C:/Code/hq/worktrees/OpenRA",
    "C:/Code/games/OpenRA",
  ];
  const labels = projectLabels(paths);
  assert.equal(labels.size, paths.length);
  assert.equal(new Set(labels.values()).size, paths.length);
  for (const path of paths) assert.ok(labels.get(path));
});
