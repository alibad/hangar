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
ssh -N -L 18003:127.0.0.1:8003 your-host
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

An actual second-machine SSH connection and an authenticated agent/model run
still require end-to-end verification on the intended machines. Tests do not
substitute for that verification.
