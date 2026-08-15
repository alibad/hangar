# Storage Manager

Storage Manager is a local-first disk index and file operations surface at
`#storage`. It does not call an LLM, create embeddings, upload paths, or consume
tokens.

## Data flow

1. `/api/storage` discovers mounted Windows drives with `Win32_LogicalDisk`.
2. A scan launches `scripts/storage-indexer.cjs` in a detached Node process so
   traversing a large drive cannot block the Next.js request loop.
3. The worker records file metadata and recursive folder aggregates in
   `%LOCALAPPDATA%\betenshi\storage\storage-index.sqlite` using SQLite WAL mode.
4. The console reads the cache for the space map, largest folders/files, search,
   duplicate candidates, and Explorer browsing.
5. Optional recursive `fs.watch` workers append filesystem events and update
   known file rows. Directory changes mark the drive dirty so the UI can ask for
   a reconciliation scan.

The cache is outside the repository so dev-server file watching never reacts to
index writes. Only one full scan runs at a time. Scan progress and watcher PIDs
are persisted beside the database, so the UI can recover after a page reload.

## Safety

- Scans are read-only and user-started per drive.
- Watchers can only start after a successful baseline scan.
- Drive roots, Windows, Program Files, ProgramData, recycle bins, paging files,
  and System Volume Information cannot be moved.
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

Stop active scans/watchers first, then remove
`%LOCALAPPDATA%\betenshi\storage\storage-index.sqlite`. The next visit recreates
an empty cache. This does not touch indexed files.
