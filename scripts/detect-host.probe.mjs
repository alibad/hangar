/**
 * What this script will accept as proof that a port really is a given service.
 *
 * Split out from detect-host.mjs for one reason: it must be testable without
 * binding a port. Several of the ports in this table are in use on any machine
 * that is actually running Hangar, so an integration test of this logic would
 * be least reliable exactly where it matters most.
 *
 * ── THE BUG THIS PREVENTS ───────────────────────────────────────────────────
 * On 2026-09-21 the detector reported `:4000 ai-router HTTP 200` on a Mac with
 * no AI Router installed. Another project's dev server held the port for a few
 * minutes; the detector saw the port number in its table, saw a 200, and would
 * have written the AI Router into a draft host profile.
 *
 * A wrong identification is worse than a missing one. A missing service is a
 * gap somebody fills; a wrong one is a service the console reports as DOWN
 * forever while its owner debugs software they never installed.
 */

/**
 * What a service's own answer has to look like before this script will believe
 * the thing on that port really is that service.
 *
 * `expects` is the cheap, general discriminator and it is the one that catches
 * the failure actually observed: a web app holding an API's port answers with
 * HTML, and no service in this table serves HTML from its health endpoint
 * except the two that are browser apps. `signature` is the strong check, and is
 * only written where the response shape is genuinely known — verified by
 * calling it on this machine, or fixed by a specification the service
 * implements. Where neither is true the entry says so with `expects: "json"`
 * alone, which is a weak claim honestly labelled rather than a guessed one.
 *
 * `verifyPath` exists for vLLM, whose /health is an empty 200 that proves
 * nothing. Its /v1/models is OpenAI-compatible, so the shape there is a spec
 * rather than a guess. The profile still records /health as the health path.
 */
export const KNOWN = [
  // signature verified by calling it on B5, 2026-09-21: an array of service
  // objects, each with an id and a status.
  { port: 8099, id: "manager",     name: "Service Manager",  healthPath: "/services",      category: "monitoring",
    expects: "json", signature: (j) => Array.isArray(j) && j.every((x) => x && typeof x.id === "string" && "status" in x) },
  // verified on B5: { models: [...] }
  { port: 11434, id: "ollama",     name: "Ollama",           healthPath: "/api/tags",      category: "ai", serves: { text: "" },
    expects: "json", signature: (j) => Array.isArray(j?.models) },
  // /health is an empty 200 and proves nothing; /v1/models is OpenAI-compatible,
  // so its shape is a specification rather than an assumption.
  { port: 8005, id: "vllm",        name: "vLLM",             healthPath: "/health",        category: "ai", serves: { text: "" },
    verifyPath: "/v1/models", expects: "json", signature: (j) => j?.object === "list" && Array.isArray(j?.data) },
  { port: 8006, id: "vllm-small",  name: "vLLM (small)",     healthPath: "/health",        category: "ai", serves: { text: "" },
    verifyPath: "/v1/models", expects: "json", signature: (j) => j?.object === "list" && Array.isArray(j?.data) },
  // These four are this project's own FastAPI services on the Windows box, and
  // their exact health payloads have not been read from here. `expects: json`
  // is therefore the whole check: weak, but it still rejects a web app on the
  // port, which is the failure that actually happened.
  { port: 8001, id: "whisper",     name: "Whisper STT",      healthPath: "/health",        category: "ai", serves: { stt: "whisper-1" }, expects: "json" },
  { port: 8002, id: "tts",         name: "Kokoro TTS",       healthPath: "/health",        category: "ai", serves: { tts: "kokoro" }, expects: "json" },
  { port: 8021, id: "qwen",        name: "Qwen-Image",       healthPath: "/health",        category: "ai", serves: { image: "qwen-image" },
    expects: "json", signature: (j) => typeof j?.ok === "boolean" || typeof j?.model === "string" },
  // The Mac toolkit adapter (scripts/local-ai-adapter.mjs). Shares the `qwen`
  // id with the line above because Image Studio routes that id through its
  // established generate/gallery/queue/edit paths; only one of the two ports
  // is ever bound on a given machine. Omitting it is what made the detector
  // report "2 of 14 known ports" on a box that was serving five capabilities.
  // verified on B5: { ok, model, capabilities: [...] }
  { port: 8111, id: "qwen",        name: "Local AI Toolkit", healthPath: "/health",        category: "ai", localOnly: true, serves: { image: "", stt: "", tts: "" },
    expects: "json", signature: (j) => j?.ok === true && Array.isArray(j?.capabilities) },
  { port: 8188, id: "comfyui",     name: "ComfyUI",          healthPath: "/system_stats",  category: "app",
    expects: "json", signature: (j) => !!j?.system || Array.isArray(j?.devices) },
  { port: 8009, id: "sam3d",       name: "SAM 3D Body",      healthPath: "/health",        category: "ai", expects: "json" },
  { port: 8010, id: "sam3",        name: "SAM 3",            healthPath: "/health",        category: "ai", expects: "json" },
  // The two browser apps. HTML from these is correct, so they opt out of the
  // shape check entirely rather than being given a fake one.
  { port: 3001, id: "webui",       name: "Open WebUI",       healthPath: "/",              category: "app", expects: "any" },
  { port: 3002, id: "grafana",     name: "Grafana",          healthPath: "/api/health",    category: "monitoring",
    expects: "json", signature: (j) => typeof j?.database === "string" || typeof j?.version === "string" },
  // Prometheus answers this one in plain text, by design.
  { port: 9090, id: "prometheus",  name: "Prometheus",       healthPath: "/-/healthy",     category: "monitoring",
    expects: "text", signature: (_j, text) => /healthy/i.test(text) },
  // LiteLLM answers with JSON — a bare string ("I'm alive!") or an object.
  // THIS is the entry that was wrongly matched by a Next.js dev server on the
  // same port; that server answers HTML, which `expects: "json"` now rejects.
  { port: 4000, id: "ai-router",   name: "AI Router",        healthPath: "/health/liveliness", category: "ai", localOnly: true, expects: "json" },
];

