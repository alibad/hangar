# 04 — Video generation

> Paste into a fresh Claude Code session opened in
> `C:\Users\Admin\Code\AI\betenshi-console`.

---

Read `docs/explorations/README.md` first, then `docs/labs.md` if it exists.

Video is the capability that most needs this card: it is expensive in the
cloud, it produces something you can show someone, and the good open models sit
right at 32 GB. It is also the one most likely to collide with everything else
on the box, so the resource side of this brief matters as much as the model.

**Research first.** Candidates in late September 2026: **LTX-2.5** (native audio
and video in one pass; reported to need ~32 GB even quantized — the edge of this
card), **Wan 2.2** (Apache 2.0; 5B and 14B variants), **HunyuanVideo 1.5**
(~14 GB at FP8 with offload). Verify what is current and what the licences
permit. **ComfyUI is already installed and running** — prefer running these as
ComfyUI workflows (see `src/lib/comfy-image-workflows.ts`) over a new service,
unless there is a concrete reason not to.

**Measure, on this box:**

- Seconds of video per minute of generation, at two resolutions and two lengths.
- Peak VRAM **and host RAM** — video models offload, and a 63 GB machine with
  Qwen-Image resident has run out of RAM before.
- What must be stopped for each model to run. The resource coordinator will
  refuse starts that do not fit; the Lab has to turn that refusal into "stop
  these two things", with the buttons, not an error.
- Text-to-video versus image-to-video from an image generated locally.
- Temporal coherence, motion quality, and for LTX, whether the generated audio
  is usable.

Keep the set small: five prompts, one seed each at first. A single run can take
minutes.

**Build:** a Video Lab — prompt or source image, length, resolution, seed →
progress with an honest ETA, a player, the frames it took, latency and peak
memory. Queue long jobs rather than holding a request open for ten minutes; the
image studio's batch queue (`src/lib/batch-queue.ts`) is the precedent.

**Cloud comparison:** one or two prompts against a cloud video model if one is
reachable, with its cost. If none is, say so.

**A use case to test against:** a 10–15 second clip for a city page — for
example a Globe Quest destination — from a locally generated still. Treat
globe_quest's data as read-only fixtures; do not wire that project to anything
local.

**Deliverables:** the workflows or service, the Video Lab with queueing,
`docs/video-model-experiment-2026-09-XX.md`, recommendation first, including
which model to reach for at which length. Commit to `master`.
