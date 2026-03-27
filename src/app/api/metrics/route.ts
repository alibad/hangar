import { NextResponse } from "next/server";
import { getServiceUrl, getServiceHeaders } from "@/lib/services";

export async function GET() {
  try {
    const baseUrl = getServiceUrl("vllm");
    const res = await fetch(`${baseUrl}/metrics`, {
      headers: getServiceHeaders("vllm"),
      signal: AbortSignal.timeout(10000),
    });

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

    return NextResponse.json({ metrics, raw_lines: lines.length });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
