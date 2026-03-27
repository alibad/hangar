import { NextResponse } from "next/server";

type ServiceConfig = {
  name: string;
  url: string;
  subdomain: string;
  category: "ai" | "monitoring" | "app";
  authRequired: boolean;
};

const services: ServiceConfig[] = [
  {
    name: "vLLM",
    url: `${process.env.LLM_BASE_URL}/models`,
    subdomain: "llm.betenshi.com",
    category: "ai",
    authRequired: true,
  },
  {
    name: "Open WebUI",
    url: "https://webui.betenshi.com",
    subdomain: "webui.betenshi.com",
    category: "app",
    authRequired: false,
  },
  {
    name: "Whisper STT",
    url: "https://whisper.betenshi.com/health",
    subdomain: "whisper.betenshi.com",
    category: "ai",
    authRequired: false,
  },
  {
    name: "Kokoro TTS",
    url: "https://tts.betenshi.com/health",
    subdomain: "tts.betenshi.com",
    category: "ai",
    authRequired: false,
  },
];

export async function GET() {
  const results = await Promise.all(
    services.map(async (service) => {
      const start = Date.now();
      try {
        const headers: Record<string, string> = {};
        if (service.authRequired) {
          headers["CF-Access-Client-Id"] = process.env.CF_ACCESS_CLIENT_ID!;
          headers["CF-Access-Client-Secret"] = process.env.CF_ACCESS_CLIENT_SECRET!;
        }
        const res = await fetch(service.url, {
          headers,
          signal: AbortSignal.timeout(10000),
        });
        const latency = Date.now() - start;
        return {
          name: service.name,
          subdomain: service.subdomain,
          category: service.category,
          status: res.ok ? ("up" as const) : ("down" as const),
          statusCode: res.status,
          latency,
        };
      } catch {
        return {
          name: service.name,
          subdomain: service.subdomain,
          category: service.category,
          status: "down" as const,
          statusCode: 0,
          latency: Date.now() - start,
        };
      }
    })
  );

  return NextResponse.json({
    services: results,
    timestamp: new Date().toISOString(),
    upCount: results.filter((s) => s.status === "up").length,
    totalCount: results.length,
  });
}
