import { NextResponse } from "next/server";

export async function GET() {
  try {
    const res = await fetch(`${process.env.LLM_BASE_URL?.replace("/v1", "")}/metrics`, {
      headers: {
        "CF-Access-Client-Id": process.env.CF_ACCESS_CLIENT_ID!,
        "CF-Access-Client-Secret": process.env.CF_ACCESS_CLIENT_SECRET!,
      },
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
