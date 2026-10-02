# Video Forge — a loop that listens and makes clips overnight

**Status (2026-09-30 15:00):** working end to end, unattended, in unlimited mode. It feeds **Montage** (`hq/montage`, http://localhost:8017), which turns the clips into one-minute 1080p reels. The first night made 4 clips; the first all-day window made ~50 more at 480p before the forge moved to 720p with a vision check on every still.

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

## Unlimited, 720p, and checked (2026-09-30, daytime)

The owner asked for unlimited clips through the night windows and an all-day test, then for one-minute high-quality videos. What changed, and why:

| Change | Why |
|---|---|
| **Unlimited batches.** In a window: write a batch of briefs while vllm-small is up, pause it once, render the batch back to back (ticks every 4 s while busy), start it again, repeat | One vllm-small pause per batch instead of per clip |
| **Google Trends across 16 English-speaking countries**, three days of Wikipedia most-read | One country's 20 trends were used up by mid-morning |
| **Two shots per topic** — the brief's scene, then a close-up of one detail, same light and palette | Twice the clips per topic, and reels get establishing-shot → detail sequences instead of ten unrelated cuts. The 7B copied shot 1 into shot 2 at first; an overlap check sends that back |
| **Weather fallback** — when trends miss twice, "Golden hour, scattered clouds in Lisbon" from Open-Meteo for 40 photogenic cities (none repeated within 3 days) | Trends ran dry for hours at a time |
| **720p** (1280×704, Wan 5B's native size): 141 s per 5 s clip vs 58 s at 480p | 480p looks soft at 1080p |
| **Every still checked** by Qwen3-VL 8B (Ollama, unloaded after each look, ~15 s) and redrawn up to 3× if it shows people, writing or a logo | On the first 20 480p clips Montage's gate turned away 13 — mostly people and lettering the still model drew despite the prompt |
| **Filters**: brand names and acronyms in prompts, risky news (drugs, legal cases, hijacks, receiverships, strikes), a per-topic "risky" judgement, negated mentions ("no travelers") allowed | Each was a brief the gallery exposed |
| **Retry** a clip once when ComfyUI's weight streamer fails (`HostBuffer.read_file_slice`, 2 of the first 27) | Transient |
| **Re-pause vllm-small** mid-window if quote-forge's drip restarts it (owner's choice, 2026-09-30) | The drip asks the manager for it every 5 minutes |
| **One tick at a time** across hot reloads (a lock on `globalThis`) | A retired loop finishing a step while the new one starts could queue a clip twice |

First 720p clip (an empty tennis court at sunset): still made and checked in 15 s, clip rendered in 141 s, passed Montage's gate.

## Story films (2026-10-02, from 02:50)

The owner found the trending topics lame and asked for real stories instead — "an actual movie… philosophical stories that teach lessons" — made through the night and traceable in the Lab. The forge now has a second mode, `mode: "stories"` (the switch is at the top of this page).

| Step | What | Model | Where it is recorded |
|---|---|---|---|
| Seed | A public-domain parable, fable or myth, or an original premise, from 38 in `src/lib/forge/story.ts`; told tales alternate with originals, none repeats while unused ones remain | — | the story |
| Screenplay | 14 shots: one narration line each (6–14 words), the picture as an image prompt with every character's full look repeated, the motion; a title, logline, lesson, one visual look, a music brief | **Gemma 4 31B** (Ollama, ~18 GB) — written inside the GPU turn after vllm-small is paused, unloaded right after; ~35 s | lab run `forge` · text; the story in `forge_stories` |
| First frames | Z-Image Turbo; Qwen3-VL turns away writing and logos (people are the characters here, so they pass) | Z-Image Turbo, Qwen3-VL 8B | lab run `forge` · image |
| Clips | Wan 2.2 5B, 5 s at 1280×704; a negative prompt against text, morphing and distorted hands; a clip graded 3/3 for distortion is drawn and animated once more | Wan 2.2 5B | the Video Lab's queue (lab run `video`) |
| The film | Narration, score and the cut happen in **Montage** (http://localhost:8017) once every shot is done | Kokoro, ACE-Step, Remotion | lab runs `forge` · tts and video; the score in the Music Lab |

A shot takes ~2.7 minutes (13 s still, 8 s check, ~140 s clip, 8 s grade), so a 14-shot film is ~40 minutes of the window, and the cut adds ~3 minutes of GPU (narration and score, in a turn the forge gives up between two shots) and ~2 minutes of CPU.

What went wrong first: ComfyUI had been stopped, nothing starts it, and the first story's 14 stills failed in 14 seconds with "fetch failed". The forge now starts ComfyUI through the manager before a still, retries a dropped connection three times, and can put a story's failed shots back (`{ action: "requeue", id }`). The writer's character names were also replaced by their look even when the look was already in the prompt, doubling it; only a capitalised name with its look absent is replaced now.

### The first story night (2026-10-02, 02:50–09:00)

- **RAM, not VRAM, was the wall.** quote-forge's Qwen image server (`qwen`, :8021) held 28–31 GB of RAM with 98 GB committed; the coordinator refused every first frame for 40 minutes. The owner had it stopped and kept off; quote-forge's loop starts it again whenever it finds room (it did during Montage's turn), so the forge now stops the services in `keepOffInWindow` again while the window is open (at most every 2 minutes each).
- **vllm-small comes back during handovers** — quote-forge's drip restarts it in the minutes Montage holds the card. A first frame waiting for memory now frees ComfyUI's cache and pauses it again, as a waiting clip already did.
- **Bigger video models do not fit beside the rest:** Wan 2.2 14B (4-step) asked for ~38 GB more RAM, LTX-2.5 22B similar; both test jobs were cancelled before they could hold the queue. Wan 2.2 5B stays.
- **The writer's brief matters most.** The first two screenplays were plain ("The current was soft and the air was heavy."); with a storyteller's brief, a list of banned clichés and stylised looks only, the third read "the salt air tasted of iron… a small, clicking fire of cedar… The sky remained, wide and indifferent to the fall."
- **Stylised looks hold together:** ink wash, clay stop-motion and papercut kept characters the same across 14 shots, every clip graded 4–5/5 with no distortion. The photoreal look was dropped.
