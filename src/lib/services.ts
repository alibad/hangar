export type ServiceEntry = {
  id: string;
  name: string;
  localPort: number;
  localUrl: string;
  publicUrl: string;
  healthPath: string;
  category: "ai" | "monitoring" | "app";
  authRequired: boolean;
  /**
   * Never leaves this box. `getServiceUrl()` returns `localUrl` for these even
   * when running on Vercel, so a deployed build physically cannot route to it.
   * Set for the AI Router: cloud projects must call vendor APIs directly and
   * must never be pointed at a local gateway.
   */
  localOnly?: boolean;
  /** Present on OpenAI-compatible LLM services — `model` is the served-model-name
   *  to send in /v1/chat/completions. Marks a service as selectable in the LLM picker. */
  llm?: { model: string };
};

export const SERVICE_REGISTRY: ServiceEntry[] = [
  {
    // The supervisor every other Start/Stop button goes through — when this is
    // down the console reports "Manager error: fetch failed" on every service and
    // nothing can be started, so it needs to be visible rather than invisible
    // infrastructure. Owned by the "BeTenshi Manager" scheduled task: fires at
    // logon and auto-restarts within a minute if the process dies, which also
    // makes a stray Stop on this card self-healing.
    id: "manager",
    name: "Service Manager",
    localPort: 8099,
    localUrl: "http://localhost:8099",
    publicUrl: "https://manager.betenshi.com",
    healthPath: "/services",
    category: "monitoring",
    authRequired: false,
  },
  {
    id: "vllm",
    name: "vLLM (Qwen3-Coder 30B)",
    localPort: 8005,
    localUrl: "http://localhost:8005",
    publicUrl: "https://llm.betenshi.com",
    healthPath: "/health",
    category: "ai",
    authRequired: true,
    llm: { model: "qwen3-coder" },
  },
  {
    id: "vllm-small",
    name: "vLLM (Qwen2.5-7B)",
    localPort: 8006,
    localUrl: "http://localhost:8006",
    publicUrl: "https://llm-small.betenshi.com",
    healthPath: "/health",
    category: "ai",
    authRequired: false,
    llm: { model: "qwen-small" },
  },
  {
    id: "whisper",
    name: "Whisper STT",
    localPort: 8001,
    localUrl: "http://localhost:8001",
    publicUrl: "https://whisper.betenshi.com",
    healthPath: "/health",
    category: "ai",
    authRequired: false,
  },
  {
    id: "tts",
    name: "Kokoro TTS",
    localPort: 8002,
    localUrl: "http://localhost:8002",
    publicUrl: "https://tts.betenshi.com",
    healthPath: "/health",
    category: "ai",
    authRequired: false,
  },
  {
    id: "webui",
    name: "Open WebUI",
    localPort: 3001,
    localUrl: "http://localhost:3001",
    publicUrl: "https://webui.betenshi.com",
    healthPath: "/",
    category: "app",
    authRequired: false,
  },
  {
    id: "grafana",
    name: "Grafana",
    localPort: 3002,
    localUrl: "http://localhost:3002",
    publicUrl: "https://grafana.betenshi.com",
    healthPath: "/api/health",
    category: "monitoring",
    authRequired: false,
  },
  {
    id: "prometheus",
    name: "Prometheus",
    localPort: 9090,
    localUrl: "http://localhost:9090",
    publicUrl: "https://prometheus.betenshi.com",
    healthPath: "/-/healthy",
    category: "monitoring",
    authRequired: false,
  },
  {
    // Local 20B Qwen-Image diffusion model (RTX 5090, fp8). Text→image today;
    // image-edit (Qwen-Image-Edit) is wired in the console but gated server-side.
    // server: hq/quote-forge/server/qwen_image.py — POST /generate, POST /edit, GET /health
    id: "qwen",
    name: "Qwen-Image",
    localPort: 8021,
    localUrl: "http://localhost:8021",
    publicUrl: "https://qwen.betenshi.com",
    healthPath: "/health",
    category: "ai",
    authRequired: false,
  },
  {
    // Categorised as an APP, not an AI backend: it's a browser workflow UI you
    // open and drive by hand (its card CTA is "Open ↗", like Open WebUI), rather
    // than a headless model server other code calls. It does use the GPU, but
    // that's shown per-card as VRAM instead of being a category.
    id: "comfyui",
    name: "ComfyUI",
    localPort: 8188,
    localUrl: "http://localhost:8188",
    publicUrl: "https://comfyui.betenshi.com",
    healthPath: "/system_stats",
    category: "app",
    authRequired: false,
  },
  {
    // Meta SAM 3D Body — single-image full-body 3D human mesh + pose recovery.
    // Resident FastAPI service (move-quest: services/sam3d/server.py).
    // POST /pose {image, bbox?} -> 70-joint 3D skeleton + global rotation
    // (+ optional body mesh); correct on floor/inverted/acro poses.
    id: "sam3d",
    name: "SAM 3D Body",
    localPort: 8009,
    localUrl: "http://localhost:8009",
    publicUrl: "https://sam3d.betenshi.com",
    healthPath: "/health",
    category: "ai",
    authRequired: false,
  },
  {
    // Meta SAM 3 — open-vocabulary promptable concept segmentation. Give it an
    // image + a text concept ("person", "car") and it segments every matching
    // instance (masks + boxes + scores). Resident FastAPI service
    // (move-quest: services/sam3/server.py). POST /segment {image, concepts}.
    id: "sam3",
    name: "SAM 3",
    localPort: 8010,
    localUrl: "http://localhost:8010",
    publicUrl: "https://sam3.betenshi.com",
    healthPath: "/health",
    category: "ai",
    authRequired: false,
  },
  {
    // AI Router — a LiteLLM proxy giving one OpenAI-compatible endpoint for
    // every model this box can reach: local (vLLM, Qwen-Image) and cloud
    // (OpenAI, Gemini, Anthropic). Model aliases live in config/ai-router.yaml,
    // which is the ONLY place vendor model ids are written.
    //   POST /v1/chat/completions      — text
    //   POST /v1/images/generations    — images
    //
    // localOnly: bound to 127.0.0.1 with no tunnel hostname. It serves systems
    // that use this box's local resources (console, quote-forge, move-quest).
    // Cloud projects must NOT route through it.
    id: "ai-router",
    name: "AI Router",
    localPort: 4000,
    localUrl: "http://127.0.0.1:4000",
    publicUrl: "http://127.0.0.1:4000", // intentionally not a public hostname
    healthPath: "/health/liveliness",
    category: "ai",
    authRequired: false,
    localOnly: true,
  },
];