/**
 * Cap on how much of a health response is read.
 *
 * Generous on purpose. The first version of the shape check clipped to 8 KB
 * BEFORE parsing, which cut the service manager's 12.9 KB /services reply in
 * half, made JSON.parse fail, and reported the real manager as an impostor —
 * a confidently wrong answer from the very check that exists to prevent
 * confidently wrong answers. Parse the whole body; this exists only so a probe
 * never pulls a large page into memory, and a health endpoint that exceeds it
 * is itself a reason to distrust the port.
 */
export const MAX_PROBE_BYTES = 256 * 1024;

/**
 * Does this answer actually look like the declared service?
 *
 * Pure, and exported, so the rule can be tested without binding a port —
 * several of the ports in the table are in use on any machine running Hangar,
 * which makes an integration test of this unreliable in exactly the situations
 * it matters.
 *
 * Returns "identified", or a sentence naming what was wrong. A mismatch is
 * always reported rather than resolved: this script's job is to measure, and
 * "something else is here" is a measurement a person needs to see.
 */
export function classifyAnswer(svc, probe) {
  if (!probe) return { state: "silent" };

  const expects = svc.expects ?? "json";
  if (probe.oversized) {
    return { state: "mismatch", why: `it returned more than ${MAX_PROBE_BYTES / 1024} KB from a health endpoint` };
  }
  if (expects === "json" && probe.json === undefined) {
    const looksHtml = /^\s*<(!doctype|html)/i.test(probe.text);
    return {
      state: "mismatch",
      why: looksHtml
        ? "it answered with a web page, and this service speaks JSON"
        : "it answered with something that is not JSON, and this service speaks JSON",
    };
  }
  if (expects === "text" && /^\s*<(!doctype|html)/i.test(probe.text)) {
    return { state: "mismatch", why: "it answered with a web page" };
  }

  if (svc.signature) {
    let passed = false;
    try {
      passed = !!svc.signature(probe.json, probe.text);
    } catch {
      passed = false;
    }
    if (!passed) {
      return { state: "mismatch", why: `its reply does not have the shape ${svc.name} returns` };
    }
  }
  // No signature and a satisfied `expects` is a WEAK pass, and the report says
  // so rather than presenting it as the same thing as a verified one.
  return { state: "identified", weak: !svc.signature };
}
