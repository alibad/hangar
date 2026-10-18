# Creative workstream controls — 18 October 2026

The local UI pass replaces cramped, inline labels and small fields with the
existing shared field and themed picker components. It covers Voices & Speech,
Speech Recognition, Image Studio, Video Studio, Video Lab, Video Forge, Mask &
Segment, and 3D Lab. Effects was checked because it shares the field components.

## Changes

- Visible labels above text, number, and picker controls; consistent spacing,
  focus states, disabled states, and wrapping action rows.
- Script and image dictation buttons sit inside the input area, below its label.
- Image generation, editing, batch, comparison, and evaluation forms use the
  same field components. Blank numeric drafts recover on blur rather than
  propagating zero or an invalid value.
- Image batch dimensions use a Base UI popover with viewport collision handling,
  focus management, Escape/outside dismissal, themed nested pickers, and named
  switches. The previous manually positioned popup could extend behind the header.
- 3D image creation and cutout are separate steps; library search and set filters
  have labels. Video starting-frame creation and shot settings have separate fields.
- Light and dark mode use existing palette tokens. Phone controls wrap and stack;
  no visible native HTML select was added.

Generation handlers, endpoint contracts, model options, seeds, source modes,
queue actions, uploads, recording, review actions, and existing galleries remain
connected to their original state and callbacks. No backend or inference logic
was changed. No existing asset was deleted.

## Local verification

- `npm test`: 307 total, 306 passed, one existing skip, zero failures.
- `npx tsc --noEmit`: passed.
- `npm run build` (isolated local output directory): passed. The scheduled console
  was paused for the build and restarted afterward. The pre-existing Next.js
  middleware deprecation warning remains; generated TypeScript path changes were
  excluded from the source changes.
- Desktop and 390px phone previews checked in light and dark mode. DOM checks
  found no horizontal page overflow or visible native select on the reviewed
  speech, image, video, 3D, and segmentation pages.
- Image size picker: keyboard selection works; original dimensions restored.
  Steps: clearing and blurring restores the prior value; valid edits work.
- Image Generate/Edit/Compare/Eval navigation checked; edit instructions and
  comparison prompts retain their handlers. Batch variation options and the
  nested dimension picker open on desktop and phone. Popover bounds stay within
  the viewport; Escape dismissal works.
- Arabic script displays right-to-left using `dir="auto"`. Switching between
  Voices and Speech Recognition preserves the script draft.
- Video Lab: image/text source modes switch; invalid seed is marked and prevents
  queueing. The quality picker opens with the existing low/high choices.
- 3D: subject/seed editing, image model selection, object/person modes, library
  search, and set picker checked. Person mode still defaults to photo upload.
- Effects: source-free generation form and its shared fields still render.
- Temporary viewport overrides and edited QA drafts/settings restored.

Screenshots and check logs are kept locally in
`var/controls-spacing-verification/` (ignored by Git).

## Scope and limits

This pass verifies rendering, form interaction, existing automated checks, and
local compilation. No fresh GPU generation, cloud inference, microphone capture,
voice enrollment, or Forge automation was started. Those operations retain their
existing handlers but were not rerun end-to-end during this UI pass. Heavy local
runtimes were stopped during inspection; Video Studio reports its existing
unconfigured runtime state. Previous media workflow checks are recorded in
`workflow-verification-2026-10-18.md`.

No push, deployment, or hosted CI change is part of this pass.
