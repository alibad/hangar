# Video model experiment — 2026-09-27

_BeTenshi (RTX 5090 32 GB, 63 GB RAM). Updated 2026-09-30 after the first night's measured runs._

## Recommendation

**Use Wan 2.2 TI2V 5B (Apache 2.0) as the default local video model — for the Video Lab and for the Video Forge.** It is the only model measured end to end on this box so far, and it is fast enough to be useful: **a 5 s, 480p clip in ~58 s** (5.2 s of video per minute of generation), 10 s at 480p in 130 s, and 5 s at 720p in 152 s. Eight clips were made with it on 2026-09-30, four of them by the Forge unattended.

- **For the city-page use case (10–15 s):** 10 s at 480p in ~2 min, or 10 s at 720p in ~6.5 min. Wan 5B's graph caps a clip at 10 s; a 15 s page clip is two clips or a heavier model.
- **It needs the card to itself.** ComfyUI's process peaked at 23–24 GB VRAM and 17–19 GB RAM, with the card free. Beside quote-forge's vllm-small (17.5 GB) it is refused by the coordinator — which is why video is made in the owner-approved 01:00–07:00 window.
- **Not yet measured:** Wan 2.2 14B, LTX-2.5, HunyuanVideo 1.5, MiniMax H3 — all installed (LTX-2.5 finished downloading) with graphs validated against ComfyUI's `/object_info`. Their runs were queued on the first night and could not start: quote-forge's drip starts vllm-small again within 5 minutes of it being paused (its dependency check asks the manager, and the manager says yes whenever there is room between two jobs). Until the window can hold vllm-small off, only a model that fits beside it can be measured. See "What blocks the rest".
- **On public evidence, MiniMax H3 is the strongest open model** (arena Elo 1220 / 1181, above Veo 3.1) — but its licence grants no rights in the USA, EU, UK or South Korea, so it stays a benchmark, not a default. LTX-2.5 is the strongest with a usable licence and adds audio.
- **Cloud comparison: none reachable.** Veo 3.1 Fast/Lite are wired into the Lab but Google refuses them on this key (quota / billing); Sora's video API is gone. Their price, for the record, is $0.10/s (Fast, 720p) and $0.05/s (Lite) — a 10 s city clip would be $0.50–$1.00.

## Measured on BeTenshi (2026-09-30, 01:08–01:20)

Image-to-video from the same locally made Lisbon still (Z-Image Turbo), one seed, the Video Lab's queue, card to itself (vllm-small paused in the window). "Process" figures are ComfyUI's own, from Windows' per-process GPU and working-set counters; "card" is nvidia-smi's total.

| model | size | clip | wall time | s of video / min | load · sample · decode | ComfyUI VRAM peak | ComfyUI RAM peak | card peak |
|---|---|---|---|---|---|---|---|---|
| Wan 2.2 5B | 832×480 | 5 s | 58 s | 5.21 | 5 · 43 · 10 s | 23.2 GB | 18.2 GB | 25.4 GB |
| Wan 2.2 5B | 832×480 | 10 s | 130 s | 4.62 | 5 · 106 · 19 s | 23.2 GB | 18.8 GB | 25.4 GB |
| Wan 2.2 5B | 1280×704 | 5 s | 152 s | 1.98 | 5 · 128 · 19 s | 24.3 GB | 16.7 GB | 26.5 GB |
| Wan 2.2 5B | 1280×704 | 10 s | 388 s | 1.55 | — | 24.4 GB | 16.8 GB | — |

The Forge's four clips that night (480p, 5 s) took 56–58 s each — the same figure from a different path, which is the check that the bench and the product agree.

Quality, by looking at the clips (the Forge doc has the frames): coherent slow camera moves on landscapes and venues; **writing on screen becomes gibberish**; and the model can **walk a person into an empty scene** in the last second. Wan 5B samples with real CFG (5), so a negative prompt steers it; the Forge now sends one.

### What blocks the rest

