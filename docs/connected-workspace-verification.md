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
Follow `second-machine-handoff.md`. Grouping suggestions use conservative
native-title rules.

## PlanQuest connection upgrade

Production build and TypeScript checks pass. The Node suite now has 317 passing
tests and one existing skip. Eight new tests cover OAuth PKCE, browser-bound and
single-use state, expiry/denial, serialized refresh rotation, revoked access,
MCP transport, canonical plan URLs and the agent lookup/link contracts.
Live local API checks reject cross-origin requests, unauthenticated plan reads,
mutations without the intent header, and malformed plan IDs.

Browser checks used isolated sample plans to verify search, milestone previews,
explicit linking and responsive layouts at desktop and 390px phone width, in
light and dark themes. No real project link was changed for these checks.
PlanQuest discovery was checked against the live provider. A real account consent
and authenticated plan lookup are still required; fixture tests do not prove them.

## Project usability restoration

- Hangar production build passes; Node suite: 317 passed, one existing skip.
- Atlas selftest: 55 passed, including a temporary-storage Focus → Park → Hide →
  restore round trip that preserves notes and checkout metadata.
- Browser checks cover right-click on an actual world building and project tile,
  visible actions buttons, keyboard menu navigation, cancellation of removal,
  in-place repository panes, original tool filters and desktop/390px layouts.
- A browser-only disposable project verifies Focus filtering, confirmed hiding,
  Hidden recovery and restoration. Its writes are intercepted and never reach
  Atlas. The fixture is removed by reloading; real projects are not modified.
- The HTTP transport fixture verifies the restored Git route rejects malformed
  requests and arbitrary delete routes remain unavailable. No real Git mutation,
  app start/stop, project removal or session mutation is performed for QA.
- Repository panes synchronize with light/dark themes. Screenshots remain local
  in ignored runtime storage. The world, repository tools and live-work pane use
  the same project identity; the repository pane starts no second 3D renderer.
