# Bundled project engine

Hangar owns this engine and its world renderer. It has no runtime imports,
filesystem lookup or HTTP dependency on another application's checkout.

- `main.py`: Python 3.10+ launcher; standard library only.
- `hangar_engine/`: local discovery, Git operations, sessions, managed jobs and
  project evidence APIs. Bind to loopback only.
- `world/`: the renderer and repository pane. Three.js is vendored with its MIT
  license in `world/vendor/three/LICENSE`.
- `selftest.py`: disposable clean-room integration tests, including a real
  synthetic Git history and HTTP server.

Runtime data defaults to ignored `var/engine/` at the Hangar root. No catalog,
project notes, machine roots, session data or credentials are shipped here.
`HANGAR_ENGINE_DATA_DIR` selects an alternative private directory.

Run `python engine/selftest.py` to verify independence. The test copies only
this directory to temporary storage, so it cannot fall back to a sibling
repository. See `docs/connected-workspace.md` for setup and privacy boundaries.
