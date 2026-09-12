# Image model experiment — 12 September 2026

## Recommendation

Use **FLUX.2 Klein 4B** as the practical starting point for local generation and editing. Keep **Z-Image Turbo** as a fast alternative and **HiDream-O1 Dev FP8** for richer native-2K experiments. All three actually ran on this RTX 5090; these are not just catalogue entries.

This machine has 31.84 GiB usable GPU memory and 63.27 GiB system RAM. A model's parameter count alone does not determine whether it fits: text encoders, precision, activation memory, cached weights, and other processes matter.

## Measured results

One product photograph, one cut-paper illustration; identical prompts and seed 20260912 across models. Model-native step counts, 1024² for Klein/Z-Image and 2048² for HiDream. Times are console request-to-saved-result, not denoising-only. Downloads are excluded. These are individual runs, not averages or a controlled benchmark; filesystem cache and shared encoder reuse affect cold-start time.

| Model | Product photograph | Illustration | Sampled whole-card VRAM during illustration |
| --- | ---: | ---: | ---: |
| FLUX.2 Klein 4B, BF16 denoiser + mixed-FP8 encoder, 4 steps | 7.3 s | 6.2 s | 16,390 MiB |
| Z-Image Turbo, NVFP4 denoiser + mixed-FP8 encoder, 8 steps | 14.2 s | 10.2 s | 14,074 MiB |
| HiDream-O1 Dev, unified FP8 checkpoint, 28 steps, 2048² | 13.3 s | 18.3 s | 15,653 MiB |

VRAM samples were taken every 500 ms with nvidia-smi. They include desktop/other apps and may miss short peaks; they are **not** model-only allocations. RAM profiles remain admission estimates, not freshly measured process peaks.

- **Klein:** correct MORNING LIGHT text and requested object arrangement. Gallery-based editing changed the blue mug to red while closely preserving geometry, lemon, card lettering, lighting and camera view. Edit took **6.1 s**, initiated from the UI. Illustration matched the paper style but produced two stars, not three.
- **Z-Image:** correct text and arrangement, convincing ceramic texture. Strong simple paper styling; also two stars instead of three.
- **HiDream:** attractive, detailed native-2K results. It embellished the product scene with a window, books, a plant and steam despite the request for a neutral background without extra objects. Illustration was expressive and showed the fox actively steering, but included many stars despite the exact-count instruction. A good alternative, not the most literal model on these two prompts.

All outputs are in **Image Studio → Create → Studio Verification**, with model names and times on the cards, and also in **Activity → Generation History**. The gallery picker was used for the Klein edit; no upload was required. Z-Image generation and Klein editing both visibly completed in the UI and saved to the selected gallery. External service-generated images appeared through visible-page gallery refreshing. Activity model filters showed two Z-Image, two HiDream, and three Klein results before the final environment check.

After restarting Docker, a fresh vLLM Small startup occupied enough VRAM to block Klein (only 9.83 GiB free). Stopping **only vLLM Small**, while retaining Docker and its other apps, allowed another Klein generation in **8.2 s**. This does not prove vLLM caused the earlier 84-second Qwen result; that earlier attribution was not established.

## What did not pass

- Existing native **Qwen-Image** startup was rejected by its 28-GiB RAM estimate plus 4-GiB safety margin, with 28.94 GiB available. No fresh Qwen output is claimed in this experiment.
- Existing **FLUX.1 schnell BF16** request was rejected by its legacy ~28-GiB RAM / ~31.7-GiB VRAM profile. That VRAM profile was based on earlier whole-card measurement and needs a separate streaming-aware calibration. A rejection is not proof the hardware cannot run it.
- Qwen-Image-2512's cache is **incomplete**: only three of nine transformer shards were present. The configured native service still targets the original Qwen-Image and Edit-2509. No silent upgrade to an incomplete checkpoint was made.
- Paid cloud models were researched but not called. No new subscriptions, credentials or cloud charges were introduced.

## Current model landscape

