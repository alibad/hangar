# Resource control plane

BeTenshi has one 32 GB GPU and several services whose individually valid memory
plans are not valid when combined. The service manager on `127.0.0.1:8099` is
the authority for both service-start admission and heavy local inference work.

## Invariants

- Measured footprints live only in `config/model-meta.json`.
- `config/resource-policy.json` maps those measurements to services and
  workloads. Do not duplicate the numbers there.
- Resident service cost uses `idleRamGb` / `idleVramGb` when present. A workload
  replaces that service's resident cost with its peak; it is never counted twice.
- Admission checks both modeled totals and live free RAM/VRAM, retaining the
  configured safety margins.
- Qwen generation/edit, FLUX generation, SAM 3 segmentation/tracking, and SAM 3D
  pose share the `gpu-heavy` slot. Only one of those operations runs at a time.
- Interactive requests outrank background batch work; requests remain FIFO
  within a lane.
- Every lease has a TTL. Normal callers release in `finally`; the manager reaps
  stale leases after a crashed or disconnected caller.
- If the manager is unavailable, local heavy work fails closed. Cloud image
  aliases bypass this local coordinator.

## Manager API

The API is loopback-only, like the manager itself.

- `GET /resources` returns live capacity, modeled usage, active services,
  service-start reservations, leases, queue entries, and the last control event.
- `POST /resources/leases/acquire` accepts `workload`, `owner`, `lane`, `waitMs`,
  and `ttlMs`. The HTTP request stays open while queued.
- `POST /resources/leases/:id/release` releases a lease and drains the queue.
- `POST /services/:id/start` now returns HTTP 409 with `resourceBlocked: true`
  and an actionable denial when a start would exceed the budget.

The console proxies the snapshot at `GET /api/resources` and renders it under
Stack → Work scheduler.

## Adding a local heavy workload

1. Measure its peak and resident footprint, then add the sourced measurement to
   `config/model-meta.json`.
2. Map the service/model and workload in `config/resource-policy.json`. Use the
   `gpu-heavy` slot if it cannot safely overlap other GPU inference.
3. Wrap the lowest shared execution path with `withResourceLease()` from
   `src/lib/resource-manager.ts`. Pass the request/job AbortSignal and an owner
   that identifies the caller without including secrets or prompts.
4. Preserve the existing Requests instrumentation and `X-Source` attribution;
   resource leases supplement those systems rather than replacing them.
5. Add coordinator tests and run `npm test`, `npx tsc --noEmit`, and `npm run build`.
