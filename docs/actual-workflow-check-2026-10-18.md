# Actual workflow check — 18 October 2026, afternoon

Status: **blocked by Windows memory pressure before inference**. This is not a
successful fresh-generation verification and does not supersede the earlier
workflow results or the UI-only verification.

## Story and boundary

Test the actual local Voices → synthesis result, Speech Recognition → editable
transcript, Image Studio → saved image, Video Lab → saved/playable clip, and 3D
Lab → saved/viewable mesh flows, sequentially. No cloud calls or parallel model
loads are permitted in this pass.

The checkout was clean at `5a3bda1`; `origin/main` was fetched and safely checked
before testing. Existing heavy runtimes were stopped. The initial GPU had about
27 GB free VRAM and Windows reported about 26 GB free physical RAM. However,
Windows' committed-memory headroom was already only about 9 GB and continued to
fall during the session.

## Attempts and evidence

| Workflow | This pass |
| --- | --- |
| Voices | Selected the installed local Kokoro neural TTS model in the UI. Two bounded startup attempts never reached health readiness. The first was stopped near the Windows allocation limit. The retry was stopped by the explicit 2 GB commit-headroom guard when measured headroom was only 0.34 GB. No speech request or output was produced. |
| Speech Recognition | Not run: no further model loading while allocation headroom is below the guard. |
| Image | Not run for the same host-memory blocker. |
| Video | Not run for the same blocker; no clip queued or left waiting. |
| 3D | Not run for the same blocker; no mesh job created. |

Kokoro's captured startup log contains a PyTorch platform warning and then the
intentional termination. It does not establish a synthesis error or an app UI
regression. No crash or machine restart was observed during these attempts.

After stopping the test runtime, memory remained under pressure: the final check
showed about 11.32 GB available physical RAM and 1.19 GB committed-memory
headroom. Stopping our model did not restore the initial host headroom, so this
pass cannot safely proceed by merely switching models.

Local receipts are in `var/actual-workflows-20261018/` (ignored): baseline/final
service states, memory measurements, startup logs, and a screenshot. All service
statuses match the saved baseline. The original speech-model selection was
restored, temporary offline/logging flags were removed, and the GPU claim was
released. Other apps and Windows paging settings were not changed.

## Continuation

After the owner frees memory, rerun the local UI flows in this order:

1. Kokoro with `am_michael` (or its `onyx` alias), save and decode a short WAV.
2. Stop Kokoro; upload that WAV to local Whisper and compare the transcript to
   the known script, then stop Whisper.
3. Generate one small image with an installed local model; inspect/save it, then
   stop the runtime.
4. Generate one short local video through Video Lab; verify the MP4 and playback,
   then stop the runtime. Video Studio's host profile remains unconfigured and
   must be reported separately.
5. Use the saved image in a new TripoSR job; inspect the mesh, download endpoint,
   and library reopening, then stop the runtime.

Recheck both physical RAM and committed-memory headroom before every load. The
video test alone is budgeted at about 20 GB host RAM plus the existing safety
reserve. Do not force admission, close unrelated apps, or modify paging settings
to bypass this blocker. No push or deployment is part of this pass.
