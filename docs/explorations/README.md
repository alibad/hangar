# Explorations

Seven briefs, each meant to be pasted into its own fresh Claude Code session
opened in `C:\Users\Admin\Code\AI\betenshi-console`. Each brief is short because
it starts by telling the session to read this file — the ground rules below are
the things that cost real time to learn and should not be relearned seven times.

| # | Brief | What it produces |
|---|---|---|
| 00 | [Platform](00-platform.md) | The Labs registry every other brief plugs into. **Run first.** |
| 01 | [Image — FLUX & HiDream](01-image-flux-hidream.md) | A controlled comparison of the image models already installed |
| 02 | [Music](02-music.md) | A local music service and its Lab |
| 03 | [3D](03-3d.md) | Image → mesh on this box, with a viewer |
| 04 | [Video](04-video.md) | Local video generation at the edge of 32 GB |
| 05 | [Laya decision models](05-laya-decision-models.md) | Fast typed decisions, measured against LLMs on real use cases |
| 06 | [BPMN + DMN simulation](06-bpmn-dmn-simulation.md) | A simulated business with real processes and real AI wired in |

**Order.** Run 00 first; it is small and it defines the contract the rest
follow. After that, 01–05 can run in parallel. 06 depends on 05 for its
learned-decision steps, so start it after 05 has a working `/api/decide`, or
let it stub that step and come back.

**Parallel sessions and conflicts.** Several briefs add a console surface. The
Labs registry from 00 exists so each Lab is its own component file registered
in one place — without it, five sessions edit `src/app/page.tsx` at once. If
you run briefs in parallel, give each its own worktree.

---

## Ground rules for every exploration

### The machines

- **BeTenshi** — Windows 11, RTX 5090 (32 GB, Blackwell sm_120), 63 GB RAM.
  This is where most of this runs.
- **B5** — a Mac, unified memory. Profile `config/hosts/b5.json`.
- What each machine can run lives in its **host profile**
  (`config/hosts/<id>.json`), never in code. A Lab that hardcodes a service
  name or a port has failed the "reusable across machines" requirement.

### Adding a local model service

1. Its own directory under `C:\Users\Admin\Code\AI\<name>` and **its own venv**.
   Never install into the shared `Python312` — Whisper, Kokoro and others run
   from it. Create the venv with `--system-site-packages` to inherit
   `torch 2.11.0+cu128`, which is Blackwell-capable.
2. **Anything pinning `torch < 2.7` cannot run on this GPU at all** (no sm_120
   kernels). Install such packages with `--no-deps` and add the rest by hand.
   Precedent and write-up: `C:\Users\Admin\Code\AI\chatterbox\server.py`.
3. Weights go to `D:\AI Models` (`HF_HOME=D:\AI Models\huggingface`). C: is for code.
4. Register it in **two** places: the host profile (with `serves` if it provides
   a capability) and `scripts/service-commands.json` (how to launch it).
5. Declare its footprint in `config/model-meta.json` — `kind: "reserved"` if it
   holds memory from start, `"peak"` if transient — **measured, not estimated**,
   with the measurement in `basis`.
6. The service manager is `scripts/manager.cjs` on `:8099`, run by the
   **"BeTenshi Manager"** scheduled task. `C:\Users\Admin\Code\AI\manager\server.py`
   is dead; do not edit it. Restarting the manager kills the services it
   spawned (Windows job objects) — restart those after.
7. Every start goes through the resource coordinator, which refuses with a
   reason when a model will not fit. Do not work around it; surface its reason.

### The router and the cloud

- The AI Router is LiteLLM on `127.0.0.1:4000`, config `config/ai-router.yaml`.
  It is **local-only by design and must never be exposed or tunnelled.**
- **Cloud projects — globe_quest, ColdClub, avatar-lab, tinkerer-presenter —
  must never be pointed at it.** They call vendors directly with their own keys.
  An exploration may *read* their committed data as fixtures; it may not wire
  them to local AI.
- Cloud models are fair game *for comparison*, through the router. Say what a
  cloud call cost.

### Console conventions (they exist because each one fixed a real bug)

- **Ask the engine, don't declare.** Voice lists, cloning ability and clip
  limits are all reported by the running service. Follow that shape.
- **Wherever the console names a service, give it the button.** A stopped
  service is shown with Start, not with a sentence telling you to find it.
- Style with Tailwind utilities. The dev server's CSS chunk has been seen to
  freeze; if a `globals.css` rule never applies, that is why.
- The gate is `npx tsc --noEmit` and `npm test`. Verify UI in the browser pane
  and say what you saw, not what you expect.
- The MCP server (`scripts/mcp-betenshi.mjs`) is how agents reach this box. If a
  capability is something an agent would use, add a tool — with a description
  that says when *not* to use it.

### Research and measurement

- The model landscape moves weekly. Names in these briefs were current on
  **23 Sept 2026** and may already be stale. **Verify against the Hugging Face
  hub and the relevant leaderboard before installing anything, and cite what you
  checked.** `docs/models.md` has the scout routine's rules on evidence; follow
  them — adoption is not evidence, and say which download metric you mean.
- **Check the licence before the install**, and say plainly if it restricts
  commercial use or excludes regions.
- The GPU is the user's. Controlled small sets, not bulk runs.
- Every exploration ends with `docs/<topic>-experiment-YYYY-MM-DD.md` in the
  style of `docs/image-model-experiment-2026-09-12.md` and
  `docs/arabic-model-experiment-2026-09-14.md`: **recommendation first**, then
  measured numbers, then what was verified versus assumed.

### The Lab contract

Every capability gets an entry point in the console, even when the heavy
experimentation happens elsewhere. A Lab, at minimum:

1. Lists the models for its capability **on this host**, each with footprint,
   licence, and status — Start/Stop inline.
2. Lets you try one with a minimal input and see the output.
3. Shows latency, and peak VRAM where measurable.
4. Offers the same input against a cloud equivalent, where one exists.
5. Links to the experiment doc, so the page says what was learned, not only
   what is installed.
