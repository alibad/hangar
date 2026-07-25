import { NextRequest, NextResponse } from "next/server";
import { getServiceUrl, getServiceHeaders } from "@/lib/services";
import { saveImage } from "@/lib/save-image";

export const maxDuration = 800; // Next: allow long-running generations

// The Qwen server holds the HTTP connection open for the whole generation
// (seconds → minutes) and only sends headers once the PNG is ready. undici's
// default 300s headersTimeout would abort a slow/queued job with "fetch failed"
// while the server keeps working. Passing a per-request `dispatcher` to Next's
// wrapped global fetch is IGNORED, so instead install an unbounded dispatcher
// process-wide via setGlobalDispatcher (memoized).
let _unbounded = false;
async function ensureUnboundedTimeouts() {
  if (_unbounded) return;
  try {
    // @ts-expect-error undici is provided by the Node runtime; no local types
    const { Agent, setGlobalDispatcher } = await import("undici");
    setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0, connectTimeout: 10_000 }));
    _unbounded = true;
  } catch {
    /* undici unavailable — default fetch timeouts apply */
  }
}

async function qwenFetch(url: string, init: RequestInit): Promise<Response> {
  await ensureUnboundedTimeouts();
  return fetch(url, init);
}

export async function POST(req: NextRequest) {
  const start = Date.now();
  try {
    const body = await req.json();
    // Pin the seed ourselves so the result is reproducible and we can show it —
    // the server returns only PNG bytes and won't echo a random seed back.
    const seed =
      Number.isFinite(body.seed) && body.seed != null
        ? Math.floor(body.seed)
        : Math.floor(Math.random() * 2_147_483_647);

    const payload = {
      prompt: String(body.prompt ?? "").trim(),
      negative_prompt: body.negative_prompt || " ",
      width: Math.max(256, Math.floor(body.width ?? 1024)),
      height: Math.max(256, Math.floor(body.height ?? 1024)),
      steps: Math.max(1, Math.floor(body.steps ?? 28)),
      cfg: Number(body.cfg ?? 4.0),
      seed,
    };

    if (!payload.prompt) {
      return NextResponse.json({ error: "Prompt is required" }, { status: 400 });
    }

    const base = getServiceUrl("qwen");
    const res = await qwenFetch(`${base}/generate`, {
      method: "POST",
      headers: getServiceHeaders("qwen", { "Content-Type": "application/json", "X-Source": "console" }),
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return NextResponse.json(
        { error: `Qwen server returned ${res.status}`, detail: detail.slice(0, 500) },
        { status: 502 },
      );
    }

    const buf = Buffer.from(await res.arrayBuffer());
    const dataUrl = `data:image/png;base64,${buf.toString("base64")}`;
    const latency = Date.now() - start;
    const saved = await saveImage(buf, { kind: "generate", ...payload, latency });

    return NextResponse.json({
      status: "success",
      image: dataUrl,
      bytes: buf.length,
      latency,
      saved: saved?.file ?? null,
      savedPath: saved?.path ?? null,
      ...payload,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const cause = err instanceof Error && err.cause ? String(err.cause) : "";
    return NextResponse.json({ error: message, cause }, { status: 500 });
  }
}
