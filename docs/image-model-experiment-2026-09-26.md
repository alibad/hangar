# Image model experiment — 26–27 September 2026

_Continues [the 12 September smoke test](image-model-experiment-2026-09-12.md)._

## Recommendation

<!-- RECOMMENDATION -->

## How to look at the results

- **Image Lab** (`#lab-image`, also Ctrl K → "Image Lab"). The top half runs one prompt on a local model with an optional cloud model beside it. Every run is recorded in `lab_runs`. The bottom half is the evaluation suite: every model side by side, per prompt and seed.
- **Image Studio → Eval** shows the same suite view.
- ✓/✗ records **your** verdict on each objective check; ★ records your taste pick. Verdicts are saved to `experiments/image-eval/verdicts/<run>.json`, so they can be committed with the run.
- **The suite:** `experiments/image-eval/suite.json`. It has 12 prompts × 2 seeds, three edits, a cloud subset and a 2K subset. Each prompt is split into objective checks and taste.
- **The runner** is `scripts/experiment-image-suite.mjs`, with modes `generate`, `cloud`, `edits`, `resolution`, `warm`, `footprint`, `coresidency` and `sheets`. It is resumable. It writes `experiments/image-eval/runs/<run>.json` and waits out the resource coordinator rather than failing. It takes `AI/logs/gpu-claim.txt` first (the protocol the parallel exploration sessions agreed on) and waits for another session's claim to clear.
- **Contact sheets** (every model in a row, captioned with latency) are in `generated/Image Eval/2026-09-26/sheets/`.

## Where each model wins

Each check below is one a person answers yes/no without taste: is the word
spelled right, are there five apples. **These readings are mine,** taken from
the contact sheets to write this summary. They are not stored as your verdicts.
The Eval tab exists so you can confirm or overturn them.
Taste (which image is nicer) is deliberately not scored here.

"2/2" means both seeds pass. gpt-image-2 ran one seed (hosted APIs ignore seeds).

| Prompt → check | Klein 4B | Z-Image Turbo | HiDream-O1 Dev (1024²) | <!-- QWEN-COL --> | gpt-image-2 |
| --- | --- | --- | --- | --- | --- |
| Sign: both lines spelled exactly | 1/2 ("HARBORt STAKERY") | **2/2** | 1/2 ("FRESH BRAD") | <!-- q --> | 1/1 |
| Poster: headline, digits, one circle | 1/2 (s2 letters overlap) | **2/2** | text 2/2, but s2 has a second circle and s1 is a mock-up on a wall | <!-- q --> | — |
| Exactly 5 apples + 2 pears | 0/2 (4 + 1) | 0/2 (4 + 2) | 0/2 (4 + 2) | <!-- q --> | **1/1** |
| 5 spatial relations (on top / left / behind / in front) | 2/2 | 2/2 | 2/2 | <!-- q --> | — |
| Exactly four people | 1/2 (five in s2) | **2/2** | 2/2 (plus background patrons) | <!-- q --> | — |
| Exactly three stars (cut-paper fox) | 0/2 (two) | **2/2** | 0/2 (many) | <!-- q --> | — |
| Watercolour: style held | 2/2 | 2/2 | **0/2 — rendered as photographs** | <!-- q --> | — |
| Watercolour: exactly two lemons | 1/2 | 1/2 | 2/2 | <!-- q --> | — |
| Long prompt: bookshelf with exactly three shelves (the check most often missed; the other six checks passed nearly everywhere) | 2/2 | 0/2 | 0/2 | <!-- q --> | 1/1 |
| Arabic-language prompt followed (market, lanterns, red keffiyeh, silver pot) | scene 2/2; red turban, not keffiyeh | scene 2/2; red fez | **0/2 — ignored: a woman walking down a street** | <!-- q --> | **1/1, keffiyeh right** |
| Arabic text renders مرحبا | 0/2 (ثالھ, تمصمان) | **2/2** | 0/2 (pseudo-script; "WEECONE") | <!-- q --> | **1/1** |
| Hands | left for you to judge; HiDream s1 has a third hand at the frame edge | | | | |

