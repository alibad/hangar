/**
 * What actually runs a capability on this machine, and whether it has been
 * proven to work.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * Until 2026-09-21 the console answered "can this box make an image?" by
 * checking whether a service called `qwen` was listening. That is three
 * separate assumptions stacked on one port check:
 *
 *   1. that something is bound          — a port answers
 *   2. that it is the thing we expect   — the health path returns our shape
 *   3. that it WORKS                    — nobody ever checked
 *
 * Step 3 is where four days of pure static went unnoticed. A `runtime` is the
 * place those three become separate, visible facts: which engine, on which
 * service, and when its output was last inspected and found to be real.
 *
 * ── WHY NOT JUST A SERVICE ──────────────────────────────────────────────────
 * `services` says what is INSTALLED and listening. A runtime says what is
 * DRIVING a capability, and the two are not one-to-one:
 *
 *   - one service, many capabilities: B5's Local AI Toolkit adapter serves
 *     image, video, stt, tts and embeddings from one process
 *   - one capability, many possible drivers: the same FLUX.2 Klein weights are
 *     reachable through the Draw Things CLI, the Draw Things app's own server,
 *     or mflux — and on this machine only some of those work
 *
 * Encoding the driver in code is what produced `APPLE_HOST`, `isMacHost` and
 * `getHostId() === "b5"` scattered across four components. A machine's engine
 * choice belongs in that machine's profile, like everything else that differs
 * between boxes.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 * `verifiedAt` is written ONLY by `scripts/doctor.mjs`, and only after it ran
 * a real job and inspected the OUTPUT. Nothing else may set it, and no UI may
 * infer "ready" from a health check alone. An unverified runtime is shown as
 * unverified — it is not hidden, and it is not claimed to work.
 */

import { getHost } from "./host";

/** Capability ids a runtime can drive. Same vocabulary as `serves`. */
export type RuntimeCapability = "text" | "vision" | "image" | "video" | "stt" | "tts" | "embedding";

/**
 * The engines this console knows how to drive.
 *
 * Adding one is a driver implementation plus a case in the doctor — not a
 * branch in a component. `null` is legitimate and means the capability is
 * declared but has no engine here yet.
 */
export type RuntimeDriver =
  /** Ollama's OpenAI-compatible surface. Text, vision and embeddings, every OS. */
  | "ollama"
  /** vLLM. NVIDIA hosts. */
  | "vllm"
  /** ComfyUI graphs, built by hand in lib/flux.ts. NVIDIA hosts. */
  | "comfyui"
  /** The native Qwen-Image service on BeTenshi. */
  | "qwen-native"
  /**
   * Draw Things' standalone CLI, via the LocalAI wrapper.
   *
   * BROKEN on macOS 27 as of 2026-09-21: both the pinned July build and the
   * current 26.0910.1 ship Metal 4 cooperative-tensor shaders
   * (`matmul2d_descriptor`, `execution_simdgroups`) that this machine's Metal
   * compiler rejects. The July build fails SILENTLY, returning a valid PNG of
   * pure static; the newer one at least crashes with the shader error. Kept as
   * a driver because the same binary works on other macOS versions, and the
   * doctor is what decides whether it works HERE.
   */
  | "draw-things-cli"
  /** The Draw Things GUI app's own local server. Known-good on B5; needs the server switched on in the app. */
  | "draw-things-app"
  /** mflux — FLUX.2 on Apple MLX. Pure Python, no GUI app, headless-friendly. */
  | "mflux"
  /** mlx-audio, via the LocalAI wrapper. Apple silicon speech in and out. */
  | "mlx-audio"
  /** Whisper / Kokoro / Chatterbox HTTP services. NVIDIA hosts. */
  | "whisper"
  | "kokoro";

export type RuntimeEntry = {
  /** Which engine. null = declared but nothing drives it here yet. */
  driver: RuntimeDriver | null;
  /** What to ask the engine for — a checkpoint filename, an Ollama tag, a repo id. */
  model: string;
  /** Human name for the card and the pre-flight panel. */
  label?: string;
  /** The service that must be up. Must name a service in this profile. */
  serviceId?: string;
  /**
   * When `scripts/doctor.mjs` last ran a real job through this runtime AND
   * inspected the output. Absent means never proven — which is NOT the same as
   * broken, and the UI must say so in those words.
   */
  verifiedAt?: string;
  /** What the doctor saw, for the tooltip: "512² in 4.1 s, smooth 71%". */
  verifiedNote?: string;
  /**
   * True when the BACKEND writes its own Activity archive entry, so the console
   * must not write a second one.
   *
   * Only BeTenshi's native Qwen-Image service does. Inferring this from a
   * service id (`target === "comfyui"`) is what left `archive/` permanently
   * empty on every other host, and with it the Activity tab that promises
   * "every image this box generates".
   */
  mirrorsToArchive?: boolean;
  /** Why this driver, or what is known to be wrong with it. Documentation only. */
  note?: string;
};

