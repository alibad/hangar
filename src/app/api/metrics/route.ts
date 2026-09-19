import { NextResponse } from "next/server";
import { getServiceUrl, getServiceHeaders } from "@/lib/services";
import { getHost } from "@/lib/host";

/**
 * Prometheus counters from whichever local service publishes them.
 *
 * This used to call getServiceUrl("vllm") outright. On any host without a
 * service literally named `vllm` that throws "Unknown service", which was
 * returned as a 502 — so every page load on a machine running Ollama took a
 * failed request, and the console logged a Bad Gateway for a service that was
 * never meant to exist there.
 *
 * A host now declares `metricsPath` on services that publish counters. No such
 * service is an ordinary, expected answer — 200 with `available: false` — not
 * an error. The UI already renders that case properly.
 */
export async function GET() {
  const svc = getHost().services.find((s) => s.metricsPath);

  if (!svc) {
    return NextResponse.json({
      metrics: {},
      available: false,
      reason: "No service on this host publishes Prometheus counters.",
    });
  }

  try {
    const baseUrl = getServiceUrl(svc.id);
    const res = await fetch(`${baseUrl}${svc.metricsPath}`, {
      headers: getServiceHeaders(svc.id),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      // The service exists and is not answering — still not a gateway failure
      // of this route. Say which service and what it said.
      return NextResponse.json({
        metrics: {},
        available: false,
        source: svc.id,
        reason: `${svc.name} returned HTTP ${res.status}.`,
      });
    }

    const text = await res.text();

    const metrics: Record<string, number> = {};
    const lines = text.split("\n").filter((l) => !l.startsWith("#") && l.trim());
    for (const line of lines) {
      const match = line.match(/^(\S+?)(?:\{[^}]*\})?\s+([\d.eE+-]+)/);
      if (match) {
        const key = match[1];
        const val = parseFloat(match[2]);
        if (
          key.includes("request") ||
          key.includes("token") ||
          key.includes("time_to_first_token") ||
          key.includes("e2e_request_latency") ||
          key.includes("num_requests") ||
          key.includes("gpu") ||
          key.includes("cache") ||
          key.includes("running") ||
          key.includes("waiting") ||
          key.includes("generation")
        ) {
          if (!metrics[key] || val > metrics[key]) {
            metrics[key] = val;
          }
        }
      }
    }

    return NextResponse.json({ metrics, available: true, source: svc.id, raw_lines: lines.length });
  } catch (err) {
    // A service that is simply not running is the common case, not an incident.
    return NextResponse.json({
      metrics: {},
      available: false,
      source: svc.id,
      reason: `${svc.name} is not reachable: ${String(err)}`,
    });
  }
}
