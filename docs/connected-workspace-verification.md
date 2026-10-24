# Connected workspace verification — 24 October 2026

This checkpoint covers the connected workspace, visual identity, embedded Atlas
world, and session organization. It does not certify every existing media studio.

- Production webpack build and TypeScript check pass.
- Hangar's Node suite: 309 passed, one existing skip, no failures.
- Atlas selftest: 54 passed. Session library and topic tests: 16 passed.
- Atlas standalone browser smoke and source leak check pass.
- Browser checks cover actual world rendering, project selection, composer and
  continuation UI, models/machines, light mode, and 320/390/1440px layouts.
- World navigation checks cover search dimming, island selection, Home, expansion,
  live-work presentation and beacons. A Home/search race was found and fixed.
- Session mutations use a disposable backend: unread priority, protection,
  archive/restore, mixed-agent groups, native section moves, snoozing and dialogs.
  No real session was archived or regrouped for these checks.
- A temporary second-node HTTP fixture covers pairing, exact-model forwarding,
  scoped work reads, origin checks, refused remote desktop actions, and connection
  loss. It is removed after the test. No model or agent is started by that fixture.
- Outgoing commits and working source were scanned for credential patterns,
  personal home paths, private network identities and runtime files. Browser
  captures, session metadata and local machine settings stay in ignored folders.

The embedded world was compared against its previous revision at 1440 × 900.
Software rendering measured about 53 versus 54 frames/s during a camera flight,
and zero idle redraws for both. GPU rendering measured about 125 versus 124
frames/s. These are local spot checks, not performance guarantees for other
machines. Added portals use shared geometry and no per-island point lights.

Still required: the physical two-machine SSH connection, exact remote-model
inference and an authenticated remote coding-agent task with continuation.
Follow `second-machine-handoff.md`. PlanQuest currently provides explicit plan
links only, and grouping suggestions use conservative native-title rules.
