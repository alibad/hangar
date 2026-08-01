import fs from "node:fs";
import path from "node:path";
import { SERVICE_REGISTRY, getServiceUrl, getServiceHeaders, type ServiceEntry } from "@/lib/services";

// Which LLMs can be picked as "active" — any registry service tagged with `llm`.
export function getLlmServices(): ServiceEntry[] {
  return SERVICE_REGISTRY.filter((s) => s.llm);
}

// The active choice is persisted on disk so it survives restarts and is shared by
// every server route (env can't change at runtime). Falls back to the smallest /
// first LLM if unset or invalid.
const ACTIVE_FILE = path.join(process.cwd(), "generated", "active-llm.json");
const DEFAULT_LLM = "vllm-small";

export function getActiveLlmId(): string {
  const llms = getLlmServices();
  const valid = new Set(llms.map((s) => s.id));
  try {
    const raw = fs.readFileSync(ACTIVE_FILE, "utf8");
    const id = JSON.parse(raw)?.id;
    if (typeof id === "string" && valid.has(id)) return id;
  } catch {
    /* not set yet */
  }
  return valid.has(DEFAULT_LLM) ? DEFAULT_LLM : llms[0]?.id ?? DEFAULT_LLM;
}

export function setActiveLlmId(id: string): { ok: true } | { error: string } {
  const valid = new Set(getLlmServices().map((s) => s.id));
  if (!valid.has(id)) return { error: `Unknown LLM service: ${id}` };
  try {
    fs.mkdirSync(path.dirname(ACTIVE_FILE), { recursive: true });
    fs.writeFileSync(ACTIVE_FILE, JSON.stringify({ id }, null, 2));
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export interface ActiveLlm {
  id: string;
  name: string;
  baseUrl: string; // OpenAI-compatible base, e.g. http://localhost:8006
  model: string; // served-model-name for the chat/completions body
  headers: Record<string, string>;
}

// Resolve the active LLM to everything a route needs to call /v1/chat/completions.
// Env overrides still win (QWEN_LLM_URL/QWEN_LLM_MODEL) for one-off setups.
export function getActiveLlm(): ActiveLlm {
  const id = getActiveLlmId();
  const svc = SERVICE_REGISTRY.find((s) => s.id === id);
  const baseUrl = process.env.QWEN_LLM_URL || (svc ? getServiceUrl(id) : "http://localhost:8006");
  const model = process.env.QWEN_LLM_MODEL || svc?.llm?.model || "qwen-small";
  return {
    id,
    name: svc?.name ?? id,
    baseUrl,
    model,
    headers: getServiceHeaders(id, { "Content-Type": "application/json" }),
  };
}
