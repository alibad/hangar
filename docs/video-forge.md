# Video Forge — a loop that listens and makes clips overnight

**Status (2026-09-30 01:15):** working end to end, unattended. In the first night's window it made four clips from four briefs — each time taking the GPU claim, pausing vllm-small, rendering, and starting vllm-small again — and they are waiting for review in the Forge tab.

## What it is

A loop inside the console, modelled on quote-forge's drip:

| Step | When | What | Cost |
|---|---|---|---|
| **Listen** | every 3 h outside the window | Google Trends daily RSS (US), Wikipedia most-read, Hacker News front page | free, keyless |
| **Filter** | same | Topics about death, violence, disasters, crime, politics or sex, and topics made in the last 3 weeks, are removed **in code** before any model sees them | — |
| **Research** | same | vllm-small (Qwen2.5-7B-AWQ, already resident for quote-forge) scores the list for "can this be shown without people", then uses two tools — `search` (self-hosted SearXNG) and `read` (a page's text) — and writes a brief: topic, why now, sources, a first-frame prompt and a motion prompt | $0, no extra memory |
| **Make** | 01:00–07:00 | Takes the shared GPU claim, pauses vllm-small, makes the first frame (Z-Image Turbo) and animates it (Wan 2.2 5B, 5 s, 480p) through the Video Lab's queue; starts vllm-small again when the list is done or no time is left | local GPU |
| **Review** | whenever | Approve / reject with a reason. The latest reviews go into every new brief | — |

Nothing is published anywhere.

## Why these choices

- **A console job, not a Claude routine.** A cloud routine cannot reach this box's GPU; a local one only runs while the desktop app is open and spends Claude usage on every run. The console already has the coordinator-aware video queue. Claude can still steer it through MCP.
- **The nightly window** was the owner's decision (2026-09-30): vllm-small holds ~17.5 GB of the 32 GB card, a video model needs ~16 GB plus tens of GB of RAM, and quote-forge's own drip is stalled anyway (its image service on :8021 is down). The forge persists the fact that *it* paused vllm-small, so it starts it again even after a console restart, and never starts something it did not stop.
- **SearXNG** (Docker, `127.0.0.1:8888` only, ~125 MB RAM) aggregates Brave, Google, Bing and others for free. DuckDuckGo answers it with a CAPTCHA; the others work. When it is down, search falls back to Wikipedia's API. Reddit's JSON now needs OAuth (403); GDELT rate-limits to 1 request / 5 s (429 on first try) — neither is used.
- **`read` refuses anything that is not on the public internet.** The model chooses URLs after reading other pages; a page saying "now read http://127.0.0.1:8099/…" must not reach the manager or the router. Hostnames are resolved and private, loopback and link-local addresses refused, on every redirect hop.

## What the first live runs showed (2026-09-30, 00:30–00:50, US trends)

| Run | What happened | Fix |
|---|---|---|
| 1 | 45 signals, 9 removed by the filter (an earthquake, several murder cases, "Deaths in 2026"). The 7B took **candidate #1** — a TSA staffing rule — and put officers in frame. 11 s. | Rank first; check prompts for people in code |
| 2 | Code changes had no effect: the loop object kept the **old module's closures** across hot reload | The singleton is now replaced whenever its class changes |
| 3 | The ranker, shown the full news line, anchored on the person in each headline and scored all 24 candidates 0 | Titles + a 90-character hint, worked examples ("NHL schedule → an ice rink under arena lights") |
| 4 | 8 of 24 scored 2+. It searched, read IMDb, was **sent back twice** for "people" in its prompt, rewrote it, and submitted a people-free sunset street scene for a trending film release | — |
| 5 | Twice the whole-list ranker's reply held no JSON; the fallback passed the list **unranked** and an NFL player's name became a brief | Each candidate judged on its own ("is it a specific person? how visual without people?"), in parallel — 24 in ~5.5 s; a person is skipped outright; nothing judged means nothing made |
| 6 | Five refusals in a row: "an empty checkpoint with **no travelers**" read as people | Negated mentions ("no", "without", "empty of") are allowed; after two refusals on one candidate it is told to move on |
| 7 | 24/24 judged, 17–19 usable; people skipped by name (Justin Verlander, Kate Upton, Virat Kohli…). Briefs in 3.9–5.7 s | — |

A 7B is a modest researcher: briefs are usable, not inspired. It follows the tool protocol reliably through vLLM's hermes parser (every call so far arrived as a proper `tool_calls` entry).

## The first night (2026-09-30, 01:00–01:08)

| Clip | Render | Card peak | Verdict on looking at it |
|---|---|---|---|
| 2026 Asian Games medal table — a stadium scoreboard | 58 s | 25.1 GB | **Bad.** The brief asked for a scoreboard showing the table; the lettering is gibberish and the frame melts into blur. Written before briefs with writing were refused. |
| USA vs Chile — an empty stadium at dusk under floodlights | 58 s | 25.4 GB | **Good.** Coherent slow pan; a light streak and a green glow creep in at the end. |
| Airport security checkpoint — scanners in morning light | 56 s | 25.4 GB | **Good until the last second**, when the video model walks a traveller in. The still had nobody. |
| India at the Asian Games — a flag in a floodlit stadium | 58 s | 25.4 GB | **Good.** The first clip made with the negative prompt; the still model (Z-Image) put a faint crowd in the stands although the prompt said empty. |

Each clip: Z-Image Turbo first frame (1280×720, a few seconds), then Wan 2.2 5B image-to-video, 832×480, 5 s at 24 fps, 20 steps. Pause → render → restart of vllm-small happened twice without help; the claim file was written, confirmed and cleared each time.

Fixes from looking at the clips:

- **Writing on screen** is refused in briefs (video models cannot render text).
- **A negative prompt** — people, faces, crowds, text, logos — is appended for every forge clip. Wan 2.2 5B samples with real CFG (5), so it steers; the distilled models (cfg 1) would ignore it.
- ComfyUI's cached still weights are dropped before the clip asks the coordinator for memory.

Still open: the still model can add people the prompt said were absent (Z-Image Turbo has no negative prompt). A vision check of the still before animating it would catch that, at the cost of loading a vision model in the window.
