# Hangar roadmap

Hangar is this console (the GitHub repo is `alibad/hangar`; the code still
says BeTenshi Console). It runs the shared box: the service manager on
`:8099`, the resource control plane (docs/resource-control.md), the Labs and
Video Forge. This roadmap was started on 2026-10-03 from what one day of
shared-GPU trouble showed (2026-10-02); add other tracks here as they form.

## What happened on 2026-10-02

One afternoon of Move Quest motion capture ran into everything else on the
card:

- quote-forge's drip kept qwen (Qwen-Image) busy for hours. qwen held
  20.8 GB in `model_offload` mode and ran at about 195 s per step on the full
  card, against about 5 s on a free one. The AI router timed out, the drip
  retried every 15 s, and every retry got a 500 (qwen's "busy" reply crashed
  its OpenAI endpoint). Nothing was produced, and nothing said so.
- SAM 3D Body hit a CUDA OOM and stayed up but broken (even `/health`
  raised 500) until it was restarted by hand.
- Mocap extraction ran at 2.4 s per frame instead of 0.21, because SAM 3D
  Body shares the `gpu-heavy` slot with qwen's slow steps.
- Stopping ComfyUI to make room freed nothing: it held almost no VRAM.
- Minutes after qwen was stopped, another Claude session (OpenRA-AI) started
  it again. Finding out who took two process-tree walks; the manager does not
  record who asks for a start.

## Next

- **One scheduler for the card.** Today four mechanisms coordinate the GPU,
  each honoured by only some tools:
  - the claim file `AI/logs/gpu-claim.txt` (mocap, Video Forge);
  - manager leases on the `gpu-heavy` slot (inside the services);
  - Video Forge's windows, with `keepOffInWindow` and vllm-small reclaim;
  - client auto-start: quote-forge's drip starts qwen whenever it runs, and
    sessions start services directly.

  Make the manager the single place to book the card: claims become manager
  reservations, with an owner, a reason and an expiry, shown under
  Stack → Work scheduler. Keep the claim file only as a mirror for older
  tools, and have starts that would evict a reservation refuse with the
  holder's name.
- **Who started what.** Record the caller of every start and stop (as leases
  already record `owner`), keep it in the event log, and show it beside each
  service.
- **Hold, not just stop.** A stop is undone within minutes by any client that
  auto-starts the service. Add a hold: stopped, starts refused with a reason,
  plus an owner and an expiry. The forge's `keepOffInWindow: ["qwen"]` is one
  case of it.
- **Real VRAM per service.** Windows (WDDM) hides per-process GPU memory,
  but qwen, SAM 3 and SAM 3D Body report `process_mb` on `/health`. Collect
  it, show it next to the measured figure in `config/model-meta.json`, and
  show what stopping a service would free before it is stopped.
- **Degraded-service alarm.** Keep a throughput baseline per workload (s per
  step, s per frame) and flag a service running far below it, with the likely
  cause: offload mode, a full card, or the slot held by someone else.
- **Error-storm alarm.** Flag a service whose responses have all been errors
  for N minutes, and name the caller from the Requests attribution. The qwen
  500s ran for hours unseen.
- **Restart what is broken.** Treat repeated health failures as unhealthy and
  restart with backoff (sam3d after its OOM), instead of reporting it
  running.
- **Refusals must not crash.** Every service's busy or over-budget path
  should return a proper status (409/503 with Retry-After). Add a contract
  test per service; qwen's failed this (fix tracked in quote-forge's
  ROADMAP.md).

## Rules this taught

- Book the card before GPU-heavy work, and say who you are. Other sessions
  have frozen ComfyUI and restarted qwen mid-job by skipping this.
- Before stopping something to make room, check what it actually holds.
- Look at what a service produces, not only whether it is up.

## Repo and deploy track

Started 2026-10-08. The production deploy of `master` had failed since
9baf5ae (a route file exported a helper); the cloud image parameters work had
sat uncommitted in master's checkout for five days while a copy of it waited
on an unpushed branch; and GitHub's default branch turned out to be a
different line of work.

### Next

