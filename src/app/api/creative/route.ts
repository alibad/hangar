import { NextRequest, NextResponse } from "next/server";

const COMFYUI_URL = "http://localhost:8188";

function buildFluxWorkflow(prompt: string, width: number, height: number, seed: number, steps: number) {
  return {
    "1": {
      class_type: "DualCLIPLoader",
      inputs: { clip_name1: "clip_l.safetensors", clip_name2: "t5xxl_fp16.safetensors", type: "flux" },
    },
    "2": {
      class_type: "CLIPTextEncode",
      inputs: { text: prompt, clip: ["1", 0] },
    },
    "3": {
      class_type: "EmptySD3LatentImage",
      inputs: { width, height, batch_size: 1 },
    },
    "4": {
      class_type: "UNETLoader",
      inputs: { unet_name: "flux1-schnell.safetensors", weight_dtype: "default" },
    },
    "5": {
      class_type: "BasicGuider",
      inputs: { model: ["4", 0], conditioning: ["2", 0] },
    },
    "6": {
      class_type: "RandomNoise",
      inputs: { noise_seed: seed },
    },
    "7": {
      class_type: "BasicScheduler",
      inputs: { model: ["4", 0], scheduler: "simple", steps, denoise: 1.0 },
    },
    "8": {
      class_type: "SamplerCustomAdvanced",
      inputs: {
        noise: ["6", 0],
        guider: ["5", 0],
        sampler: ["9", 0],
        sigmas: ["7", 0],
        latent_image: ["3", 0],
      },
    },
    "9": {
      class_type: "KSamplerSelect",
      inputs: { sampler_name: "euler" },
    },
    "10": {
      class_type: "VAELoader",
      inputs: { vae_name: "ae.safetensors" },
    },
    "11": {
      class_type: "VAEDecode",
      inputs: { samples: ["8", 0], vae: ["10", 0] },
    },
    "12": {
      class_type: "SaveImage",
      inputs: { filename_prefix: "betenshi", images: ["11", 0] },
    },
  };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      prompt = "A beautiful landscape",
      width = 1024,
      height = 768,
      seed = Math.floor(Math.random() * 2147483647),
      steps = 4,
    } = body;

    const workflow = buildFluxWorkflow(prompt, width, height, seed, steps);

    // Queue the prompt
    const queueRes = await fetch(`${COMFYUI_URL}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: workflow }),
    });

    if (!queueRes.ok) {
      const err = await queueRes.text();
      return NextResponse.json({ error: `ComfyUI queue error: ${err}` }, { status: 502 });
    }

    const { prompt_id } = await queueRes.json();

    // Poll for completion
    const startTime = Date.now();
    const timeout = 120000; // 2 minutes

    while (Date.now() - startTime < timeout) {
      await new Promise((r) => setTimeout(r, 1000));

      const histRes = await fetch(`${COMFYUI_URL}/history/${prompt_id}`);
      const history = await histRes.json();

      if (!history[prompt_id]) continue;

      const status = history[prompt_id].status?.status_str;

      if (status === "success") {
        const outputs = history[prompt_id].outputs;
        for (const nodeId of Object.keys(outputs)) {
          if (outputs[nodeId].images) {
            const img = outputs[nodeId].images[0];
            return NextResponse.json({
              status: "success",
              image: {
                filename: img.filename,
                subfolder: img.subfolder || "",
                type: img.type || "output",
              },
              prompt_id,
              latency: Date.now() - startTime,
              seed,
            });
          }
        }
      }

      if (status === "error") {
        const msgs = history[prompt_id].status?.messages || [];
        const errMsg = msgs.find((m: [string, Record<string, string>]) => m[0] === "execution_error");
        return NextResponse.json(
          { error: errMsg?.[1]?.exception_message || "Generation failed", prompt_id },
          { status: 500 },
        );
      }
    }

    return NextResponse.json({ error: "Generation timed out", prompt_id }, { status: 504 });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

// Serve generated images
export async function GET(req: NextRequest) {
  const filename = req.nextUrl.searchParams.get("filename");
  const subfolder = req.nextUrl.searchParams.get("subfolder") || "";
  const type = req.nextUrl.searchParams.get("type") || "output";

  if (!filename) {
    return NextResponse.json({ error: "filename required" }, { status: 400 });
  }

  try {
    const imgRes = await fetch(
      `${COMFYUI_URL}/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${encodeURIComponent(type)}`,
    );

    if (!imgRes.ok) {
      return NextResponse.json({ error: "Image not found" }, { status: 404 });
    }

    const buffer = await imgRes.arrayBuffer();
    return new NextResponse(buffer, {
      headers: {
        "Content-Type": imgRes.headers.get("Content-Type") || "image/png",
        "Cache-Control": "public, max-age=31536000",
      },
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
