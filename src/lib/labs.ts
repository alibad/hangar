import type { ComponentType } from "react";
import type { CapabilityId } from "./capabilities";

/**
 * The Labs registry: one declarative entry per capability the console lets you
 * experiment with.
 *
 * The console's tabs were a hardcoded union in command-palette.tsx, a second
 * copy in page.tsx's hash validation, a third in the header menus, and a chain
 * of `tab === "…"` conditionals. Six explorations were about to each add a tab,
 * which meant six sessions editing page.tsx at once. A Lab is now a component
 * file plus one entry below; the tab, the hash route, the command palette and
 * the Workstreams menu all read from here.
 *
 * Kept free of runtime imports — only `import type`, which Node strips — so
 * scripts/labs.test.mjs can load the very module the app does. `load` is a
 * dynamic import that nothing evaluates until the Lab is opened, so the test
 * never pulls React in, and each Lab is its own chunk.
 *
 * How to add one: docs/labs.md.
 */

/** What a Lab's input is, so the palette and docs can describe it uniformly. */
export type LabInputKind = "prompt" | "image+prompt" | "audio" | "image" | "structured";

/** What its output renders as. */
export type LabOutputKind = "text" | "image" | "audio" | "mesh" | "video" | "json";

/** Props every Lab component receives. The shell does the rest. */
export type LabComponentProps = { lab: LabDefinition };

export type LabDefinition = {
  /** Slug. The tab is `lab-<id>`, and runs are recorded under this id. */
  id: string;
  /** Tab and menu label. */
  label: string;
  /** One line under the label in menus. */
  hint: string;
  /** Extra words the command palette matches on. */
  keywords: string;
  /**
   * The capability whose models this Lab lists. Resolved against the router
   * catalogue AND against host-profile services that declare it in `serves`,
   * so the same Lab on another machine shows that machine's models.
   */
  capability: CapabilityId;
  input: LabInputKind;
  output: LabOutputKind;
  /**
   * Whether a cloud model can run the same input for comparison. False for
   * capabilities with no cloud counterpart wired into the router.
   */
  cloudComparison: boolean;
  /**
   * The experiment write-up, repo-relative (e.g. "docs/foo-experiment-….md").
   * Rendered inside the Lab so the page says what was learned, not only what
   * is installed. Omit until the experiment has a doc.
   */
  doc?: string;
  /** The Lab's component. Must default-export a ComponentType<LabComponentProps>. */
  load: () => Promise<{ default: ComponentType<LabComponentProps> }>;
};

export const LABS: LabDefinition[] = [
  {
    id: "text",
    label: "Text Lab",
    hint: "One prompt, a local model, a cloud one beside it",
    keywords: "llm chat text lab experiment local cloud compare latency seed",
    capability: "text",
    input: "prompt",
    output: "text",
    cloudComparison: true,
    doc: "docs/arabic-model-experiment-2026-09-14.md",
    load: () => import("@/components/labs/text-lab"),
  },
  {
    id: "image",
    label: "Image Lab",
    hint: "One prompt across local and cloud image models, plus the fixed evaluation suite side by side",
    keywords: "image picture generate diffusion flux klein hidream z-image qwen gpt-image compare eval suite",
    capability: "image",
    input: "prompt",
    output: "image",
    cloudComparison: true,
    doc: "docs/image-model-experiment-2026-09-26.md",
    load: () => import("@/components/labs/image-lab"),
  },
  {
    id: "process",
    label: "Process Lab",
    hint: "A simulated relocation agency: BPMN processes and DMN rules on a real engine, with a decision model and an LLM at the judgement steps",
    keywords: "process bpmn dmn workflow business rules operaton camunda simulation case inbox human task relocation visa agency",
    capability: "process",
    input: "structured",
    output: "json",
    // Each AI step in the lab already runs local first and records its own
    // cloud fallback; there is no separate cloud column to compare.
    cloudComparison: false,
    doc: "docs/process-lab-2026-09-27.md",
    load: () => import("@/components/labs/process-lab"),
  },
];

// ── tabs ────────────────────────────────────────────────────────────────────

/** Every tab that is not a Lab. Order is irrelevant; membership is the point. */
export const BUILTIN_TABS = [
  "stack",
  "services",
  "storage",
  "llm",
  "arena",
  "speech",
  "qwen",
  "requests",
  "usage",
  "sam3d",
  "sam3",
  "models",
] as const;

export type BuiltinTab = (typeof BUILTIN_TABS)[number];
export type LabTab = `lab-${string}`;
export type ConsoleTab = BuiltinTab | LabTab;

export function labTab(id: string): LabTab {
  return `lab-${id}`;
}

export function labForTab(tab: string, labs: LabDefinition[] = LABS): LabDefinition | undefined {
  return tab.startsWith("lab-") ? labs.find((l) => labTab(l.id) === tab) : undefined;
}

/** For the URL hash and localStorage, which can hold anything. */
export function isConsoleTab(value: unknown, labs: LabDefinition[] = LABS): value is ConsoleTab {
  if (typeof value !== "string") return false;
  return (BUILTIN_TABS as readonly string[]).includes(value) || !!labForTab(value, labs);
}

/** A command-palette / menu destination, icon chosen by the caller. */
export function labDestinations(labs: LabDefinition[] = LABS) {
  return labs.map((l) => ({
    id: labTab(l.id),
    label: l.label,
    hint: l.hint,
    keywords: `lab ${l.capability} ${l.keywords}`,
  }));
}

/**
 * Structural problems with a registry, as readable sentences. Empty is valid.
 * Takes the capability vocabulary as an argument so it stays import-free.
 */
export function validateLabs(labs: LabDefinition[], capabilityIds: readonly string[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const lab of labs) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(lab.id)) errors.push(`Lab id "${lab.id}" must be a lowercase slug.`);
    if (seen.has(lab.id)) errors.push(`Lab id "${lab.id}" is registered twice.`);
    seen.add(lab.id);
    if (!capabilityIds.includes(lab.capability)) {
      errors.push(`Lab "${lab.id}" draws on capability "${lab.capability}", which is not in CAPABILITY_IDS.`);
    }
    if (!lab.label.trim()) errors.push(`Lab "${lab.id}" has no label.`);
    if (lab.doc !== undefined && !/^docs\/[\w.-]+\.md$/.test(lab.doc)) {
      // Directly under docs/ — the only place /api/labs/doc will read from.
      errors.push(`Lab "${lab.id}" doc "${lab.doc}" must be a .md file directly under docs/.`);
    }
    if (typeof lab.load !== "function") errors.push(`Lab "${lab.id}" has no load().`);
  }
  return errors;
}