The live [Artificial Analysis text-to-image leaderboard](https://artificialanalysis.ai/image/leaderboard/text-to-image) currently places GPT Image 2.5 Flare/Sunburst and GPT Image 2 at the top, followed by MAI-Image-2.6, Reve 2.1 and Nano Banana 2. These are broader human-preference results, not promises about a particular prompt. It also lists newer Qwen-Image-3.0 variants and HiDream-O1-Image-1.5; those are **not** the downloadable checkpoints tested here. Ideogram 4.0 and FLUX.2 dev are higher-ranked open-weight candidates on that board, but were not installed or tested in this bounded experiment.

For this box:

- [FLUX.2 Klein 4B](https://huggingface.co/black-forest-labs/FLUX.2-klein-4B) is a compact four-step generation/editing model, Apache-2.0, with an official ~13-GB VRAM claim. It is distinct from FLUX.2 dev/max and the larger Klein 9B. The smaller choice was deliberate.
- [HiDream-O1](https://huggingface.co/HiDream-ai/HiDream-O1-Image) supplies downloadable unified image weights. We tested Comfy-Org's Dev FP8 checkpoint with no separate prompt-refining LLM. Dev is exposed as generation-only here; this is not a verified HiDream editing integration, not Dev-2604, and not the leaderboard's newer 1.5 service.
- [Z-Image Turbo](https://huggingface.co/Tongyi-MAI/Z-Image-Turbo) is a 6B few-step model. Existing local quantized weights and the existing Qwen3-4B encoder were reused.
- [Qwen-Image-2512](https://huggingface.co/Qwen/Qwen-Image-2512) and [Qwen-Image-Edit-2511](https://huggingface.co/Qwen/Qwen-Image-Edit-2511) remain the latest generation/edit weight releases found in Qwen's official Hugging Face image-model listing during this check. The existence of newer cloud names does not mean Qwen stopped publishing open weights.

## Integration and storage

- Reused existing ComfyUI; no extra model server or new custom-node package.
- Added three selectable models with native workflows, separate capability flags and per-model memory estimates. Klein uses the same checkpoint for Generate/Edit. HiDream defaults to native 2048².
- New generation and Klein editing use the console's normal save/index path, plus source-tagged Activity mirroring. Selected output galleries are respected.
- Finished ComfyUI runs request weight/cache release when its queue is idle. They do not interrupt unrelated queued/running workflows. An accepted ComfyUI request is collected and saved even if its browser stops waiting.
- Activity refreshes only while visible; gallery refreshes while visible and on focus. Activity timestamp sorting handles native local-time and console UTC metadata consistently.
- Corrected `.gitignore`: unanchored `archive/` had accidentally excluded the Activity API source directory. It now ignores only the root image-history storage directory.
- Approximately **16.15 GB decimal / 15.05 GiB** newly downloaded: Klein 7,751,105,712 bytes; HiDream 8,067,535,296 bytes; FLUX.2 VAE 336,213,556 bytes. All on D:, with same-volume hardlinks into the Comfy model directory, not duplicate copies. No existing models/images were deleted.
- Download revisions: Klein `e7b7dc27f91deacad38e78976d1f2b499d76a294`; HiDream repack `de544d7b47e9b22aee77d1a56da0457dfe8d4449`; FLUX.2 VAE `ab9055628ea245000e610f2aa2c96f4746093546`.
- New model IDs work through `/api/image/generate`; Klein editing through `/api/image/edit`. They are console-local capabilities, **not newly added AI Router aliases**. Existing router configuration and cloud callers are unchanged.

Final verified service state: ComfyUI and AI Router available; Qwen and vLLM Small stopped; Docker Desktop, Open WebUI, LobeChat, Prometheus and Grafana restored. Other user applications untouched. Both image queue and resource leases empty. Approximately 23 GiB RAM and 28.4 GiB VRAM free at handoff. To switch back to local chat, manage vLLM Small from Services; check free memory before loading another image model.

Reproduce the illustration sweep with `node scripts/experiment-images.mjs` from the console repository. It only accepts registered local models, uses the normal API, saves to Studio Verification and writes measured metadata under `var/experiments/`. TypeScript checks and all 41 console tests passed, plus two CPU-only Qwen backend tests. Tests cover graph wiring, workload registration, gallery persistence, cancellation/transport cleanup, checkpoint status and resource admission.