What that adds up to:

- **Z-Image Turbo is the most literal local model.** It is the only one that:
  - spelled every sign and poster;
  - kept exactly three stars;
  - put exactly four people at the table;
  - rendered Arabic correctly.
- **Nobody local can count to five apples.** The cloud model did.
- **HiDream-O1 Dev does not read Arabic prompts.** Both seeds produced an unrelated scene. Its text encoder is Qwen3-VL-based, so this is surprising, but it held on both seeds. It also pulls illustration prompts towards photographs, and embellishes scenes (seen on 12 September too).
- **Klein is fast and strong at layout and editing, weak at counting and Arabic.** Its long-prompt layout was the most literal of the local models.
- Everything handled the 3D spatial-relations prompt.

## Editing

The same source image (Klein, seed 20260926: blue mug, tulips, red notebook)
goes to every edit model. Look in the Eval tab → Edit.

| Edit | FLUX.2 Klein 4B | <!-- QWEN-EDIT-COL --> |
| --- | --- | --- |
| Replace the mug with a potted cactus | **Clean.** Cactus in place; vase, tulips, notebook and light unchanged. 20.9 s | <!-- qe1 --> |
| Warm low sunset light | Lighting right (low, warm, long shadows). Also recoloured the tulips orange and darkened and reshaped the mug. 17.4 s | <!-- qe2 --> |
| Extend canvas 512 px right, add a bowl of green apples | **Seamless.** Original region preserved, table and wall continue, bowl added. 1536×1024 in 14.9 s | <!-- qe3 --> |

The canvas extension was instruction-only: the new area was grey padding, with
no mask. Neither console path takes a mask today.

## Resolution: is HiDream's native 2K better than 1K upscaled?

Three prompts (fisherman photo, Swiss poster, watercolour), seed 20260926. Each
model has three variants:

- HiDream at native 2048².
- Klein, Z-Image and Qwen generated directly at 2048².
- Each model's own 1024² image upscaled 2× with Lanczos, the free option (~0.2 s).

**Objective detail measure.** Mean absolute Laplacian of the luminance at
2048², i.e. high-frequency energy. An upscale has almost none by construction;
a real 2K render has what the model drew. Higher means more fine detail.

| Prompt | Klein 2K direct | Z-Image 2K direct | HiDream 2K native | 1K + Lanczos (Klein / Z / HiDream) |
| --- | ---: | ---: | ---: | ---: |
| Fisherman (photo) | **11.8** | 10.7 | 5.0 | 3.3 / 3.8 / 2.4 |
| Watercolour | failed¹ | **9.3** | 4.5 | 2.8 / 2.9 / 2.1 |
| Poster (flat design, little texture by design) | 1.6 | **4.5** | 3.1 | 1.2 / 1.5 / 2.1 |

¹ ComfyUI raised `HostBuffer.read_file_slice failed` while loading weights. Host
RAM was down to ~5.5 GB free because of other sessions; the coordinator had
refused the same run for RAM 30 s earlier.

**Time for a 2048² image** (console request to saved PNG, cold-ish):

| Model | Seconds | Compared with its 1024² time |
| --- | --- | --- |
| HiDream native | 16–23 | about 1.5× |
| Klein direct | 13.5–25 | |
| Z-Image direct | 32–38 | about 3× |

VRAM for 2K was not separable from the other sessions' SAM/TripoSR servers on
the card at the time (whole-card peaks of 25–27 GiB).

