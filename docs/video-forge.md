# Video Forge — a loop that listens and makes clips overnight

**Status (2026-09-30 01:00):** the listening and brief-writing half works end to end on live data. The render half runs for the first time in tonight's window; the results below are filled in as they land.

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

A 7B is a modest researcher: briefs are usable, not inspired. It follows the tool protocol reliably through vLLM's hermes parser (every call so far arrived as a proper `tool_calls` entry).

## Measurements

*Pending tonight's window.*
