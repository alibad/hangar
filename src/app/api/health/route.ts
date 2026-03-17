import { NextResponse } from "next/server";

const services = [
  {
    name: "vLLM",
    url: `${process.env.LLM_BASE_URL}/models`,
    subdomain: "llm.betenshi.com",
  },
];

export async function GET() {
  const results = await Promise.all(
    services.map(async (service) => {
      const start = Date.now();
      try {
        const res = await fetch(service.url, {
          headers: {
            "CF-Access-Client-Id": process.env.CF_ACCESS_CLIENT_ID!,
            "CF-Access-Client-Secret": process.env.CF_ACCESS_CLIENT_SECRET!,
          },
          signal: AbortSignal.timeout(10000),
        });
        const latency = Date.now() - start;
        return {
          name: service.name,
          subdomain: service.subdomain,
          status: res.ok ? "up" : "down",
          statusCode: res.status,
          latency,
        };
      } catch {
        return {
          name: service.name,
          subdomain: service.subdomain,
          status: "down",
          statusCode: 0,
          latency: Date.now() - start,
        };
      }
    })
  );

  return NextResponse.json({ services: results, timestamp: new Date().toISOString() });
}
