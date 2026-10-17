# Sequential local workflow verification — 18 October 2026

This pass exercises the redesigned workspaces against the installed local runtimes. Inference jobs run one at a time. No cloud inference, publishing, Forge scheduling, game installation, or production deployment is part of this pass. Existing libraries and game defaults are preserved.

## Results

| Flow | Evidence / result |
| --- | --- |
| Image generation | HiDream-O1 Dev generated a 2048×2048 turquoise teapot in 25.535 s. Saved to Studio Verification; saved-file endpoint returned HTTP 200 and 3,280,252 bytes. |
| Image editing | HiDream-O1 changed the same teapot to coral red in 109.6 s / 40 steps. Shape and scene retained on visual inspection. Saved-file endpoint returned HTTP 200 and 4,543,575 bytes. |
| Image admission | Qwen's 28 GB host-RAM estimate exceeds current headroom. Klein retry refused cleanly: 12.87 GB additional RAM plus 4 GB safety required; 15.57 GB free. Neither was forced past admission. |
| Image download | Saved PNG endpoints and bytes verified. The in-app automation timed out waiting for the data-URL download event; the browser download-button event is not claimed as verified. |
| Video Studio | Correctly reports that video generation is not configured in this host's runtime profile. No substitute runtime or cloud call was forced. |
| Video Lab enqueue | Found and fixed catalogue-alias rejection. The UI request now becomes canonical `wan2.2-ti2v-5b`, 832×480, 121 frames, 24 fps, 5 seconds, seed 20261018. |
| Video admission / cancellation | Job `v_mvczuxte_35ff8b` reached waiting-for-memory with a readable capacity reason, then was cancelled through the UI. No active jobs remained. A fresh video render is still unverified because current RAM is insufficient. |
| Existing video playback | Existing 7.041667-second clip decoded at readyState 4, played, and sought to its end without media error. Range request returned HTTP 206 and the exact requested 1,024 bytes. This is playback verification, not a newly generated clip. |
| 3D object | TripoSR produced a 1,611,744-byte GLB in 6.08 s at grid 256. Viewer reports 80.5K triangles, vertex colours, and a closed surface. Visual turntable/render, library reopening and GLB HTTP 200/header/length verified. |
| 3D person | Existing local dancer fixture copied into a new labelled verification job. SAM 3D Body returned a body and 70 joints in 4.441 s, with 18,439 vertices and 36,874 faces. GLB and pose JSON persisted; pose endpoint returned HTTP 200 and 70 joints. Original fixture/job unchanged. |
| TRELLIS | Draft 512 completed in 77.706 s overall / 73.3 s runtime, saving a 4,776,508-byte textured GLB. Viewer rendered 142.4K triangles and two 1024² textures. Its quality check flags 437 non-manifold edges; it is not print-ready. |
| Pixal3D | Its minimum 1024 reconstruction completed in 177.720 s, saving a 9,809,136-byte GLB. Viewer rendered 289.8K triangles and two 2048² textures. Quality check flags two non-manifold edges; it is not print-ready. |
| Faction Viewer handoff | Hangar's actual button opened revision `77eba4ed-2fda-48dc-b388-da114847299b` on `saudi-arabia/r2m1a2s` at local port 3463. Candidate banner, attack action, current-game comparison, candidate restoration and Clear preview worked without browser errors. |
| Viewer safeguards | The tank revision on Bradley was rejected with current-game sounds retained. A missing revision fell back with a readable message. Changing a draft's gain disabled the handoff; restoring the saved recipe enabled it again. |
| Viewer voice / engine | Saved `am_michael` attack-order take and engine revision loaded as candidates; audition controls exercised. Engine correctly states manual audition, without simulated movement binding. All three preview/WAV endpoints returned HTTP 200, valid RIFF/WAVE bytes and the correct local CORS origin. |

## Repairs found by real runs

- Video Lab received slugged catalogue aliases (`local-wan2-2-ti2v-5b`) while its queue accepted only native ids (`wan2.2-ti2v-5b`). Resolve only declared local aliases, persist the canonical id, and recover editorial metadata from the declared served target. Explicit alias metadata still wins.
- Mounted but hidden labs used the same HTML radio group name. Give each LabShell a React `useId()` group so hidden selections cannot uncheck the active workspace.
- TripoSR's HTTP server became reachable before its model finished loading. Honour explicit `ready: false`, loading, and error health bodies in local model availability instead of treating every HTTP 200 as inference-ready. Opaque/statistics-only health responses retain their HTTP-only contract.
- Initial ComfyUI generation failed with `hostbuf_file_reader_read failed` inside its dynamic loader. During that attempt Windows commit headroom was exhausted, C: dropped below 300 MB, and the Hangar dev server exited. The test runtime was stopped and Hangar restored through its scheduled launcher. This is evidence for this failed test, not a diagnosis of the earlier machine restart.
- Local ComfyUI launch configuration now uses its installed standard loader flags: `--disable-dynamic-vram --disable-async-offload --disable-pinned-memory`. The tracked Windows example matches. HiDream generation/edit completed with those settings; Klein's rerun remained capacity-blocked, so Klein itself is not claimed fixed by a successful generation.
- Preserved ComfyUI's 4.7 GB output directory at `D:/Hangar-local-builds/workflow-verification-20261018/comfy-output`, with a junction at its original `creative-lab/image/ComfyUI/output` path. No output files were discarded. Other applications and system paging settings were not changed.

## Evidence and limits

Local evidence is under `var/workflow-verification-20261018/`: screenshots, saved image responses, GLB, pose JSON, queue/cancellation receipts and baseline service states. Media and machine-specific service-command backups remain ignored by Git.

ComfyUI also logs an existing PuLID custom-node NumPy binary incompatibility. The tested built-in image/video paths do not use PuLID; that extension remains unverified. No global Python package upgrade was attempted.

`npm test`: 305 tests, 304 passed, one existing skip, zero failures. `npx tsc --noEmit` passed. The local webpack production build passed; a separate local instance of that compiled bundle was checked with the normal dev instance stopped. Its API accepted the video alias through to prompt validation (HTTP 400, `A prompt is required`), reported the correct model footprint/licence, and served the saved audio preview (HTTP 200). Its browser navigation retained independent Video/3D radio selections with zero console errors.

All runtime service statuses match the saved pre-test baseline. Video's test job is cancelled, with no active queue entries. The temporary viewer and compiled-app servers were stopped; Hangar's normal scheduled local server was restored. No new changes have been pushed or deployed in this pass. Fresh video generation, Qwen generation/batch, and a successful Klein retry remain unverified because of memory constraints; Forge automation was not resumed.

The radio-group repair was also verified across actual navigation: Pixal3D remained checked in the visible 3D Lab while the hidden Video Lab independently retained Wan 5B. The original Effects `Local sound study` draft was restored after integration testing. The local viewer helper was stopped after testing; no RTSAI-Web source files changed (tested commit `d43e3b9d4acf6d32e6ab49cfc21f251c465b5434`).
