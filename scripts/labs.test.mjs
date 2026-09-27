import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import {
  LABS,
  BUILTIN_TABS,
  validateLabs,
  isConsoleTab,
  labForTab,
  labTab,
  labDestinations,
} from "../src/lib/labs.ts";
import { CAPABILITY_IDS, CAPABILITY_LABELS, isCapabilityId } from "../src/lib/capabilities.ts";

/**
 * The Labs registry is what six parallel sessions each add one line to, and
 * what turns that line into a tab, a hash route and a command-palette entry.
 * A bad entry fails quietly in the browser — a tab that renders "No Lab is
 * registered", a doc panel that 404s, a Lab listing nothing because its
 * capability is misspelled — so the registry is checked here instead.
 *
 * Node strips the types and imports the very module the app does; `load` is a
 * dynamic import nothing evaluates, so React never loads.
 */

const root = new URL("../", import.meta.url);
const fromRoot = (rel) => new URL(rel, root);

const base = {
  id: "demo",
  label: "Demo Lab",
  hint: "h",
  keywords: "k",
  capability: "text",
  input: "prompt",
  output: "text",
  cloudComparison: false,
  load: () => Promise.resolve({ default: () => null }),
};

test("the registry as committed is valid", () => {
  assert.ok(LABS.length > 0, "at least one Lab is registered");
  assert.deepEqual(validateLabs(LABS, CAPABILITY_IDS), []);
});

test("every Lab's component file exists and has a default export", () => {
  for (const lab of LABS) {
    // The import specifier survives type-stripping in the function's source.
    const spec = lab.load.toString().match(/import\(\s*["']([^"']+)["']\s*\)/)?.[1];
    assert.ok(spec, `${lab.id}: load() must be () => import("@/components/labs/<file>")`);
    assert.ok(spec.startsWith("@/"), `${lab.id}: import "${spec}" should use the @/ alias`);
    const rel = `src/${spec.slice(2)}`;
    const file = [".tsx", ".ts"].map((ext) => rel + ext).find((p) => existsSync(fromRoot(p)));
    assert.ok(file, `${lab.id}: ${rel}.tsx does not exist`);
    assert.match(readFileSync(fromRoot(file), "utf8"), /export default/, `${lab.id}: ${file} has no default export`);
  }
});

test("every Lab's experiment doc exists", () => {
  for (const lab of LABS) {
    if (!lab.doc) continue;
    assert.ok(existsSync(fromRoot(lab.doc)), `${lab.id}: doc ${lab.doc} does not exist`);
  }
});

test("validateLabs names each structural problem", () => {
  const errs = (labs) => validateLabs(labs, CAPABILITY_IDS).join("\n");
  assert.match(errs([base, { ...base }]), /registered twice/);
  assert.match(errs([{ ...base, id: "Video Lab" }]), /lowercase slug/);
  assert.match(errs([{ ...base, capability: "musik" }]), /not in CAPABILITY_IDS/);
  assert.match(errs([{ ...base, label: " " }]), /no label/);
  assert.match(errs([{ ...base, doc: "README.md" }]), /directly under docs\//);
  assert.match(errs([{ ...base, doc: "docs/explorations/02-music.md" }]), /directly under docs\//);
  assert.match(errs([{ ...base, load: undefined }]), /no load/);
  assert.deepEqual(validateLabs([{ ...base, doc: "docs/music-experiment-2026-09-30.md" }], CAPABILITY_IDS), []);
});

test("compareCapability must be a known, different capability, and needs cloudComparison", () => {
  const errs = (labs) => validateLabs(labs, CAPABILITY_IDS).join("\n");
  const decision = { ...base, capability: "decision", cloudComparison: true };
  assert.deepEqual(validateLabs([{ ...decision, compareCapability: "text" }], CAPABILITY_IDS), []);
  assert.match(errs([{ ...decision, compareCapability: "txt" }]), /compares against capability "txt"/);
  assert.match(errs([{ ...decision, compareCapability: "decision" }]), /its own capability/);
  assert.match(errs([{ ...decision, compareCapability: "text", cloudComparison: false }]), /not cloudComparison/);
});

test("every capability a Lab may need is in the vocabulary, with a label", () => {
  for (const cap of ["text", "vision", "image", "stt", "tts", "music", "3d", "video", "decision"]) {
    assert.ok(isCapabilityId(cap), `${cap} is missing from CAPABILITY_IDS`);
    assert.ok(CAPABILITY_LABELS[cap], `${cap} has no label`);
  }
  assert.equal(isCapabilityId("sst"), false);
  assert.equal(isCapabilityId(undefined), false);
});

test("tabs: built-ins and registered Labs are valid, anything else is not", () => {
  for (const t of BUILTIN_TABS) assert.ok(isConsoleTab(t), t);
  for (const lab of LABS) assert.ok(isConsoleTab(labTab(lab.id)), labTab(lab.id));
  // A hash or a saved tab from a Lab that no longer exists must fall back to Home.
  assert.equal(isConsoleTab("lab-does-not-exist"), false);
  assert.equal(isConsoleTab("text"), false);
  assert.equal(isConsoleTab(""), false);
  assert.equal(isConsoleTab(null), false);
  assert.equal(isConsoleTab("lab-demo", [base]), true);
});

test("labForTab resolves only lab- tabs", () => {
  assert.equal(labForTab("lab-demo", [base])?.id, "demo");
  assert.equal(labForTab("demo", [base]), undefined);
  assert.equal(labForTab("stack", [base]), undefined);
});

test("destinations are one per Lab, prefixed, and searchable by capability", () => {
  const dests = labDestinations(LABS);
  assert.equal(dests.length, LABS.length);
  assert.equal(new Set(dests.map((d) => d.id)).size, dests.length);
  for (const [i, d] of dests.entries()) {
    assert.ok(d.id.startsWith("lab-"));
    assert.ok(!BUILTIN_TABS.includes(d.id), `${d.id} shadows a built-in tab`);
    assert.match(d.keywords, new RegExp(`\\b${LABS[i].capability}\\b`));
  }
});