- **One line of development.** GitHub's default branch is `main`, the public
  Hangar line: the rename, hosted mode, Mac support, the pre-publication
  cleanup (9651e71) and the weekly scout PRs. It split from `master` on
  2026-09-18 (30 commits against 115). Vercel production builds `master`.
  Decide which one is Hangar: merge `main` into `master` (182 files), or keep
  the operator console somewhere private. Then make it the default branch and
  point the scout routine (and PR #2) at it. Until then `master` still tracks
  what 9651e71 took out (design-qa-artifacts/, scripts/service-commands.json),
  in a public repo.
- **Three finished worktrees to remove**, all clean and merged:
  `../betenshi-console-video` (video-forge), `../betenshi-console-wt-cloudimg`
  (feature/cloud-image-params) and `.claude/worktrees/vigilant-shtern-1ba9f3`.
  Their only unique files are two test images and a regenerated routing file.
- **A build check before a push.** Nothing ran the production build before
  9baf5ae went out; a pre-push hook or CI job running it would have caught it.

### Rules this taught

- `next dev` skips the production type check. A route file may export only
  its handlers and route config; anything else (`export function groupLabel`)
  works in dev and fails on Vercel. Build before pushing:
  `BETENSHI_DB_PATH=<a throwaway path>.db npx next build --webpack` (the live
  console holds the real DuckDB file, and a build against it crashes).
- The console serves master's working tree live, so uncommitted work there is
  what is running. Commit it or move it to a branch; never both, and not for
  days.

## 3D Lab track

Started 2026-10-06 from a day-long run of about 1,200 models through the 3D
Lab (`hq/hangar-models`: Red Alert 2 units and a model for every square of
the Leela Quest boards), reviewed board by board from contact sheets.

### Next

- **Cutout of the whole scene.** `/api/labs/3d/cutout` keeps SAM 3's single
  best match, so a picture of two figures, or a figure with a bird on its
  knee, loses half of itself, and a seated figure loses its stool. Offer the
  union of all masks for the concept, or let the run skip the cutout: on the
  Lab's plain grey studio pictures, TRELLIS.2's own matting of the whole
  picture keeps every part (hangar-models `scripts/remesh_whole.py`).
- **Reject part-cutouts.** A box under about 8% of the picture is a part of
  the object (one bird of a bowl of birds). Have the endpoint report the box
  share and warn, as hangar-models' driver now does.
- **Free the drawing model before admission.** ComfyUI keeps Z-Image
  resident (about 10 GB), and admission still asks for the full 11.9 GB on top,
  so the next drawing is refused. Unload ComfyUI (`POST :8188/free`) before
  refusing a 3D source request.
- **Retry transient mesh failures.** "failed to stage input image" came from
  a briefly full C: drive and passed on a retry 90 s later.

### Done

- 2026-10-07: **Library.** The 3D Lab has a Make / Library switch. The library
  lists every job (1,400+), with search over subjects and prompts, named sets
  (`meta.group`, written by the run route from a `compareGroup` like
  `hangar-models:leela-vedic`), Objects / People and a has-a-mesh filter. A
  click opens the object in the orbit viewer with its prompt, picture, cutout
  and meshes; arrow keys step through. Before, the Lab showed its last 24 jobs
  and a click loaded one into the form, out of sight.

### Prompt lessons for `objectPrompt`

The image model reads words literally and leans on defaults:

- "monk" draws a Buddhist monk; name the tradition ("an Orthodox Christian
  monk in a black hooded habit", "a white-robed Jain monk with a mouth cloth").
- "a plane" draws an aircraft; "a syllable", "letters" or "a sign" draw
  garbled Latin text; "a crossing point" drew a Christian cross.
- An action by a hand ("a hand lifting…", "hands gathering…") sometimes
  draws a real photographic arm reaching into the frame; say "a sculpted
  hand rising from the base".
- Name a deity or avatar and its look (Varaha drew a woman riding a pig until
  it said "a four-armed god with a boar's head").
- Keep scenes to one subject on its base: props beside the subject (a side
  table, a cave) end up cut away or swallow the subject.
