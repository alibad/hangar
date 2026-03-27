import { NextRequest, NextResponse } from "next/server";
import { getServiceUrl, getServiceHeaders } from "@/lib/services";

export async function POST(req: NextRequest) {
  const { message } = await req.json();
  const baseUrl = getServiceUrl("vllm");

  const start = Date.now();
  try {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: getServiceHeaders("vllm", { "Content-Type": "application/json" }),
      body: JSON.stringify({
        model: process.env.LLM_MODEL,
        messages: [{ role: "user", content: message }],
        max_tokens: 1024,
      }),
    });

    const data = await res.json();
    const latency = Date.now() - start;

    if (!res.ok) {
      return NextResponse.json({ error: data }, { status: res.status });
    }

    return NextResponse.json({
      content: data.choices[0].message.content,
      usage: data.usage,
      latency,
      model: data.model,
    });
  } catch (err) {
    return NextResponse.json(
      { error: String(err), latency: Date.now() - start },
      { status: 502 }
    );
  }
}
