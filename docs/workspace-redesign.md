# Hangar workspace redesign

## Direction

Use the light Workbench proposals as the common product language: compact grouped navigation, quiet paper surfaces, consistent page headings, readable controls, and a primary task beside a contextual inspector. Use the larger canvas from the Studio proposals for media review. Theme is a preference, never an alternative layout. Existing light/dark modes and palettes remain supported.

Hangar is a general-purpose AI workspace. RTS AI, the tank pilot, the relocation simulation, and other experiments are example projects. They must not define the app shell or become required integrations. Existing experiments and their saved work remain accessible.

## Preservation scope

| Destination | Preserve and improve |
| --- | --- |
| Home | Tool entry, prompt handoff, recent work, capacity details, requests |
| Effects | Layers, imports, processing, A/B, revisions, review, optional external audition |
| Voices & Speech | Neural synthesis, voice library/cloning, existing project experiments |
| Speech Recognition | Microphone/file capture, model/language, transcript review |
| Music | Prompt/lyrics, generate, extend, repaint/remix, stems, gallery |
| Image Studio | Generate/Edit/Batch/Compare/Eval/Jobs, Activity, galleries, models |
| Video Studio | Existing single-clip generation and saved outputs |
| Video Lab | Source stills, motion settings, model choice, persistent job queue |
| Video Forge | Research, briefs, storyboards, generation, output review |
| Mask & Segment | Images, video tracking, masks, boxes, scores, downloads |
| 3D Lab | Object/person modes, models, orbit review, comparisons and library |
| Chat & Code | Context toggle, conversation, model, thinking, tokens/latency |
| Model Arena | Shared prompt, model comparisons, scores and metrics |
| Decision Lab | Typed choices, probabilities, calibration and benchmarks |
| Process Lab | Existing simulation, cases, diagrams, rules, human tasks |
| Services | Ownership, start/stop/restart, logs, memory, active jobs |
| Models | Discovery, fit, downloads, capability routing, local/cloud distinction |
| Requests | Filters, noise/hops, stable identities, payload/error inspection |
| AI Usage | Router, Codex and Claude views, date/model/provider/group filters |
| Storage | Drives, file exploration, duplicates, reveal and guarded moves |

## Delivery and verification

Work on the canonical main checkout; preserve data and backend contracts. Commit cohesive progress. Verify local type checks, regression tests and production build; inspect all destinations, expanded pickers, both themes, collapsed/expanded navigation and responsive layouts. Do not start paid/cloud inference for visual QA. Capture evidence and record limits in design-qa.md before completion. The generated proposal copy is illustrative, not an API or capability specification.

## Implemented workspace system

All destinations use the shared palette, navigation, type hierarchy and responsive content rules. The task stays prominent; runtime detail and research use contextual panels or disclosures. Effects starts with general sound drafts, with the existing tank and voice takes available as examples. Speech synthesis and recognition remain separate destinations. Recognition adds editable transcript review and copying. Services offers both a list with an inspector and the original cards.

Existing media, queues, routes, experiment integrations and storage contracts remain in place. No model is started by opening a redesigned page. The generated proposals include illustrative content and capabilities; only existing product functions and the changes described above are shipped.

The local review covers all 20 destinations in light and dark, expanded and collapsed navigation, phone layouts, themed picker popups, keyboard selection and Arabic script direction. Effects import/render/playback/export and local neural speech are exercised with real files. GPU-heavy image/video/3D generation and paid providers are outside this presentation regression pass. An unavailable runtime stays unavailable; verification gates are retained.

`scripts/make-workspace-walkthrough.py` produces a local narrated walkthrough from the review captures using Kokoro `am_michael` and FFmpeg. Its media output stays ignored by Git.
