# 01 — Image: explore FLUX and HiDream properly

> Paste into a fresh Claude Code session opened in
> `C:\Users\Admin\Code\AI\betenshi-console`.

---

Read `docs/explorations/README.md` first, then `docs/labs.md` if it exists
(from the platform brief), then **`docs/image-model-experiment-2026-09-12.md`** —
this brief continues that one.

I have done good work with Qwen-Image. I have not explored FLUX or HiDream
properly. They are **already installed and each ran once**
(`src/lib/image-models.ts`): FLUX.2 Klein 4B (4-step, generate + edit),
HiDream-O1 Dev (8B FP8, native 2K), Z-Image Turbo (6B NVFP4, 8-step), plus
FLUX Schnell and Qwen-Image. They run through ComfyUI, workflows in
`src/lib/comfy-image-workflows.ts`. The 12 September doc compared them on two
prompts with one seed — a smoke test, not an understanding.

**Answer these, with evidence:**

1. **Where does each model actually win?** Build a fixed evaluation prompt suite,
   committed to the repo so reruns are comparable. Cover the things image models
   genuinely differ on: rendered text and typography, counting and spatial
   layout, hands and faces, photographic realism, illustration styles, long
   compositional prompts, and non-English prompts (Arabic matters to me). About
   a dozen prompts, two seeds each. Not more.
2. **Editing.** Klein supports editing; Qwen-Image has an edit path. Compare them
   on real edits — replace an object, change the lighting, extend a canvas.
3. **Resolution.** HiDream is native 2K. Is 2K from HiDream better than 1K from
   the others upscaled? What does it cost in time and memory?
4. **Speed and memory.** Cold and warm, per model, measured on this box —
   including whether two can stay resident together. The resource coordinator
   will tell you when not; record what it said.
5. **Fine-tuning.** What does LoRA training look like for each on a 32 GB card?
   Is there a model here I could realistically teach a consistent style or a
   subject? Do not train anything large; establish feasibility and cost.
6. **What's newer.** Check whether better open image models have appeared since
   12 September. If one is clearly worth it, say so with evidence; do not
   install it without saying why.

**Cloud comparison:** run a subset of the suite against at least one cloud image
model through the router, and put its cost per image beside the local numbers.

**Judging quality:** do not score images yourself by vibes. Make the output
browsable side by side in the console — per prompt, every model in a row — so
the user judges, and record which dimensions are objective (text legibility,
correct count) versus taste.

**Deliverables:** the prompt suite; a side-by-side view in the Image Lab (or the
existing studio, if the Labs registry isn't there yet); per-model presets if the
defaults turn out wrong; `docs/image-model-experiment-2026-09-XX.md` with a
recommendation per use case, not a single winner. Commit to `master`.
