# Making 3D models with Hangar, from another project

How Hangar (this console, `:8003`) turns a picture into a textured 3D model,
and how another project calls it so every run is traced here. It was written
for OpenRA-AI's Faction Studio, which wanted a local model beside each
actor's existing GLB draft, but nothing in it is specific to that project.
Background and measurements: `docs/3d-model-experiment-2026-09-27.md`.

## The method

```
reference image ──▶ SAM 3 cutout ──▶ TRELLIS.2 ──▶ textured GLB (stood upright)
 (yours, or drawn     (removes the      (image-to-3D,
  by Z-Image Turbo)    background)       on the RTX 5090)
```

| Mesh model | Pick it for | Time per object | Output |
|---|---|---|---|
| `trellis-2` (TRELLIS.2, 4B, MIT). **Default** | A finished-looking asset | 30–140 s at 512 (Draft), 1.5–14 min at 1024 | UV-unwrapped mesh, ~150–300K triangles, 2048² PBR textures |
| `pixal3d` (TRELLIS.2 fine-tune) | Staying true to the reference picture's colours and proportions | ~2 min (1024 only) | Same kind of mesh |
| `triposr` | A blockout, to check the shape first | ~2 s | Vertex colours, soft and lumpy |

Everything is local: no paid API, nothing leaves the machine.

## Calling it

Always go through the console, never straight to the mesh service on `:8030`.
The console takes the GPU lease (so jobs never collide), stands the mesh
upright, saves every artifact, and records the run.

1. **Start the services** (the pipeline does not start them):
   - `POST http://127.0.0.1:8099/services/trellis/start`
   - `POST http://127.0.0.1:8099/services/sam3/start` (only for the cutout step)
   - `comfyui` only if you want the console to draw the picture from text.

   Then poll `GET http://127.0.0.1:8099/services` until each shows running
   and healthy.
2. **One request per object:**

   ```
   POST http://127.0.0.1:8003/api/labs/3d/pipeline
   {
     "subject": "RA2 · Line Fighter (hezbollah infantry)",   // the label in the trace
     "image": "<base64 PNG/JPEG of the reference>",          // or omit it and the subject is drawn
     "concept": "soldier",                                   // what SAM 3 cuts out
     "model": "trellis-2",
     "resolution": 512,
     "seed": 42
   }
   ```

   The answer gives `glbPath` (absolute), `glbUrl`, `job`, `runId`,
   `sourcePath`, `cutoutPath`, `steps` with the milliseconds for each, and
   `totalMs`.
   - Requests are synchronous; allow up to 30 min each. Send them one at a
     time, since the GPU slot runs them one by one anyway.
   - A `409` with `resourceBlocked: true` means the card is busy. Wait
     minutes, not seconds, then retry.
   - If the reference already has a transparent background, send
     `"cutout": false` and skip SAM 3 (it holds 4.8 GB).
3. **For a one-off from a Claude session**, the `generate_3d_model` MCP tool
   runs the same pipeline (`image_path`, `concept`, `model`, `resolution`).

## Choosing the input

- **For a fair comparison, use the same reference the other method saw.**
  Feed the actor's existing artwork: one object, full body or full hull, a
  plain background, three-quarter view.
- **Set `concept` explicitly.** SAM 3 segments that noun, and the default is
  the last word of `subject` ("Line Fighter" would become "fighter"). Use
  `soldier`, `tank`, `truck`, `helicopter`, `jet`, `ship` or `building`.
- With no artwork, omit `image`. The console draws the subject with Z-Image
  Turbo (1024², ~15 s) from a prompt built for one object on a plain
  background.

## Tracing

- Every run is a lab run: Hangar → Labs → 3D Lab lists it, reopens it and can
  show two meshes of the same object side by side. The same data comes from
  `GET http://127.0.0.1:8003/api/labs/runs?lab=3d&limit=50`.
- Each run is a folder under `betenshi-console/generated/3d/<job>/` holding
  `source.png`, `cutout.png`, the GLB and `meta.json`: subject, seed,
  resolution, timings, SAM 3 score.
- Put the actor's id and name in `subject`, so the trace says which actor a
  run was for.

## Adding it as a new source in your app

- Copy the GLB into your own asset tree. Keep the existing sources and add
  this one beside them, labelled e.g. **"Local · TRELLIS.2 (512)"**.
- Store its provenance with it: model, resolution, seed, the console `job`
  and `runId`, a hash of the input image, and the timings.

## Budget and GPU etiquette

- **Time.** 200 objects at 512 take roughly 2–8 hours of GPU time.
- **Memory.** TRELLIS.2 peaks at about 11 GB of VRAM (1.3 GB idle between
  meshes); SAM 3 holds 4.8 GB.
- **Book the card first.** Add a line to
  `C:\Users\Admin\Code\AI\logs\gpu-claim.txt` (`<session> <ISO time> <what>`)
  and refresh it at least every 30 minutes. Do not start while someone
  else's claim is live.
- **Stay out of Video Forge's window,** 01:00–07:00 local, unless it has
  handed the card back.
- **Clean up.** When done, stop `trellis` and `sam3`
  (`POST …/services/<id>/stop`) and remove your claim line. Do not stop or
  restart services other sessions are using (qwen, vllm-small, ComfyUI).

## What the GLB is, and is not

- **Static geometry.** No rig, no separate turret or barrel, no team-colour
  regions. Thin parts (antennas, rifles, rotor blades) can fuse or drop.
- **Heavy for a game.** ~150–300K triangles: decimate it for runtime.
- **Arbitrary scale.** Normalize it to the actor's footprint.

## Red Alert 2 formats (SHP, VXL): next steps, not part of this pipeline

The GLB is the source for conversion; Hangar does not write SHP or VXL.

- **Which format.** Vehicles, aircraft and ships are **VXL** voxel models,
  with an **HVA** file holding each section's transform (body, turret,
  barrel). Infantry, buildings and cameos are **SHP** sprites.
- **VXL from a GLB.**
  1. Split the moving sections. TRELLIS.2 gives one fused mesh, so cut
     turret and barrel by geometry, or generate them as separate objects.
  2. Voxelize each section to a vehicle-sized grid.
  3. Give every voxel a palette colour and a normal index (the engine lights
     voxels by their normals).
  4. Write VXL plus HVA.
- **SHP from a GLB.**
  1. Render orthographically from the camera the original RA2 art uses
     (measure it from an original SHP), once per facing and state the actor
     needs.
  2. Quantize to the RA2 palette, painting the team-colour remap range where
     team colour should show.
  3. Add shadow frames, and pack as TS/RA2 SHP.
- **Infantry need animation first** (walk, fire, die): rig the GLB and pose
  it before rendering. Move Quest's rotation-based retarget onto a Mixamo
  skeleton (`hq/move-quest/lib/mocap/retarget.ts`) and its Mixamo clips are
  one route.
- **Check every export in OpenRA itself** before counting it as done.
