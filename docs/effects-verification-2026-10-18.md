# Effects verification — 18 October 2026

Completed locally, with no push, deployment, package installation or model download.

- Generated a 1.2-second glass chime through the real Effects UI from text only,
  seed 41. Saved revision `2eff0f46-dd15-4e90-a367-eab660f11e86`, stereo PCM16
  WAV at 48 kHz, −2 dBFS sample peak. Playback entered its playing state.
- Reduced the layer to −3 dB and saved a separate variation at −5 dBFS.
- Imported a recording through the file picker with a blank source note. The
  server recorded “Source not specified”; the existing layer was retained.
- Generated an additional 0.8-second layer, seed 42, through the final worker
  implementation. Both existing layers and the 1.2-second mix length remained.
- Restarted the console, recovered the three-layer draft, rendered its mix and
  saved review notes. Library, Compare and Jobs remained reachable.
- Concurrent generation was refused. Cross-origin generation returned 403;
  malformed requests returned 400. Temporarily absent runtime configuration
  reported unavailable, then recovered when the original file was restored.
- Both generation workers exited. No GPU service was started or stopped.
- Faction Viewer entry stayed disabled for an unsaved example and enabled after
  loading an exact saved tank revision. Full viewer audition was previously
  verified in `workflow-verification-2026-10-18.md`; it was not repeated here.

Visual checks covered desktop, 1033-pixel width and a 390-pixel phone, with light
and dark themes. Expanded themed pickers were inspected on desktop and phone;
arrow-key/Enter selection worked. Form labels had 6–9 pixels of separation from
their fields. The phone page had no horizontal overflow or visible native select.
The final browser session had no captured errors or warnings. Evidence and test
outputs are kept locally under `var/effects-ux-verification`.

Validation: 307 tests total, 306 passed, one existing skip, zero failures;
TypeScript passed; `npm run build` completed successfully. The normal local
console is restored on port 8003. Generation is configured only for this host’s
existing offline environment; other hosts retain import/editing and an explicit
unavailable state until configured.
