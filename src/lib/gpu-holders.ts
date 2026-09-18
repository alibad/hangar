/**
 * A thing currently holding RAM or VRAM on this box, and enough to act on it.
 *
 * Shared by `GET /api/gpu/holders` and the UI that offers to free them, so the
 * two cannot drift on what `id` means — which matters here because it means
 * different things per kind, and unload rejects the wrong one.
 */
export type GpuHolder = {
  /** For "ollama-model" this is the ROUTER ALIAS, which is what unload wants. */
  id: string;
  kind: "ollama-model" | "image-service";
  label: string;
  detail: string;
  vramGb: number;
  ramGb: number;
};

/** Where a holder's Free button posts, and what it says while doing it. */
export function releaseRequest(h: GpuHolder): {
  url: string;
  body: Record<string, unknown>;
  verb: string;
  title: string;
} {
  if (h.kind === "ollama-model") {
    return {
      url: "/api/ollama/unload",
      body: { model: h.id },
      verb: "Unload",
      title: `Unload ${h.label} from Ollama. The runtime keeps running and the other models stay available.`,
    };
  }
  if (h.id === "comfyui") {
    return {
      url: "/api/comfyui/unload",
      body: {},
      verb: "Free weights",
      title: "Release ComfyUI's weights without stopping it. All four of its image models stay available.",
    };
  }
  return {
    url: `/api/services/${h.id}`,
    body: { action: "stop" },
    verb: "Stop",
    title: `Stop the ${h.label} and release everything it holds. It can be started again from Run setup.`,
  };
}
