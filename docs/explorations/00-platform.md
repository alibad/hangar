# 00 — Turn the console into an experimentation platform

> Paste into a fresh Claude Code session opened in
> `C:\Users\Admin\Code\AI\betenshi-console`. Run this one before the others.

---

Read `docs/explorations/README.md` first. It has the ground rules for this box
and the **Lab contract** this brief exists to implement.

I want the BeTenshi console to become the place I go to experiment with local
models — every capability, on any of my machines, with the cloud available for
comparison. Six other explorations (image, music, 3D, video, decision models,
BPMN) will each add a capability. This brief builds the thing they plug into, so
they converge instead of each inventing its own page.

**Understand what exists before designing anything.** Much of this is already
half-built and the risk is rebuilding it:

- `src/lib/providers.ts` — `CAPABILITIES` (text, vision, image, stt, tts),
  `resolveCallTarget`, the catalogue read from `config/ai-router.yaml`.
- `config/model-meta.json` — footprints, licences, services per model.
- `config/model-scout.json` + `docs/models.md` — the weekly scout report and
  its rules.
- `src/lib/model-fit.ts`, `src/components/model-discovery.tsx` — "will this fit".
- `src/components/arena-view.tsx` and `compare-view.tsx` — side-by-side runs,
  already local-vs-cloud for text and image.
- `src/components/model-picker.tsx` and `service-control.tsx` — status and
  Start/Stop, the pattern every Lab should reuse.
- `src/lib/db.ts` — has `batch_jobs` and `images`; there is no general record
  of experiment runs.
- The tab list is a hardcoded union in `src/components/command-palette.tsx`
  plus a chain of conditionals in `src/app/page.tsx`.

**What I want out of it:**

1. **A Labs registry.** One declarative entry per capability — id, label, input
   kind, output renderer, which `serves` capability it draws models from — and
   one place that turns entries into tabs and command-palette destinations.
   Adding a Lab should mean adding a component file and one registry line, not
   editing `page.tsx`. New capabilities (music, 3d, video, decision) need
   capability ids that the host profiles can declare.
2. **A runs record.** Every Lab run persisted: capability, model, host, input
   summary, seed, latency, peak VRAM where measurable, output path, and whether
   it was local or cloud. Without this, "compare" means whatever is on screen
   right now and nothing is reproducible. Decide whether it belongs in the
   existing sqlite store.
3. **A generic Lab shell** that implements the contract once — model list with
   footprint/licence/status/Start, a slot for the capability's own input and
   output, latency and VRAM readout, a cloud-comparison toggle, a link to the
   experiment doc. Individual Labs supply only what is specific to them.
4. **Cross-machine by construction.** The same Lab on B5 shows B5's models. If a
   capability has nothing on this host, the Lab says so and says what would fit.

**Constraints:**

- Do not migrate the existing Image, Speech, Arena, SAM tabs onto the new shell
  in this pass unless it is nearly free. Prove the shell with **one** new Lab —
  text is the obvious candidate since everything already exists for it — and
  leave migration as a listed follow-up.
- Keep it small. The user's own observation is that the lab is already better
  than the work done in it; this brief should make experiments cheaper to start,
  not add a layer to maintain.
- The GitHub repo is already `alibad/hangar`, but the app, its directory and its
  UI still say "BeTenshi Console". Do not rename anything in code in this pass;
  that is a separate decision.

**Deliverables:** the registry, the runs record, the shell, one Lab on it, a
short `docs/labs.md` explaining how the next brief adds a Lab (the six other
sessions will read it), and tests for the registry. Commit to `master`.
