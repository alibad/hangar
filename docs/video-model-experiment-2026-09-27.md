# Video model experiment — 2026-09-27

_Draft — measurements in progress on BeTenshi (RTX 5090 32 GB, 63 GB RAM)._

## Recommendation

_Pending measurements._

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
