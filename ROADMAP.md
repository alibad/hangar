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
