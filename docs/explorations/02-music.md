# 02 — Music and audio generation

> Paste into a fresh Claude Code session opened in
> `C:\Users\Admin\Code\AI\betenshi-console`.

---

Read `docs/explorations/README.md` first, then `docs/labs.md` if it exists.

Nothing on this box generates music today. Speech exists — Whisper for
transcription, Kokoro and a Chatterbox voice-cloning service for synthesis — so
read `C:\Users\Admin\Code\AI\chatterbox\server.py` before starting: it is the
worked example of installing a torch-pinned audio model on this GPU, and the
same trap is likely here.

**Research first.** As of late September 2026 the candidates were ACE-Step 1.5
(hybrid LM planner plus diffusion renderer, claimed four minutes of audio in
about twenty seconds on an A100), YuE 7B (autoregressive, cannot stream),
Stable Audio Open, and MusicGen. Verify what is current, which have usable
licences — **Stable Audio Open's licence restricts commercial use; check the
others** — and what fits 32 GB. Pick one to install and say why the others
lost.

**Build:**

- The model as its own service with its own venv, registered the way the README
  describes, footprint measured.
- A Music Lab: text prompt, optional lyrics, duration, seed → audio player,
  waveform, latency, peak VRAM. Keep outputs in a gallery the way images are.
- If the model supports it: continuation, remix of an uploaded clip, instrument
  stems. Say what it supports instead of building UI for what it doesn't.
- An MCP tool only if there is a real agent use for it.

**Measure:** time to generate 30 s, 1 min and 3 min; VRAM; whether it can share
the card with the speech services; how well it follows genre, tempo and
instrumentation instructions; how intelligible sung lyrics are. A small set —
six prompts across genres, two seeds.

**Questions I care about:**

- Could this produce usable background music for short videos — for example the
  city videos the video brief (04) might make?
- Does anything useful come from combining it with the cloned voice? It is my
  own voice, cloned on my own machine; say plainly whether the result is any
  good rather than whether it is technically possible.

**Deliverables:** the service, the Lab, and
`docs/music-model-experiment-2026-09-XX.md`, recommendation first. Commit to
`master`.
