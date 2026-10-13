/**
 * Types and fetch helpers for the Process Lab. The shapes are the process lab
 * service's (C:\Users\Admin\Code\AI\process-lab\src\server.mjs), reached through
 * /api/labs/process/*.
 */

export const BASE = "/api/labs/process";

export async function lab<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${BASE}/${path}`, { cache: "no-store", ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j as T;
}

export const fileUrl = (url: string) => `${BASE}${url}`;

export type DependencyStatus = { id: string; name: string; role: string; onHost: boolean; up: boolean | null };
export type LabStatus = { lab: { id: string; name: string } | null; services: DependencyStatus[] };

export type Run = {
  id: string;
  status: string;
  note: string | null;
  started_at: number;
  finished_at: number | null;
  active: boolean;
  error: string | null;
  config: { scenarios: string[]; secondsPerDay: number; autoHuman: boolean };
};

export type Overview = {
  engine: { up: boolean; version?: string; error?: string };
  engineUi: { cockpit: string; tasklist: string };
  definitions: { id: string; key: string; name: string; version: number }[];
  decisions: { id: string; key: string; name: string; version: number; resource: string }[];
  counts: { activeCases?: number; openTasks?: number; incidents?: number; finishedCases?: number };
  workers: { running: boolean; processed: number; failed: number; lastError: string | null; busy: { topic: string; activityId: string; caseKey: string; since: number }[] };
  ai: { models: { local: string; localVision: string; cloud: string }; whenLocalUnavailable: string; classifyThreshold: number; readThreshold: number };
  runs: Run[];
  /** The pretend clients, described for someone choosing one to try. */
  scenarios: { id: string; label: string; name: string; from: string | null; to: string | null; group: string; teaser: string; expected: string }[];
  scenarioGroups: { id: string; label: string; about: string }[];
  firstTry: string[];
};

/** Who a case is about and where it stands, in words (from the lab's story.mjs). */
export type Tone = "working" | "you" | "person" | "done" | "closed" | "bad";
export type People = { name: string; firstName: string; from: string | null; to: string | null; want: string | null; language: string | null };
export type Plain = People & {
  status: { text: string; short: string; tone: Tone; needsPerson: string | null };
  /** Who does the human tasks on this case: you at the console, or the simulation's pretend consultant. */
  by: "you" | "consultant";
  expected: string | null;
};

export type CaseRow = {
  caseKey: string;
  processInstanceId: string;
  definitionId: string;
  state: string;
  startTime: string;
  endTime: string | null;
  ageDays: number;
  current: string[];
  incidents: number;
  clientName?: string;
  service?: string | null;
  destination?: string;
  eligibility?: string | null;
  outcome: string | null;
  scenario: string | null;
  label: string | null;
  simRunId: string | null;
  plain: Plain;
};

export type DecisionKind = "dmn" | "decision-model" | "llm" | "human" | "system";

export type Decision = {
  id?: number;
  kind: DecisionKind;
  activityId: string | null;
  question: string;
  decided: string;
  confidence: number | null;
  latencyMs: number | null;
  model?: string | null;
  provider: string | null;
  costUsd?: number | null;
  escalated?: boolean;
  overridden?: boolean;
  correct?: boolean | null;
  reviewsDecisionId?: number | null;
  inputs?: Record<string, unknown>;
  rootDecisionInstanceId?: string | null;
  detail?: { attempts?: { model: string; provider?: string; ok: boolean; why?: string | null }[]; summary?: string; fallback?: boolean } & Record<string, unknown>;
  at: string;
};

export type StageState = "done" | "current" | "todo" | "skipped";
export type Stage = { id: string; label: string; about: string; state: StageState };
export type StoryEntry = {
  at: string;
  day: number;
  stage: string | null;
  activityId: string;
  /** client | rules | ai | person | agency | authority | wait | end */
  kind: string;
  /** For "person" entries: you, or the pretend consultant. */
  by?: "you" | "consultant";
  /** For anyone: names and plain verbs. **bold** marks the key words. */
  text: string;
  /** For whoever asks how it was decided: model, confidence, rule table. */
  how?: string | null;
  active?: boolean;
  needsPerson?: string | null;
  flag?: string | null;
  quote?: string | null;
  email?: { subject: string; body: string; language: string | null } | null;
  docUrl?: string | null;
};
export type Now = { text: string; needsPerson: string | null; tone: Tone };
/** Plain-language help for every step, from the BPMN file's own documentation. */
export type Guide = {
  stages: { id: string; label: string; about: string }[];
  steps: Record<string, { id: string; type: string; name: string | null; doc: string | null; kind: string | null; stage: string | null }>;
};

export type CaseDetail = CaseRow & {
  now: Now;
  stages: Stage[];
  story: StoryEntry[];
  people: People;
  by: "you" | "consultant";
  variables: Record<string, unknown>;
  truth: Record<string, unknown> | null;
  activities: { id: string; name: string | null; type: string; start: string; end: string | null; ms: number | null; canceled: boolean }[];
  decisions: Decision[];
  emails: { id: number; purpose: string; language: string; subject: string; body: string; created_at: number }[];
  documents: { id: number; round: number; url: string; extraction: Record<string, unknown> | null; accepted: number | null; problem: string | null }[];
  artifacts: { id: number; kind: string; url: string; detail: Record<string, unknown> | null }[];
  incidents: { activityId: string; message: string; type: string; time: string }[];
  tasks: { id: string; key: string; name: string; created: string }[];
};

export type InboxItem = {
  id: string;
  key: "confirm_type" | "verify_documents" | "approve_submission";
  name: string;
  created: string;
  caseKey: string;
  simulated: boolean;
  client: { name: string; language: string; passport: string; destination: string; request: string };
  people: People;
  labels?: { services: Record<string, string>; purposes: Record<string, string> };
  ai?: { service?: string; purpose?: string | null; confidence?: number; probabilities?: Record<string, number> | null; model?: string; recommendation?: string; summary?: string; reasons?: string[] };
  choices?: { services: string[]; purposes: string[] };
  eligibility?: { outcome: string; reason: string; route: string | null };
  documents?: { id: number; url: string; extraction?: Record<string, unknown> | null; accepted: boolean; problem: string | null; flagged?: boolean; type?: string }[];
  docTypes?: Record<string, string>;
};

export type Stats = {
  run: { id: string; status: string; config: { secondsPerDay: number } } | null;
  secondsPerDay: number;
  cases: number;
  finished: number;
  active: number;
  outcomes: Record<string, number>;
  pathAccuracy: { right: number; of: number; pct: number } | null;
  cycle: { meanDays: number | null; medianDays: number | null; maxDays: number | null; slaMet: { met: number; of: number; pct: number } | null };
  waits: { activityId: string; name: string; type: string; count: number; totalMs: number; meanSeconds: number; meanDays: number; share: number }[];
  byKind: Record<string, { count: number; medianLatencyMs: number | null; meanConfidence: number | null; accuracy: number | null; scored: number; escalated: number; overridden: number; local: number; cloud: number; stub: number; costUsd: number }>;
  escalation: { aiDecisions: number; escalated: number; pct: number | null };
  decisionModel: { answered: number; handedToLlm: number; pct: number | null };
  overrides: { humanReviews: number; overrides: number; pct: number | null };
  models: { calls: number; cloudFallbacks: number; costUsd: number };
  reading: { fields: number; right: number; pct: number; documents: number } | null;
};

/** The builder's tags for kinds of decision (diagram, decision table), in the same words as the story. */
export const KIND_STYLE: Record<DecisionKind, { label: string; cls: string; hex: string }> = {
  dmn: { label: "Rules", cls: "", hex: "#38bdf8" },
  "decision-model": { label: "Decision model", cls: "", hex: "#a78bfa" },
  llm: { label: "AI", cls: "", hex: "#f59e0b" },
  human: { label: "Person", cls: "", hex: "#34d399" },
  system: { label: "Agency", cls: "", hex: "#a8a29e" },
};

/** Who or what acted, in words for someone who doesn't know the jargon. Colours are fixed hex, not theme classes: the theme remaps several families. */
export const ACTOR: Record<string, { label: string; hex: string; explain: string }> = {
  client: { label: "Client", hex: "#d6d3d1", explain: "Something the client did: wrote in, sent documents." },
  rules: { label: "Rules", hex: "#38bdf8", explain: "Written rules: the same facts always give the same answer (prices, documents, who qualifies)." },
  ai: { label: "AI", hex: "#f59e0b", explain: "AI that reads and writes: works out what the client wants, reads documents, writes emails and a brief." },
  person: { label: "Person", hex: "#34d399", explain: "A person: steps in when the AI isn't sure, and approves every application." },
  agency: { label: "Agency", hex: "#a8a29e", explain: "The agency's own steps: sending the application, alerting a manager." },
  authority: { label: "Authority", hex: "#c084fc", explain: "The government office that says yes or no (simulated here)." },
  wait: { label: "Waiting", hex: "#78716c", explain: "Time passing: for the client to reply, or for the authority." },
  end: { label: "Outcome", hex: "#fb923c", explain: "How the case ended." },
};

export function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

/** Local calls are not metered; "$0" would read as "free", which is a different claim. */
export function fmtCost(usd: number | null | undefined, provider?: string | null): string {
  if (provider === "cloud") return usd == null ? "cost n/a" : usd < 0.01 ? `$${usd.toFixed(5)}` : `$${usd.toFixed(3)}`;
  return "—";
}