export type RuntimeStatus =
  /** Declared, and the doctor has seen real output from it. */
  | "verified"
  /** Declared with a driver, never proven. Offer it, say it is unproven. */
  | "unverified"
  /** Declared with no driver at all — the machine knows it cannot do this yet. */
  | "unconfigured"
  /** Not declared on this host. */
  | "absent";

/** Every runtime this host declares. */
export function getRuntimes(): Partial<Record<RuntimeCapability, RuntimeEntry>> {
  const raw = (getHost() as unknown as { runtimes?: Record<string, RuntimeEntry> }).runtimes ?? {};
  const out: Partial<Record<RuntimeCapability, RuntimeEntry>> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith("_")) continue; // `_doc` keys are for humans
    out[k as RuntimeCapability] = v;
  }
  return out;
}

export function getRuntime(capability: RuntimeCapability): RuntimeEntry | null {
  return getRuntimes()[capability] ?? null;
}

/**
 * The four-way answer, which is the whole point of this module.
 *
 * Callers must not collapse this to a boolean. "Not on this machine",
 * "installed but never proven" and "proven to work" are three different
 * sentences to show a user, and the middle one is the one that was missing.
 */
export function runtimeStatus(capability: RuntimeCapability): RuntimeStatus {
  const rt = getRuntime(capability);
  if (!rt) return "absent";
  if (!rt.driver) return "unconfigured";
  return rt.verifiedAt ? "verified" : "unverified";
}

/** Has this capability's output actually been inspected on this machine? */
export function isRuntimeVerified(capability: RuntimeCapability): boolean {
  return runtimeStatus(capability) === "verified";
}

/**
 * One sentence about where a capability stands, for a card or a tooltip.
 *
 * Written here rather than in each component so the three states are phrased
 * consistently everywhere — the audit found the Models page saying "Router
 * offline" while the LLM tab, on the same host, correctly said "no router on
 * this machine".
 */
export function runtimeSummary(capability: RuntimeCapability): string {
  const rt = getRuntime(capability);
  const name = CAPABILITY_NOUN[capability] ?? capability;
  switch (runtimeStatus(capability)) {
    case "verified":
      return `${rt!.label ?? rt!.model} — checked ${describeWhen(rt!.verifiedAt!)}${rt!.verifiedNote ? ` (${rt!.verifiedNote})` : ""}.`;
    case "unverified":
      return `${rt!.label ?? rt!.model} is installed but its output has never been checked on this machine. Run \`node scripts/doctor.mjs ${capability}\` to prove it works.`;
    case "unconfigured":
      return `This machine has no ${name} engine set up yet.`;
    default:
      return `${name} is not configured on this machine.`;
  }
}

const CAPABILITY_NOUN: Partial<Record<RuntimeCapability, string>> = {
  text: "text",
  vision: "vision",
  image: "image generation",
  video: "video generation",
  stt: "speech-to-text",
  tts: "text-to-speech",
  embedding: "embeddings",
};

/** "today", "3 days ago" — a date alone reads as trivia, staleness is the point. */
function describeWhen(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "at an unknown time";
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return new Date(then).toISOString().slice(0, 10);
}

/**
 * Does a runtime's output need re-checking?
 *
 * An OS upgrade broke image generation here between one day and the next, and
 * a `verifiedAt` from before it would have gone on asserting the capability
 * worked. Thirty days is not a guarantee — it is a prompt to re-run the doctor
 * before trusting a badge that predates anything the user has since changed.
 */
export function isVerificationStale(capability: RuntimeCapability, maxAgeDays = 30): boolean {
  const rt = getRuntime(capability);
  if (!rt?.verifiedAt) return false;
  const then = Date.parse(rt.verifiedAt);
  return Number.isFinite(then) && Date.now() - then > maxAgeDays * 86_400_000;
}
