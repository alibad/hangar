# Connected workspace

Hangar now opens on Atlas's actual project world. Atlas remains a separate Python
engine and vendored Three.js viewer; Hangar supplies the navigation, machine scope,
project inspector, job controls and model access. Existing studios and resource
controls remain available.

## Local setup

Run Hangar locally and install `repo-atlas` beside it. The supervisor's `atlas`
entry runs `scripts/start-atlas.mjs`; set `ATLAS_REPO_DIR` if the checkout is
elsewhere. `ATLAS_PYTHON` and `ATLAS_PORT` can override the Python launcher and
loopback port. For Windows installations with an existing ignored
`scripts/service-commands.json`, add the `atlas` entry from the example.

Atlas uses its own ignored `.atlas/` directory for repository roots, session
metadata, project-plan links and job history. Hangar stores paired machine ports
in ignored `var/fleet.json`. Neither belongs in Git or in a public deployment.

## A second machine

Install this Hangar version and this Atlas version on that machine. Authenticate
the desired coding agents there. With an already configured SSH host alias, run:

```sh
ssh -o ExitOnForwardFailure=yes -N -L 127.0.0.1:18003:127.0.0.1:8003 your-host
```

In Machines, enter its name, SSH alias and forwarded local port. Hangar verifies
that a different machine answers before saving the entry. Select that machine
in the persistent machine rail. Its Atlas supplies its own map, checkouts, apps,
history and managed jobs; its Hangar supplies its model catalogue and inference.
Models are selected per request without changing either host's global routing.

SSH owns authentication and host-key verification. This feature does not install
SSH/Tailscale, edit firewall rules, copy keys or expose an unauthenticated LAN
listener. Both services remain on loopback. Closing the SSH tunnel makes the
machine visibly unavailable. Remote desktop-window actions are refused; managed
coding jobs return their output to the requesting Hangar.

## What the states mean

- **Running app:** Atlas observed a listening process and matched it to a project.
- **Running coding job:** this Atlas server started and still owns that process.
  At most two jobs run at once, and only one per checkout. Stop targets that job's
  process tree. Existing permission/sandbox settings remain in force.
- **Session history:** private Claude/Codex metadata. Successful edit operations
  match the deepest containing checkout; cwd is explicitly labeled as fallback.
  Shell edits and tools that do not emit structured file changes may be missed.
  State records the last observed turn, never inferred live process status.
- **Unobserved job:** Atlas restarted while a job was active. Its process may
  remain alive; inspect it externally and explicitly acknowledge it before
  launching another writer in that checkout.
- **Plan link:** a user-confirmed HTTPS PlanQuest link. It reads no plan content
  and writes no milestone progress. Authenticated milestone synchronization is
  not implemented.

Project Git state shows its scan age; ahead counts refer to the last fetch.
The map currently scopes to one selected machine at a time. There is no merged
cross-machine Git state, session migration or background command mailbox.

## Validation

`npm test` includes fleet boundary tests. `npx tsc --noEmit` checks types.
`scripts/check-connected-workspace.mjs` exercises the real viewer, project
selection, task composer, continuation, machine/model views, light mode and
320/390/1440px layouts. `scripts/check-fleet-transport.mjs` uses a temporary
second-node HTTP fixture to exercise pairing and forwarding without starting
an agent or model. The fixture is removed in `finally`.

Both browser scripts accept `HANGAR_URL`. The UI script accepts `PLAYWRIGHT_CORE`
and `CHROMIUM` paths. Captures are private under `var/fleet-qa/`.

A real local inference request through the fleet endpoint returned `READY` from
the already-running `local-gemma4` model on the local host. An actual second-machine SSH
connection and an authenticated coding-agent run still require end-to-end
verification on the intended machines. Fixtures do not substitute for those checks.

## Session organization

Sessions includes an archive review queue (seven idle days by default), unread
priority when Codex exposes a receipt, seven-day snoozing and reversible archives.
Nothing is archived on a timer. Missing read state stays unknown. Pinned sessions
and projects with active/unobserved Hangar jobs are protected. Idle means no
observed transcript/native activity or explicit Hangar open/review; visits in
other apps cannot all be observed.

Groups & sections mirrors native Codex sections and adds shared Hangar groups for
both agents. Suggestions first use native session titles to propose broad work topics across
repositories and agents. These are conservative local keyword rules, not an LLM
reading the full conversation. Ambiguous titles abstain; a single-project edit or
working-folder match is an explicitly labeled fallback. No transcript bodies are
stored for grouping or sent to a model. Claude custom titles are preserved. Accepting a
suggestion changes Hangar only. Explicit “Move in Codex too” and “Archive in Codex
too” actions use the native Codex app-server protocol. Claude grouping/archiving
is a Hangar overlay; its original transcripts remain untouched. New activity
resurfaces a Hangar-archived session. Metadata is private to the selected machine.

`tools/session-library-fixture.py <port>` in Atlas creates a disposable backend
for `scripts/check-session-library.mjs`. Set `SESSION_FIXTURE_URL` if its port is
not 7791. The browser test covers unread ordering, protection, archive/restore,
native section moves, mixed-agent groups, snoozes and phone layouts. All mutations
stay in that temporary fixture. Native Codex section reads were also verified
against the installed app; real user sessions were not archived or moved by tests.

## Identity and world navigation

The default palette is Hangar cobalt with basalt surfaces and warm portal light.
Existing explicit palette choices remain available. Foundry Island is the primary
logo in the app header, installation icons and world entrance. Its faceted blue
rock and warm doorway connect the identity to the actual island world. See
`docs/brand.md`.

Search dims unrelated buildings. Island chips focus a district; Home restores
the whole map; Expand gives the world more space. Live work highlights only jobs
observed by Hangar, including warm island beacons. Running apps have separate
labels. A failed 3D renderer offers the project list instead of a permanent spinner.
Keyboard search, focus states, reduced motion and light graphics remain supported.

## Public source and handoff

Standard dev/start commands bind to loopback. Never expose the unauthenticated
local console on a LAN or public tunnel. Use the explicit SSH forwarding above.
Before publishing changes, run `node scripts/check-public-source.mjs origin/main`;
it checks every outgoing commit as well as the working tree and reports matching
file names without printing secret values. Manually review screenshots and prose.
Private `.atlas/`, `var/`, environment files and captures remain ignored.

Use `docs/second-machine-handoff.md` for the other machine. Production compilation,
automated tests and a disposable second-node fixture do not replace that physical
two-machine verification.
