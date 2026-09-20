# Storage Manager

Storage Manager is a local-first disk index and file operations surface at
`#storage`. It does not call an LLM, create embeddings, upload paths, or consume
tokens.

## Data flow

1. `/api/storage` discovers mounted Windows drives with `Win32_LogicalDisk`, or
   the macOS root and visible `/Volumes/*` mounts with native
   filesystem probes.
2. A scan launches `scripts/storage-indexer.cjs` in a detached Node process so
   traversing a large drive cannot block the Next.js request loop.
3. The worker records file metadata and recursive folder aggregates in the
   local application-data directory using SQLite WAL mode: `%LOCALAPPDATA%` on
   Windows or `~/Library/Application Support/Hangar/storage` on macOS.
4. The console reads the cache for the space map, largest folders/files, search,
   duplicate candidates, and indexed-file browsing.
5. Optional recursive `fs.watch` workers append filesystem events and update
   known file rows. Directory changes mark the drive dirty so the UI can ask for
   a reconciliation scan.

The cache is outside the repository so dev-server file watching never reacts to
index writes. Only one full scan runs at a time. Scan progress and watcher PIDs
are persisted beside the database, so the UI can recover after a page reload.
Tests and isolated installations can override that directory with
`HANGAR_STORAGE_STATE_DIR`.

## Safety

- Scans are read-only and user-started per drive.
- Watchers can only start after a successful baseline scan.
- Drive roots and protected operating-system/application paths cannot be moved.
  Windows additionally guards Program Files, ProgramData, recycle bins, paging
  files, and System Volume Information. macOS guards `/System`, `/Library`,
  `/Applications`, `/usr`, `/bin`, `/sbin`, `/private`, and their descendants.
- A macOS scan never crosses into another mounted filesystem; each visible
  `/Volumes/*` mount is indexed independently.
- Name conflicts fail by default. `Keep both` is an explicit opt-in.
- Same-volume moves use an atomic rename when possible.
- Cross-volume moves copy first and remove the source only after the copy
  succeeds.
- The UI labels same-size duplicate groups as candidates; it never presents
  them as hash-proven duplicates or deletes them automatically.

## Files

- `scripts/storage-indexer.cjs` — background scanner, watcher, and move worker
- `src/lib/storage-index.ts` — drive discovery, cache queries, and worker control
- `src/app/api/storage/route.ts` — local API used by the console
- `src/components/storage-manager.tsx` — Storage Manager UI

## Cache reset

Stop active scans/watchers first, then remove the storage database from the
platform application-data directory. The next visit recreates an empty cache.
This does not touch indexed files.