**Answer.**
- **Better than a Lanczos upscale:** yes, HiDream's 2K has roughly twice an upscale's detail.
- **Better than asking Klein or Z-Image for 2K directly:** no. It has about half their fine detail, and at 1:1 its faces look smooth and airbrushed where Klein's show skin and film grain (`sheets/crop-faces.png`).
- **Cost:** HiDream 2K is ~1.5× its own 1K time and cheaper than Z-Image at 2K.
- **Its 2K framing is also different:** wider scenes with more elements (the watercolour became a photo of a painting on a table).
- **Use:** HiDream when you want its look at 2K. Klein direct-2K when you want detail per second.

## Speed and memory on this box

### Console path (what the Studio and the Lab actually do)

Median over the 24 suite images at 1024², console request to saved PNG:

| Model | Median | p90 | Fastest |
| --- | ---: | ---: | ---: |
| FLUX.2 Klein 4B (4 steps) | **9.9 s** | 13.6 s | 7.2 s |
| HiDream-O1 Dev (28 steps, 1024²) | 11.8 s | 14.9 s | 8.9 s |
| Z-Image Turbo (8 steps) | 13.7 s | 19.6 s | 12.2 s |
<!-- QWEN-SPEED -->
| gpt-image-2 (cloud, router) | 26.1 s | 50 s | 13.3 s |

### Cold vs warm (direct to ComfyUI, same graph, no unload in between)

| Model | Cold (after /free, weights in OS file cache) | Warm (resident) |
| --- | ---: | ---: |
| FLUX.2 Klein 4B | 8.8 s | **1.3–1.6 s** |
| Z-Image Turbo | 12.7 s | 5.0–5.3 s |
| HiDream-O1 Dev | 12.6 s | 5.8–6.3 s |

**Most of a console generation is loading, not denoising.** `src/lib/flux.ts`
asks ComfyUI to drop its weights after every job whenever the queue is idle.
That keeps the coordinator's admission arithmetic honest, but it means the
Studio pays the cold price on nearly every image:

- Klein's 4 steps take ~1.5 s of an ~10 s request.
- ComfyUI's `/free` only takes effect when it next idles, so back-to-back jobs
  on the same model are sometimes accidentally warm. That is why Klein's
  fastest suite image was 7.2 s.

A keep-resident window would make Klein a ~2 s model (see Follow-ups). It
would need to be declared to the coordinator as a resident reservation.

### Clean cold footprints

<!-- FOOTPRINT -->

### Can two stay resident together? What the coordinator said

Recorded verbatim in the run manifest (`coresidency`, `denials`):

- **No two image generations ever run at once, by policy.** Every image
  workload takes the exclusive `gpu-heavy` slot. Holding Klein and asking for
  Z-Image, HiDream or FLUX schnell returned
  `gpu-heavy is busy with flux2-klein-generate` before memory was considered.
  The same slot serialises image generation against Ollama chat: a Gemma 4
  Text Lab run from another session produced
  `gpu-heavy is busy with ollama-chat (lab:text:local-gemma4)`.
- **Resident weights are what collide.** The coordinator counts them against VRAM:
  - With Gemma 4 still loaded in Ollama after its run: `VRAM needs 11.94 GB more … but only 3.77 GB is currently free` for Z-Image.
  - Klein at 2K under other sessions' RAM load: `RAM needs 11.87 GB more … but only 5.54 GB is currently free`.
- **Qwen-Image cannot share host RAM with much at all.** `RAM needs 28 GB more plus … 4 GB safety, but only 23.85 GB is currently free`, with ComfyUI and other sessions' services up.
- **FLUX.1 schnell does not fit this box as configured.** Every attempt was refused: `RAM needs 27.87 GB more … but only 24.83 GB is currently free; VRAM needs 31.64 GB more … but only 28.44 GB is currently free`. Its declared footprint is 31.7 GB VRAM (the fp16 T5 alone is 9.1 GB). Klein does its job faster and better, so schnell has no case here.
<!-- QWEN-CORES -->

## Cloud comparison

gpt-image-2 through the AI Router on the six-prompt cloud subset. Costs are
what the router's traffic log recorded from LiteLLM:

| Prompt | Cost | Latency |
| --- | ---: | ---: |
| Sign | $0.024 | 28.9 s |
| 5 apples | $0.006 | 13.3 s |
| Hands | $0.024 | 24.8 s |
| Long prompt | $0.024 | 27.3 s |
| Arabic prompt | $0.053 | 50.0 s |
| Arabic text | $0.013 | 22.0 s |
| **Mean** | **$0.024** | **26.1 s** |

Local images are not metered and not free: they cost GPU time on a card other
work wants. gpt-image-2 passed every objective check it was given, including
the two no local model passed (five apples; Arabic prompt with the keffiyeh
right).

**Gemini (gemini-image-fast)** returned `429 … You exceeded your current
quota` on all six. The Gemini key's image quota is exhausted, so no Gemini
comparison was possible and nothing was billed.

<!-- QWEN-SECTION -->

## Fine-tuning (LoRA) on a 32 GB card

Researched, not trained. Nothing was downloaded or run for this section. The
figures are the trainers' own published numbers. Anything marked
_unverified_ could not be traced to a primary source.

| Model | Train on | Trainers | VRAM at 1024² (published) | Typical run | ComfyUI | Licence |
| --- | --- | --- | --- | --- | --- | --- |
| **FLUX.2 Klein 4B** | `FLUX.2-klein-base-4B` (undistilled). BFL says train on base; the LoRA then runs on the 4-step distilled model you already have. | ai-toolkit, musubi-tuner, OneTrainer, SimpleTuner, diffusers `train_dreambooth_lora_flux2_klein.py` | 12 GB minimum (BFL); under 24 GB on a 4090 (BFL/HF blog) | 15–40 images for a style; 1,500–3,000 steps at LR 8e-5 to 1e-4; ~1,800 steps under an hour on a 4090 | Loads (community nodes list it; no primary doc found, _unverified_) | Apache-2.0 (the 9B is non-commercial) |
| **Z-Image Turbo** | `Tongyi-MAI/Z-Image` (Base, undistilled, Apache-2.0), or Turbo plus Ostris's training adapter. Turbo alone is marked "not finetunable": training breaks the distillation. | ai-toolkit, musubi-tuner (recommends Base), OneTrainer, SimpleTuner, diffusers | ~32–40 GB unquantised; 16–24 GB int8; 10–12 GB NF4 (SimpleTuner) | No primary source; assume Klein-like 1–3k steps (_unverified_) | Needs a conversion script (musubi ships one). Base-trained LoRAs carry over to Turbo only partly (third-party, _unverified_) | Apache-2.0 |
| **HiDream-O1 Dev** | The bf16 checkpoint (15.6 GB). The fp8 file installed here is inference-only. | ai-toolkit; musubi-tuner (experimental) | **No published number.** Block swap + gradient checkpointing make 32 GB plausible (_unverified_) | No primary source | Only via a community node pack (_unverified_ natively) | MIT |
| **Qwen-Image 20B** | bf16 base | ai-toolkit, musubi-tuner, SimpleTuner, OneTrainer, DiffSynth-Studio, diffusers | 42 GB plain; **30 GB** with fp8 base; 24 GB + 16 swapped blocks; 12 GB + 45 blocks (musubi's table). Musubi wants 64 GB system RAM for block swap; this box has 63. | ai-toolkit default 2,000 steps at LR 1e-4; one report of ~2 h for 2,000 steps on a 5090 (single source) | Loads normally | Apache-2.0 |

**Answer.** **FLUX.2 Klein 4B** is the realistic model to teach a consistent
style or subject on this card:

- It has an Apache-licensed undistilled base made for training.
- Published memory needs are well under 32 GB.
- A run is about an hour.
- The LoRA runs on the 4-step model that is already installed here and wins on speed (below).

Z-Image is a close second if trained on **Z-Image Base**, but that means a
second 6B download and less certain LoRA transfer back to Turbo. Qwen-Image
fits only with fp8 plus block swap, and needs roughly all of this box's RAM.
HiDream-O1 has no evidence to plan around yet.

Cost of a Klein trial: the base checkpoint download (~7–8 GB, D:), 20–40
captioned images, and about an hour of exclusive GPU time. Nothing was trained.

Sources:
- [BFL Klein training docs](https://docs.bfl.ml/flux_2/flux2_klein_training)
- [HF blog: Klein LoRA](https://huggingface.co/blog/black-forest-labs/flux-2-klein-lora)
- [musubi-tuner docs](https://github.com/kohya-ss/musubi-tuner/tree/main/docs): flux_2, zimage, hidream_o1, qwen_image
- [SimpleTuner Z-Image quickstart](https://github.com/bghira/SimpleTuner/blob/main/documentation/quickstart/ZIMAGE.md)
- [ai-toolkit](https://github.com/ostris/ai-toolkit)
- [ostris/zimage_turbo_training_adapter](https://huggingface.co/ostris/zimage_turbo_training_adapter)
- [Tongyi-MAI/Z-Image](https://huggingface.co/Tongyi-MAI/Z-Image)

## What's newer than 12 September

Checked 27 September against the
[Artificial Analysis open-weights text-to-image](https://artificialanalysis.ai/image/leaderboard/text-to-image/open-weights)
and [editing](https://artificialanalysis.ai/image/leaderboard/editing/open-weights)
leaderboards (human-preference Elo; one snapshot), and against the Hugging Face
hub.

**Qwen-Image-2.1** ([HF](https://huggingface.co/Qwen/Qwen-Image-2.1)):
- **Release:** repo created 14 Sep, last modified 21 Sep.
- **Rankings:** **#1 open-weights text-to-image (Elo 1035)** and **#1 open-weights editing (1071)**.
- **Size:** a 7B image model with a Qwen3-VL-8B text encoder. A single model covers both generation and editing, with RGBA output. ComfyUI supports it natively.
- **Fit:** Comfy-Org's repack lists 7.3 GB int8 model weights plus a 9.4 GB int8 encoder, so it fits 32 GB.

**But the licence is the Qwen _Research_ Licence: non-commercial only.**
- Chinese law applies, with Hangzhou courts having exclusive jurisdiction.
- Derived models must carry a "Built with Qwen" notice.
- No regions are excluded.

Checked in the [LICENSE file](https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE).

For scale, the models installed here sit at these ranks on the same board.

| Model | Text-to-image | Editing |
| --- | --- | --- |
| Z-Image Turbo | #18 (940) | — |
| Qwen Image | #24 (887) | Edit-2509: #8 (980) |
| HiDream-O1 Dev | #27 (878) | — |
| FLUX.2 Klein 4B | #32 (864) | #11 (949) |
| FLUX.1 schnell | #39 (802) | — |

Hugging Face downloads and likes are adoption, not quality: 2.1 had 52.8K
downloads (last-30-days counter on the model API) and 2,460 likes on 27 Sep.
The Elo is the quality evidence.

Also checked:
- **HiDream-O1-Image (full, non-Dev)**, MIT: **#13 (979)**, 101 Elo above the Dev model installed here. It is in the same [Comfy-Org repo](https://huggingface.co/Comfy-Org/HiDream-O1-Image) as an fp8 file of the same 7.7 GB size.
- **Ming-Image-0.1-Design** (inclusionAI, MIT, released 17 Sep): #7 (996). Aimed at text-heavy design. ComfyUI support merged to master on 24 Sep but is not in a tagged release. Only 80 GB has been validated for it.
- **Tencent Hy Image 3.5**: no weights.
- **Qwen-Image-3.0**: still closed.
- **HiDream-O1-Image-1.5**: not on Hugging Face.
- **BFL:** only non-image releases in this window.

<!-- NEWER-VERDICT -->