/**
 * Server-side: detect if we're running locally (not on Vercel).
 * On Vercel, VERCEL=1 is set. Locally, it's absent.
 */
export function isLocalServer(): boolean {
  return !process.env.VERCEL;
}

/**
 * Get the base URL for a service, choosing local or public based on environment.
 */
export function getServiceUrl(id: string): string {
  const svc = SERVICE_REGISTRY.find((s) => s.id === id);
  if (!svc) throw new Error(`Unknown service: ${id}`);
  // localOnly services have no off-box address by design — never hand out a
  // public one, even from a deployed build.
  if (svc.localOnly) return svc.localUrl;
  return isLocalServer() ? svc.localUrl : svc.publicUrl;
}

/**
 * Whether CF Access headers are needed for a service in current environment.
 * Locally we go direct — no CF Access needed.
 */
export function needsCfAuth(id: string): boolean {
  const svc = SERVICE_REGISTRY.find((s) => s.id === id);
  if (!svc) return false;
  return svc.authRequired && !isLocalServer();
}

/**
 * Build headers for a service request, adding CF Access if needed.
 */
export function getServiceHeaders(id: string, extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  if (needsCfAuth(id)) {
    headers["CF-Access-Client-Id"] = process.env.CF_ACCESS_CLIENT_ID!;
    headers["CF-Access-Client-Secret"] = process.env.CF_ACCESS_CLIENT_SECRET!;
  }
  return headers;
}
