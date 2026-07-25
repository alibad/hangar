export type ServiceEntry = {
  id: string;
  name: string;
  localPort: number;
  localUrl: string;
  publicUrl: string;
  healthPath: string;
  category: "ai" | "monitoring" | "app";
  authRequired: boolean;
};

export const SERVICE_REGISTRY: ServiceEntry[] = [
  {
    id: "vllm",
    name: "vLLM",
    localPort: 8000,
    localUrl: "http://localhost:8000",
    publicUrl: "https://llm.betenshi.com",
    healthPath: "/models",
    category: "ai",
    authRequired: true,
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
    id: "comfyui",
    name: "ComfyUI",
    localPort: 8188,
    localUrl: "http://localhost:8188",
    publicUrl: "https://comfyui.betenshi.com",
    healthPath: "/system_stats",
    category: "ai",
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
