# Test Hangar on a second machine

Copy the prompt below into Codex or Claude Code on the other machine. The actual
machine names, credentials, paths and SSH aliases are intentionally not in this
repository. Keep receipts under ignored `var/` or Atlas's `.atlas/`.

> Set up and verify the connected Hangar workspace on this machine. Read this
> repo's instructions and `docs/connected-workspace.md` first. Inspect existing
> checkouts, processes and configuration before changing anything. Preserve
> uncommitted work. Fetch and fast-forward the `main` branches of Hangar and
> repo-atlas; never reset, force-push or create duplicate checkouts. If Atlas is
> inaccessible, report that explicitly; do not substitute an unrelated repository.
>
> Use Node 22+ and Python 3.9+. Run `npm ci`, `npm test`, `npx tsc --noEmit` and
> `npm run build` in Hangar. Run `python3 atlas.py selftest` and
> `python3 -m unittest atlas.session_library_test atlas.session_topics_test` in
> Atlas (`py -3` on Windows). Use the machine's existing host profile; do not copy
> another machine's service registry, paths, credentials or model weights.
>
> Start Atlas on loopback with `python3 atlas.py serve --no-open`; let the owner
> choose repository roots and GitHub authentication if not already configured.
> Start Hangar on loopback using `npm start`. Do not stop an existing listener
> without identifying its owner. Use different explicit ports for isolated tests.
> Verify Projects, World, Sessions, Machines and Models with actual local data.
> Check island selection, search, live-work lens, home/expand controls, dark/light
> themes and narrow layouts. Do not archive or regroup real sessions during tests.
> Check that a project opens a pane without leaving Projects, that Repository
> shows Atlas's full tools, and that building right-click and visible actions
> menus both work. Open All repository tools and verify its filters. Test hiding
> and restoring only with disposable data; never delete a real checkout for QA.
>
> Locate an existing trusted SSH alias for the first machine. Ask the owner only
> if none exists or if SSH installation/admin access is needed. Keep SSH host-key
> checks enabled. Open a loopback-bound tunnel:
> `ssh -o ExitOnForwardFailure=yes -N -L 127.0.0.1:18003:127.0.0.1:8003 your-host`.
> Add that forwarded port in Machines and verify the returned machine identity.
>
> Select the first machine. Verify its project map and model catalogue. With an
> already-running text model, send one short test prompt and confirm the result
> came from that exact machine/model. Do not load a large model without checking
> memory or stop someone else's services. Then use a disposable test repository
> to start one bounded read-only coding task through Hangar, inspect its output,
> verify completion, and continue the resulting session after it is indexed.
> Exercise stop with a separate disposable task only if needed. Do not weaken
> either agent's sandbox or permission settings. Confirm that disconnecting the
> tunnel shows unavailable state and never silently falls back to local execution.
>
> Report exact commits, passed checks, failures, and any steps that still require
> owner input. Keep all session transcripts, screenshots, model responses, SSH
> details and machine-specific config out of Git. Do not publish or deploy fixes
> without reporting the concrete change first.

## What needs real hardware verification

The local integration tests cover a temporary second-node fixture. They cannot
prove SSH reachability, authentication, installed models or agent permissions on
another physical machine. Those are the purpose of this handoff.

PlanQuest now supports OAuth, plan search, milestone previews and explicit project
links. Connect through a project's PlanQuest card on the Hangar host you browse.
Credentials remain on that host; a remote project receives only the selected
plan's title and URL. Test this after approving access; see `planquest.md`.
Hangar never marks milestones complete. The world scopes to one machine at a time;
there is no merged cross-machine filesystem view.
