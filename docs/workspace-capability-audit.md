# Workspace capability audit

The world is a navigation surface over the same repository tools. Visual integration
must not remove actions or hide prerequisites.

## Restored workflows

- Projects without any checkout expose **Clone on this machine** in their Live work
  pane. The user chooses a configured main code root and a new folder. Clone never
  overwrites an existing directory. The backend indexes the checkout before reporting
  completion; starting an agent is a separate action.
- **Start or continue coding** opens a task composer with resumable conversations,
  recorded purpose and next step, checkout state, and recent session evidence.
  Continuing sends the actual provider/session ID. New tasks have an editable draft;
  absent a recorded next step, the draft requests investigation before code changes.
- **Manage islands** creates islands, assigns projects, and hides/restores an entire
  island. Right-click an island or its label to open its controls. Empty custom islands
  appear in management and become visible in the world after projects are added.
  Hiding is reversible and preserves files, sessions, and plan links.
  Island operations now run in Hangar and persist to ignored `var/islands.json`.
  They use the existing project catalog but do not require the scanner's newer
  workspace endpoint or a scanner restart. Each connected machine owns its preferences.
- **Pull repositories** reviews main checkouts before fetching and fast-forwarding.
  Dirty checkouts, active or unobserved Hangar jobs, and diverged branches are skipped
  with results per repository. No forced update, rebase, or merge commit is performed.
- Repository panes retain notes, checkout details, original Git controls and app tools.

## Remaining gaps

- The project engine and renderer now ship inside Hangar. The launcher never
  discovers a sibling checkout or connects to the old Atlas port. Private runtime
  data is in ignored `var/engine`. A clean-room test copies only bundled files and
  verifies synthetic discovery, rendering assets and project inspection.
- Python code changes still require restarting Hangar's bundled engine when no
  managed job or repository operation is running. An in-app safe update flow is
  not yet implemented.
- Task context is an evidence-based editable draft, not semantic certainty about what
  remains unfinished. It does not automatically choose linked PlanQuest milestones.
- Managed coding targets the main checkout; selecting a secondary checkout is not
  yet supported by this composer.
- Workspace operation history is bounded and in memory. It does not recover running
  clone/pull jobs after a backend restart. Do not restart during these operations.
- A physical second-machine acceptance test is still required. Local proxy fixtures
  do not establish that SSH, provider logins and permissions work on another computer.

## Validation

Disposable local workspaces exercise real Git clone, island create/assign/hide/restore,
bulk-pull results, and captured continuation payloads. Browser checks cover desktop
and narrow layouts. Test sessions capture requests without launching an agent.
Private workspace preferences, session contents, and screenshots stay outside source.
