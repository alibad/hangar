import { getServiceUrl } from "@/lib/services";

/**
 * What Ollama currently holds on the GPU, and how to make room.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Ollama does not behave like the other GPU services, and the resource
 * coordinator's model of "a workload allocates its peak on top of what is free"
 * is wrong for it in both directions.
 *
 * vLLM reserves its VRAM at startup and holds it. Qwen-Image and ComfyUI peak
 * during a run and idle near zero. Ollama does neither: it loads a model on the
 * first call and **keeps it resident** until `OLLAMA_KEEP_ALIVE` expires. So
 * between two Arena runs the card still holds ~24 GB, and the naive admission
 * check refuses the second run — it sees 7 GB free, wants 26 GB, and denies.
 * That is not a capacity problem; it is the same memory being counted twice.
 *
 * Worse, the refusal lands on exactly the workflow the Arena exists for: pick
 * three models, run them all. Model A loads and stays resident, model B is
 * denied admission, and the comparison never completes.
 *
 * Two facts resolve it, and both come from the runtime rather than from a guess:
 *
 *  1. **`OLLAMA_MAX_LOADED_MODELS=1`** (set in scripts/service-commands.json)
 *     means loading a different model *evicts* the current one. So the peak of
 *     the next model replaces the resident one rather than stacking on it — but
 *     only if the eviction happens BEFORE admission is checked, which is what
 *     `unloadOthers()` forces.
 *  2. **A model that is already resident needs no new allocation.** Its memory
 *     was admitted when it loaded and is still held. Asking for a second
 *     admission for the same bytes is what produced the false denial.
 *
 * Deliberately not solved by shrinking the configured footprint: 26 GB is what
 * the model actually costs, and lying about it in config/model-meta.json would
 * break every other consumer of that number — the fit calculator, the Models
 * page, and the image workloads that legitimately have to fit beside it.
 */

type PsModel = { name?: string; model?: string; size_vram?: number };

function ollamaUrl(): string {
  return getServiceUrl("ollama");
}

/** Models Ollama currently holds, with the VRAM each is using. */
export async function residentModels(): Promise<{ name: string; vramBytes: number }[]> {
  try {
    const res = await fetch(`${ollamaUrl()}/api/ps`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: PsModel[] };
    return (data.models ?? [])
      .map((m) => ({ name: m.name ?? m.model ?? "", vramBytes: m.size_vram ?? 0 }))
      .filter((m) => m.name);
  } catch {
    // Ollama being unreachable is not this function's problem to report — the
    // caller's own request will fail with a far more useful message.
    return [];
  }
}

/** Whether `model` is already loaded, and so needs no fresh admission. */
export async function isResident(model: string): Promise<boolean> {
  return (await residentModels()).some((m) => m.name === model);
}

/**
 * Ask Ollama to drop one model, and wait for the card to actually release it.
 *
 * The wait matters: `/api/chat` with `keep_alive: 0` returns as soon as Ollama
 * accepts the instruction, not when the allocator has freed the memory. An
 * admission check run immediately after would still see the old model's VRAM and
 * deny — the exact failure this exists to prevent, just moved later.
 *
 * Returns whether it is actually gone. Giving up after the deadline is correct
 * rather than throwing: the caller's next admission check will fail with the
 * coordinator's own message, which says what is still holding the card.
 */
export async function unloadOne(model: string): Promise<boolean> {
  await fetch(`${ollamaUrl()}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // keep_alive 0 with no messages is Ollama's documented unload request.
    body: JSON.stringify({ model, messages: [], keep_alive: 0 }),
    signal: AbortSignal.timeout(30_000),
  }).catch(() => undefined);

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (!(await isResident(model))) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** Evict every resident model except `keep`. Returns the names it dropped. */
export async function unloadOthers(keep?: string): Promise<string[]> {
  const doomed = (await residentModels()).map((m) => m.name).filter((n) => n !== keep);
  if (doomed.length === 0) return [];
  await Promise.all(doomed.map((name) => unloadOne(name)));
  return doomed;
}

/**
 * The Ollama model name behind a router alias.
 *
 * The router stores it as `openai/<name>` because Ollama is registered through
 * LiteLLM's OpenAI-compatible provider. Only the suffix is meaningful to Ollama
 * itself, and a tag containing a slash is not possible, so a single split is safe.
 */
export function ollamaModelFromTarget(target: string | undefined): string | null {
  if (!target) return null;
  const name = target.startsWith("openai/") ? target.slice("openai/".length) : target;
  return name.includes(":") ? name : null;
}