The window pauses vllm-small, but quote-forge's `src/deps.ts` asks the manager to start it every 5 minutes, and the coordinator admits it whenever the card is momentarily free — between two video jobs. Fixes, in order of preference (none applied; each is the owner's call):

1. quote-forge honours `logs/gpu-claim.txt` before asking for a GPU service (the protocol every session already follows);
2. the manager keeps a service stopped by a window owner stopped until the window ends;
3. the window also pauses quote-forge's drip (its documented `var/STOP_DRIP` switch).

## What is current (verified 27 Sep 2026)

The brief's list (LTX-2.5, Wan 2.2, HunyuanVideo 1.5) was a week old and missed
the model that now dominates open video: **MiniMax H3**, released 28 Jul 2026.

**Quality evidence — Artificial Analysis Video Arena**, pulled 27 Sep 2026, "with
audio" boards (the default view). Elo, open-weights models and the cloud models
this Lab compares against:

| model | open weights | text→video Elo | image→video Elo |
|---|---|---|---|
| MiniMax H3 | yes | **1220** | **1181** |
| Veo 3.1 | no | 1088 | 1082 |
| Veo 3.1 Fast | no | 1085 | 1066 |
| Veo 3.1 Lite | no | 1083 | 1072 |
| LTX-2.5 Fast | yes | 1055 | 1036 |
| LTX-2.5 Pro | yes | 1053 | 1005 |
| Wan 3.0 (for scale; not open) | no | 1229 | 1164 |

Wan 2.2 and HunyuanVideo 1.5 make no audio and are not on the with-audio
boards; the without-audio board could not be read from the page. The last
published head-to-head found says LTX-2 overtook Wan 2.2 A14B on both boards in
January 2026 (Artificial Analysis on X). So on public evidence: **H3 > Veo 3.1 >
LTX-2.5 > Wan 2.2**, with HunyuanVideo 1.5 unranked.

**Adoption** — Hugging Face `downloads` (last 30 days) and `downloadsAllTime`,
27 Sep 2026. The ComfyUI repackages are how people actually run these, so both
are shown. Adoption is attention, not quality; it is here to show where the
ecosystem (LoRAs, workflows, fixes) is, nothing more.

| repo | 30-day | all-time |
|---|---|---|
| Comfy-Org/MiniMax-H3 | 21.9M | 42.5M |
| MiniMaxAI/MiniMax-H3 | 3.7M | 8.7M |
| Comfy-Org/Wan_2.2_ComfyUI_Repackaged | 6.0M | 87.3M |
| Lightricks/LTX-2.5 | 1.6M | 2.7M |
| Comfy-Org/HunyuanVideo_1.5_repackaged | 0.6M | 6.8M |
| tencent/HunyuanVideo-1.5 | 1.2K | 0.8M |

## Licences — read before the install

| model | licence | what it means here |
|---|---|---|
| Wan 2.2 (5B, 14B) | Apache 2.0 | No restrictions. |
| LTX-2.5 | LTX-2.x Community License | Free for commercial use under $10M annual revenue; above that a paid licence. The Hub repo is **gated**: access needs "Agree and Access" on the account, which also consents to Lightricks marketing. |
| HunyuanVideo 1.5 | Tencent Hunyuan Community License | **Not licensed in the EU, UK or South Korea.** |
| MiniMax H3 | MiniMax H3 Community License | **Grants no rights at all in the USA, EU, UK or South Korea** — use, and display of outputs, outside its territory is unauthorized. Separate written authorization above $20M revenue; must show "MiniMax H3" in a commercial product's UI; outputs may not train other models. |
| Veo 3.1 (cloud) | Google API terms | $0.40/s standard, $0.10/s Fast at 720p, $0.05/s Lite at 720p, audio included (Gemini API pricing page, 27 Sep 2026). |

Sora 2 is listed by the OpenAI key's `/v1/models` but its API was reported
sunset on 24 Sep 2026; it was not used.
