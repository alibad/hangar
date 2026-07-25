import { NextRequest, NextResponse } from "next/server";
import { getServiceUrl, getServiceHeaders } from "@/lib/services";
import { saveImage } from "@/lib/save-image";

export const maxDuration = 800;

// Same long-job rationale as the generate route: install an unbounded undici
// dispatcher process-wide so slow generations aren't killed at the default 300s.
let _unbounded = false;
async function qwenFetch(url: string, init: RequestInit): Promise<Response> {
  if (!_unbounded) {
    try {
      // @ts-expect-error undici is provided by the Node runtime; no local types
      const { Agent, setGlobalDispatcher } = await import("undici");
      setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0, connectTimeout: 10_000 }));
      _unbounded = true;
    } catch {
      /* undici unavailable — default fetch timeouts apply */
    }
  }
  return fetch(url, init);
}

// Image-edit is wired end-to-end but the Qwen-Image-Edit (~20B) model isn't
// installed/served yet. Until it is, the server answers /edit with 501 (or, on
// an older server build, the route simply 404s). Either way we return a tidy
// `enabled:false` so the UI can show the "not installed yet" panel instead of a
// scary error. When the model is enabled server-side, this route starts
// returning real images with zero client changes.
function notInstalled(detail?: string) {
  return NextResponse.json(
    {
      enabled: false,
      error: "edit_not_enabled",
      message:
        "Qwen-Image-Edit isn't installed on the server yet. Enable it in " +
        "quote-forge/server/qwen_image.py (set QWEN_EDIT_ENABLED=1, then restart " +
        "the server — it downloads Qwen-Image-Edit-2509 on first use).",
      detail: detail?.slice(0, 500),
    },
    { status: 200 },
  );
}

export async function POST(req: NextRequest) {
  const start = Date.now();
  try {
    const body = await req.json();
    const images: string[] = Array.isArray(body.images) ? body.images : [];
    const prompt = String(body.prompt ?? "").trim();

    if (!prompt) {
      return NextResponse.json({ error: "An edit instruction is required" }, { status: 400 });
    }
    if (images.length === 0) {
      return NextResponse.json({ error: "At least one input image is required" }, { status: 400 });
    }

    const seed =
      Number.isFinite(body.seed) && body.seed != null
        ? Math.floor(body.seed)
        : Math.floor(Math.random() * 2_147_483_647);

    const payload = {
      prompt,
      images, // base64 data URLs; server strips the prefix
      negative_prompt: body.negative_prompt || " ",
      steps: Math.max(1, Math.floor(body.steps ?? 28)),
      cfg: Number(body.cfg ?? 4.0),
      seed,
    };

    const base = getServiceUrl("qwen");
    let res: Response;
    try {
      res = await qwenFetch(`${base}/edit`, {
        method: "POST",
        headers: getServiceHeaders("qwen", { "Content-Type": "application/json", "X-Source": "console" }),
        body: JSON.stringify(payload),
      });
    } catch (err) {
      // Server unreachable — distinct from "edit disabled".
      return NextResponse.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 502 },
      );
    }

    // Older server build without the /edit route, or edit explicitly disabled.
    if (res.status === 404 || res.status === 501) {
      const detail = await res.text().catch(() => "");
      return notInstalled(detail);
    }

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
    const saved = await saveImage(buf, {
      kind: "edit",
      prompt,
      seed,
      steps: payload.steps,
      cfg: payload.cfg,
      inputCount: images.length,
      latency,
    });

    return NextResponse.json({
      status: "success",
      enabled: true,
      image: dataUrl,
      bytes: buf.length,
      latency,
      inputCount: images.length,
      prompt,
      seed,
      steps: payload.steps,
      cfg: payload.cfg,
      saved: saved?.file ?? null,
      savedPath: saved?.path ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
