# Connected workspace

Hangar ships its project engine in `engine/hangar_engine` and its 3D renderer in
`engine/world`. It runs independently: no private repository, sibling checkout,
Atlas process or Atlas installation is required.

## Local setup

Install Node 22+, Python 3.10+ and Git. Run `npm ci`, then `npm run dev` (or
`npm run build` and `npm start`). Opening World starts the bundled Python engine
on loopback port 7789 automatically. `node scripts/start-engine.mjs` starts it
explicitly. Set `HANGAR_ENGINE_PYTHON` to a Python executable if needed;
`HANGAR_ENGINE_PORT` changes the engine port.

The first scan discovers common code folders under your home directory. Review
`var/engine/roots.json` to choose roots, canonical root IDs, scan depth and GitHub
owners. Run `python engine/main.py scan --local` for local-only discovery, or
use Rescan in All repository tools after changing roots. GitHub CLI (`gh auth
login`) adds your accessible GitHub inventory; an unavailable GitHub connection
leaves local discovery working.

All catalogs, machine paths, notes, plan associations, caches and session metadata
live under ignored `var/engine/`. Category preferences are in `var/islands.json`;
paired machines are in `var/fleet.json`. `HANGAR_ENGINE_DATA_DIR` overrides the
engine storage directory. Never commit runtime files.

Existing users can optionally run `node scripts/import-atlas.mjs <old-checkout>`
once to copy allowlisted catalog/preferences into private Hangar storage. It
never overwrites existing Hangar files and never copies credentials or live jobs.
The source remains untouched; it is not used at runtime.

## A second machine

Install this Hangar version on that machine. Authenticate
the desired coding agents there. With an already configured SSH host alias, run:

```sh
ssh -o ExitOnForwardFailure=yes -N -L 127.0.0.1:18003:127.0.0.1:8003 your-host
```

In Machines, enter its name, SSH alias and forwarded local port. Hangar verifies
that a different machine answers before saving the entry. Select that machine
in the persistent machine rail. Its bundled engine supplies its own map, checkouts, apps,
history and managed jobs; its Hangar supplies its model catalogue and inference.
Models are selected per request without changing either host's global routing.

SSH owns authentication and host-key verification. This feature does not install
SSH/Tailscale, edit firewall rules, copy keys or expose an unauthenticated LAN
listener. Both services remain on loopback. Closing the SSH tunnel makes the
machine visibly unavailable. Remote desktop-window actions are refused; managed
coding jobs return their output to the requesting Hangar.

## What the states mean

- **Running app:** Hangar observed a listening process and matched it to a project.
- **Running coding job:** this Hangar engine started and still owns that process.
  At most two jobs run at once, and only one per checkout. Stop targets that job's
  process tree. Existing permission/sandbox settings remain in force.
- **Session history:** private Claude/Codex metadata. Successful edit operations
  match the deepest containing checkout; cwd is explicitly labeled as fallback.
  Shell edits and tools that do not emit structured file changes may be missed.
  State records the last observed turn, never inferred live process status.
- **Unobserved job:** The engine restarted while a job was active. Its process may
  remain alive; inspect it externally and explicitly acknowledge it before
  launching another writer in that checkout.
- **Plan link:** an explicitly chosen PlanQuest plan. Connect once with OAuth,
  search active plans, preview milestones and link the verified plan to a project.
  Hangar reads plan content but never writes milestone progress. See
  [PlanQuest connection](planquest.md) for setup and agent tools.

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

## Project panes and actions

Selecting a project opens a pane in the current World or Projects view. Live work
holds jobs, sessions and PlanQuest; Repository restores Hangar's notes, district
assignment, checkout/editor actions, app controls, commits and Git changes. This
pane reuses Hangar's repository interface without starting a second WebGL renderer.
It is included in Hangar.

Right-click a building, project tile or explorer row, or use its visible actions
button. Focus marks important work; Park means relevant but later, on the same
category's island. Off the map hides irrelevant work from the map and ordinary
lists; the Off the map filter lets you restore it. These actions save
local Hangar metadata only: they never delete a checkout, GitHub repository or session.

All repository tools restores Changes, Apps, All, Focus, Here, Not here, Shipped,
Parked, Off the map and Spare folders, including rescan and Hangar's checked pull/push
operations. History & replay exposes project arrivals by creation date (not historical code snapshots); Activity and Shipped
lenses remain available. Remote desktop and app-launch controls remain restricted
to their host; use Live work for managed remote coding jobs.

## Public source and handoff

Standard dev/start commands bind to loopback. Never expose the unauthenticated
local console on a LAN or public tunnel. Use the explicit SSH forwarding above.
Before publishing changes, run `node scripts/check-public-source.mjs origin/main`;
it checks every outgoing commit as well as the working tree and reports matching
file names without printing secret values. Manually review screenshots and prose.
Private `var/`, environment files and captures remain ignored.

Use `docs/second-machine-handoff.md` for the other machine. Production compilation,
automated tests and a disposable second-node fixture do not replace that physical
two-machine verification.

## Organize and inspect projects

Review categories presents the entire catalog, including hidden projects, with
purpose, current category and a persistent reviewed state. Filter by category,
select shown projects, and move irrelevant work off the map in bulk before sorting
anything. On the map, Needs review, Off the map and All projects are separate views.
Visibility, work status and category are independent: hiding or parking never
erases a chosen category. Hidden projects are excluded from map island counts.
The old age/origin/status buckets (Attic, Workshop, Borrowed, Vendor yard, Off the
map, Focus and Parked) no longer define islands. Unassigned projects are
Uncategorized; age, forks and local-only provenance do not imply irrelevance.
Existing purpose categories and name-based suggestions stay available for review.
Select projects, choose
or create a destination, inspect the preview and Apply category. Keep categories
marks reviewed without moving anything. Manage islands can hide/restore a whole
island; this never deletes files, sessions or plan links. Individually hidden
projects remain hidden when the island is restored.

Project panes include Architecture and Timeline. Architecture shows an
[Archify](https://github.com/tt-a1i/archify) drawing of the project. Nothing is
drawn until you press Draw: then Claude Code or Codex, signed in with your own
account, reads the checkout and replies with an Archify candidate. Hangar saves
it, runs Archify's checks (validation, source evidence pinned to the current
commit, a real-browser readability check) and sends the problems back for up to
two repairs. A drawing replaces the previous one only after it passes. The run
only reads: Claude gets reading tools only; Codex is asked to read only, but its
sandbox is not enforced on every platform. Drawings stay in local engine storage
(`var/engine/architecture/`) and open in a sandboxed frame with no network. Install
the skill once with `npx skills add tt-a1i/archify -g`; Node.js runs its checks.

The world can be drawn in two styles, chosen under World style in the theme
picker: Buildings (a city of lots, houses and towers) or Airplanes (a hangar of
gliders, prop planes, jets and jumbos). Both use the same facts: stage sets the
size, the island colour the paint, recent work the lit windows. The choice is
kept per browser, and switching it swaps the models in place.

Timeline groups local Git history across refs into monthly chapters with commit
subjects and local tags. It includes up to 20,000 commits; absent remote history
needs a fetch. Both views require a checkout on the selected machine.

Run `python engine/selftest.py` for an isolated engine test: it copies only the
bundled source into a temporary directory, creates a synthetic repository and
checks discovery, HTTP, architecture, chronology and origin restrictions. No
Atlas checkout or service is consulted.
