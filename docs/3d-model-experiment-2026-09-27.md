# 3D model experiment — 27 September 2026

## Recommendation

**Use TRELLIS.2 (via trellis.cpp) as this box's image-to-3D model, at Draft (512)
by default.** It is the only thing tested that makes a finished-looking asset: a
UV-unwrapped mesh of ~150–300K triangles with 2048² PBR textures (base colour +
metal/roughness), from one image, in **30–140 s** at 512 and **1.5–14 min** at 1024
on the RTX 5090. It is MIT-licensed, weights and code.

**Keep TripoSR for blockouts.** ~2 s per object at any setting, 3.5 GB resident,
watertight by construction — and visibly a different product: vertex colours
only, soft and lumpy surfaces, thin parts fused or dropped. It answers "roughly
what shape is this" before you spend minutes on TRELLIS.2.

**Pixal3D** (TencentARC's SIGGRAPH 2026 fine-tune of TRELLIS.2, MIT) runs on the
same server with no extra install beyond 11 GB of weights. Pick it when the mesh
must match *the photo* rather than be a clean canonical object: on the character
it kept the source's colours and proportions where TRELLIS.2 drifted, at similar
cost (~2 min at 1024). It reconstructs in the camera's frame, which the pipeline
now corrects.

**People go to SAM 3D Body**, which is now the 3D Lab's *Person* mode rather than a
separate tab. From one photo it gives a body mesh (18K vertices, watertight) and
70 3D joints in **1–5 s**, with 3.7 GB resident. It recovers body shape and pose,
not clothes or hair, so it suits posing, animation reference and fitting. It is
not a likeness. See *People*.

**Hunyuan3D 2.1 was not installed** — see *Licences*: its community licence does not
apply in the EU, UK or South Korea, and its texture stage needs CUDA extensions
this box cannot build (no CUDA toolkit, no MSVC).

**No cloud model was compared.** None is reachable: the router's vendors (OpenAI,
Gemini, Anthropic) have no image-to-3D endpoint, and there is no fal, Replicate,
Meshy, Tripo, Stability or Rodin key anywhere under `C:\Users\Admin\Code`.

Which product is it closest to? **A game asset — a background or concept prop**,
after a decimation pass. It is good enough for product *look-development*, not
for dimensionally accurate mockups, and it is not print-ready without repair
(see *What each is good for*).

## What was built

- **Two services**, registered in `config/hosts/betenshi.json` with `serves: { "3d": … }`,
  started by the manager, admitted by the resource coordinator:
  - `trellis` (:8030) — trellis.cpp v0.8.1's own `trellis-server.exe`, prebuilt for
    Windows CUDA. Serves **`trellis-2`** and **`pixal3d`** from one GGUF directory
    (`D:\AI Models\trellis2`, 27.5 GB); the new host-profile field `modelParam`
    maps each served name to the server's own `model` field.
  - `triposr` (:8031) — a FastAPI wrapper, `C:\Users\Admin\Code\AI\triposr\server.py`,
    in its own venv (`--system-site-packages`, torch 2.11+cu128 inherited).
- **The 3D Lab** (`#lab-3d`), on the Labs platform: describe an object (or upload
  one) → a local image model draws it → **SAM 3** cuts it out → any `3d` model on
  the host meshes it → an **interactive viewer** (orbit, Studio / Flat / Raking
  light, wireframe overlay, clay mode, turntable, GLB download) with triangle count,
  texture size and a closed/printable check. Every object is a folder under
  `generated/3d/`; the Lab reopens earlier ones and puts any two meshes of the
  same object side by side. Runs are recorded in `lab_runs`.
- **Person mode in the same Lab**, which replaces the old *3D Body* tab. Choose *A person*,
  drop in a photo (or describe one), optionally let SAM 3 pick the person, and
  SAM 3D Body returns a body mesh and its pose. The pose shows as a skeleton over
  the photo, with the mesh in the same viewer and downloads for the GLB and the
  pose JSON. See *People*.
- **An MCP tool**, `generate_3d_model`, running the same pipeline in one call
  (`POST /api/labs/3d/pipeline`), with a description that says when not to use it.
- **Capacity, made visible.** Measured footprints for all three mesh models and for
  SAM 3 (which had none) in `config/model-meta.json`; the capacity remedy's holder
  list now includes any running service with a declared resident footprint; the
  Lab's steps show that remedy in place when the coordinator refuses.

## Measured

A fixed set of four objects, each drawn by **Z-Image Turbo** (1024², fixed seeds,
13–21 s per image) and cut out by **SAM 3** (0.25–1.8 s; scores 0.85–0.98):

| | Hard-surface | Organic | Thin parts | Character |
|---|---|---|---|---|
| Prompt | cordless power drill | gnarled tree stump, roots, moss | Windsor chair, thin spindles | cartoon fox adventurer, full body |

### Time and memory

Wall-clock of one `/generate` call, measured by the client. VRAM is nvidia-smi's
card-wide `memory.used`, sampled every 0.25 s; "+" is peak minus the reading just
before the call. WDDM reports no per-process figure, so concurrent jobs were
attributed with the Windows *GPU Process Memory* counters.

| Model | Setting | Drill | Stump | Chair | Fox | Peak VRAM added |
|---|---|---:|---:|---:|---:|---|
| TripoSR | 256³ grid, warm⁴ | 1.9 s | 2.3 s | 1.9 s | 2.4 s | 0 (3.5 GB resident) |
| TRELLIS.2 | 512 | 63 s | 141 s | 32 s | 45 s | +2.6–3.9 GB |
| TRELLIS.2 | 1024 cascade | 228 s¹ | 851 s² | 94 s | 172 s | +2.7–5.2 GB; **10.6 GB** process peak on the stump² |
| Pixal3D | 1024 cascade | — | — | 113 s | 126 s | +7.2–7.4 GB³ |

¹ First request after the server started. trellis.cpp loads each stage's weights
per request, so every request reads ~16.5 GB of GGUF; this one read it from disk,
later ones from the OS file cache. ² The first stump run's card-wide peak was
confounded: a 13 GB `vllm-small` container came up while it ran. Re-measured
alone with the Windows per-process counter on `trellis-server.exe`: 1.33 GB idle
→ **10.56 GB peak**, with 1.2 GB of card headroom left (not capped), 753 s. That
is the figure in `config/model-meta.json` (11 GB). ³ Ended within
0.4 GB of the card's ceiling, so possibly capped. ⁴ Second of two runs; the first
run after load was 2.8 s on the drill and within 0.4 s of the second elsewhere.

TripoSR's time is ~0.1 s of network inference and ~1.7 s of marching cubes and
vertex-colour queries (reported per request in `X-Infer-Ms` / `X-Mesh-Ms`).

**Where TRELLIS.2's time goes.** On the drill at 1024: ~6 s sparse structure, ~29 s
shape flow (LR + HR cascade), ~16 s texture flow — about **50 s of GPU** — then
**~175 s of CPU post-processing**: weld, hole fill, a narrow-band dual-contouring
remesh of 8M voxels, GPU quadric decimation to 300K faces, xatlas unwrap and a
texture bake. The stump decoded **17.8M voxels / 39M faces** at 1024; its hole
fill alone ran single-threaded for ~6 min, and the whole request took 14 min for
a mesh decimated to the same 285K faces as everything else. Going from 512 to
1024 costs ~3× on simple objects (chair 32 → 94 s) and ~6× on dense ones
(stump 141 → 851 s), for a difference that is hard to see at normal viewing
distance — hence Draft as the Lab's default.

### Topology

From `trellis3d/meshstats.py` (raw lines in `experiments/3d/results/`; trimesh, after welding UV-seam duplicates — without
that, every seam reads as a hole). The Lab's viewer computes the same open-edge and
non-manifold counts in the browser and agreed on every mesh checked.

| Model · setting | Object | Triangles | Separate bodies | Open edges | Non-manifold edges | Watertight | Texture |
|---|---|---:|---:|---:|---:|---|---|
| TripoSR · 256 | drill | 112K | 1 | 0 | 0 | **yes** | vertex colours |
| | stump | 257K | 100 | 0 | 0 | **yes** | vertex colours |
| | chair | 45K | 3 | 0 | 0 | **yes** | vertex colours |
| | fox | 88K | 1 | 0 | 0 | **yes** | vertex colours |
| TRELLIS.2 · 512 | drill | 150K | 47 | 0 | 154 | no | 1024² × 2 |
| | stump | 148K | 2,301 | 0 | 4,325 | no | 1024² × 2 |
| | chair | 140K | 13 | 0 | 13 | no | 1024² × 2 |
| | fox | 149K | 159 | 0 | 1,025 | no | 1024² × 2 |
| TRELLIS.2 · 1024 | drill | 293K | 31 | 0 | 106 | no | 2048² × 2 |
| | stump | 285K | 2,154 | 0 | 3,871 | no | 2048² × 2 |
| | chair | 298K | 15 | 0 | 23 | no | 2048² × 2 |
| | fox | 298K | 352 | 0 | 896 | no | 2048² × 2 |
| Pixal3D · 1024 | chair | 265K | 10 | 0 | 42 | no | 2048² × 2 |
| | fox | 287K | 180 | 0 | 818 | no | 2048² × 2 |

"Texture × 2" is base colour plus a metallic-roughness map, WebP-encoded in the GLB.
TRELLIS.2's post-processing fills every hole (0 open edges) and decimates to a
fixed face budget (~150K at 512, ~300K at 1024) regardless of the object, but
leaves small detached pieces and non-manifold edges — worst on fine organic detail
(the stump's roots and moss) and on the fox's fur tufts. TripoSR is watertight and
manifold by construction (marching cubes), but on the stump that surface is 100
disconnected blobs.

### What each is good for — judged in the Lab's viewer

All four objects, every model side by side on the same cutout, Studio and Raking
light, orbited:

- **Drill (hard-surface).** TRELLIS.2 is convincing at both settings: sharp panel
  lines, a readable chuck, the battery's label plate; 512 is slightly softer, not
  worse in kind. TripoSR is a recognisable drill silhouette with melted edges and
  smeared colour.
- **Stump (organic).** TRELLIS.2 reproduces the root structure and the moss patches
  as geometry, but its texture is noticeably paler than the source photo. 512 and
  1024 are hard to tell apart at a normal viewing distance, and 1024 took 6× longer.
  TripoSR reads as melted chocolate: right silhouette, closer colour, no detail.
- **Chair (thin parts).** The clearest win: TRELLIS.2 keeps every back spindle,
  all four legs and the stretchers, straight and separate. TripoSR fuses
  and breaks the spindles and loses part of a leg. Pixal3D keeps the parts too.
- **Fox (character).** TRELLIS.2 gives a clean, appealing character: face,
  scarf, tail, a fur-like texture. **Pixal3D is the most faithful to the input
  image** — the scarf is the source's green (TRELLIS.2 drifted it to teal) and the
  pose and proportions match the photo, which is what "pixel-aligned" buys. TripoSR
  is a soft, surprisingly pleasant blockout.

Two presentation bugs surfaced by looking, both fixed at the source and covered
by the pipeline, not by the viewer:

- TripoSR's upstream orientation transform (from its Gradio demo) showed the fox's
  **back** in a standard glTF viewer, and its sRGB vertex colours were written into
  glTF's linear `COLOR_0`, so they looked washed out. `triposr/server.py` now
  rotates the input view to +Z and linearises the colours.
- **Pixal3D reconstructs in the input camera's frame**: its GLBs arrive with up
  along −Z, lying on their backs. `config/model-meta.json` declares
  `"upAxis": "-z"` for it and the pipeline wraps the scene in one rotated root
  node — geometry and textures untouched (tested byte-for-byte in
  `scripts/mesh3d.test.mjs`). A small residual tilt from the photo's camera
  elevation remains.

**Game asset, 3D print or product mockup?** Closest to a **game asset or concept
prop** — specifically a *background or mid-ground* prop: textured, UV-mapped,
~150–300K triangles (heavy for a real-time hero asset; a decimation pass to 10–30K
with a normal-map bake is still needed), no rig, no LODs, and unpredictable topology
(detached pieces, non-manifold edges). As a **product mockup** it is good for
*look-development and review* — orbitable, lit, textured — but not for anything
dimensionally accurate: scale and proportions are guessed from one photo. For
**3D printing**, TRELLIS.2's meshes need a repair pass (every one has non-manifold
edges and loose pieces; slicers' auto-repair usually handles counts this size,
but the stump's 2,000+ pieces will print as debris); TripoSR's are printable as
exported but too soft to be worth printing. None of this is a replacement for a
modeller on a hero asset; all of it is a fast, free first pass.

## End to end in the console

Run on 27 September in the 3D Lab (`#lab-3d`), services started from the Lab's
own Start buttons, with a real photo the models had not seen (TripoSR's
`captured.jpeg`: a plush toy on a black mesh office chair) uploaded through the
Lab's Upload control:

| Step | Result |
|---|---|
| Upload → job folder | `generated/3d/20260927-213620-a-plush-toy-dinosaur-o4h5/` |
| SAM 3 cutout, concept "plush toy" | score 0.99, 1.5 s |
| TripoSR, Draft (256) | 10.3 s first run after start, 93K triangles, watertight |
| TRELLIS.2, Draft (512) | 56 s, +3.5 GB, 149K triangles, 1024² × 2 textures |
| Pixal3D, Draft (→1024) | 127 s, +6.7 GB, 279K triangles, 2048² × 2, upright |
| All meshes | in the side-by-side viewer, in *Recent runs*, downloadable as GLB |

And through MCP, as an agent would call it (`start_service` sam3 and triposr,
then `generate_3d_model` with `image_path` = TripoSR's hamburger example,
`model: "triposr"`): **7.7 s** for the whole call — SAM 3 1.3 s (score 0.96),
mesh 2.1 s — returning the GLB, cutout and source paths.

What the end-to-end run found, all fixed before this was written:

- **The SAM 3 cutout had no alpha.** In one `sharp` pipeline `removeAlpha()` runs
  after `joinChannel()` whatever order they are written in, so the mask was joined
  and then stripped. Nothing downstream complained: both mesh models quietly
  matted the 3-channel image themselves (BiRefNet, rembg). `applyMask` now
  materialises RGB first, and a test asserts the cutout is RGBA with an opaque
  object and a transparent margin. (The measured bench used a Python cutout and
  was not affected.)
- **Pixal3D at 512 is not a draft, it is a failure.** Pixal3D publishes only a
  1024 texture flow, so trellis.cpp falls back to raw geometry: 1.29M triangles,
  no texture, 65K open edges. Draft now sends Pixal3D at 1024.
- **The three steps do not fit together beside `vllm-small`.** With that container
  resident (it held 19 GB of the card during the run, by the Windows counter),
  about 11 GB is left: enough for any one step, not for Z-Image (+11 GB) with
  SAM 3 (4.8 GB) and TripoSR (3.5 GB) resident. The coordinator refused, as it
  should. The Lab now shows the console's own remedy, `CapacityBlocker`, in place
  for the image and cutout steps as the shell already did for runs, and the
  holders list (`GET /api/gpu/holders`) now includes any running service with a
  declared resident footprint instead of only Qwen and ComfyUI — which is how
  SAM 3, TripoSR and TRELLIS became freeable from the refusal itself. SAM 3 had no
  footprint at all (the coordinator counted it as 0 GB); it now declares its
  measured 4.8 GB. The one step that could not be completed in the Lab during
  the E2E was **generating** the image: Z-Image needed 11.9 GB against 10.7 GB
  free with only `vllm-small` left, and stopping the user's container was not
  this experiment's call at the time.

**The generate path was verified afterwards** in the console on master. With the user's
go-ahead, the manager was restarted to load the new config and `vllm-small` was
briefly stopped. *Describe* "a vintage brass desk lamp with a green glass shade"
went to Z-Image Turbo (**14.3 s**), and TRELLIS.2 at Draft meshed the generated
picture as-is (**53 s**, 4.8 MB GLB). SAM 3 then cut the lamp out ("lamp", score
0.97, 2.6 s). So each link has now run in the Lab: generate → image here,
cutout → mesh in the upload run above, and all three in one call through MCP.

## People: SAM 3D Body in the 3D Lab

The console already ran **SAM 3D Body** (Meta, Nov 2025; move-quest's `sam3d` service,
:8009) behind a separate *3D Body* tab: a bare form over its `/pose` endpoint. That tab is gone.
Its job now lives in the 3D Lab as a second mode, so a person gets the same
steps, viewer, history and run record as an object:

- **Pick the mode**: *An object* or *A person*. The Lab remembers the choice. Old `#sam3d`
  links and the Services page's *Open in 3D Lab* button land in Person mode, and
  searching "body" or "pose" in the command palette finds the Lab.
- **1 · Photo of a person**: drop a photo, or describe one (the prompt asks for one
  person, head to feet, on a plain background).
- **2 · Pick the person** (optional): SAM 3 with the concept "person". Its box tells SAM 3D
  Body which person to reconstruct. Without it, SAM 3D Body takes the most prominent one.
- **3 · Body and pose**: the mesh in the orbit viewer, the 2D skeleton and box over
  the photo, and a GLB and a pose JSON (70 joints in 3D and 2D, camera, box) to
  download. Every body is kept in the job folder, so the whole-photo and picked
  results can be compared side by side.

The model is listed under a new capability, `3d-body`, served by `sam3d` in the host
profile. It is guarded by the existing `sam3d-pose` workload, and its footprint is
now declared (it had none).

Measured on BeTenshi, 28 September, on an uploaded street photo of a dancer:

| | Result |
|---|---|
| First body run after start | 4.45 s |
| Warm runs | 1.2–2.8 s |
| With a SAM 3 pick | 0.56 s pick + 1.16 s body |
| Output | 70 joints; 18,439 vertices, 36,874 triangles, closed (watertight) |
| Memory | 3.7 GB VRAM resident, about +0.2 GB during a run; 2.3 GB RAM working set |

What it is not: **one person per run**, and **no clothing, hair or texture**. The mesh is
the parametric body (MHR) fitted to the photo, so it is not a likeness. Use it for pose and
proportion: animation reference, posing a character, fitting. For a textured statue of
a person, use Object mode (TRELLIS.2 or Pixal3D) on the cutout.

Licence: the **SAM License** (Meta), read from the local checkout because the hub repo
is gated. Royalty-free use, including commercial, with trade-control terms.

## Licences

- **TRELLIS.2-4B** — MIT (weights and code). No territory or usage restriction.
- **trellis.cpp** — MIT. The GGUF conversions (`ilintar/trellis2-gguf`) are a format
  change of Microsoft's weights and inherit the MIT licence.
- **Pixal3D** — MIT (`TencentARC/Pixal3D` LICENSE, © 2026 Tencent). Its Hugging Face
  repo is gated with `extra_gated_eu_disallowed: true`, i.e. Tencent does not
  offer the download to users in the EU even though the licence text itself has
  no territory clause. The GGUFs used here are `vegax87/Pixal3D` (MIT).
- **TripoSR** — MIT.
- **SAM 3D Body** — SAM License (Meta): royalty-free, commercial use allowed,
  subject to trade-control terms. See *People*.
- **Hunyuan3D 2.1** (checked, not installed) — *Tencent Hunyuan 3D 2.1 Community
  License*. Read in full on the hub (`tencent/Hunyuan3D-2.1/LICENSE`):
  - **Territory**: the licence "does not apply in the European Union, United Kingdom
    and South Korea"; use, reproduction, distribution *and outputs* outside the
    Territory are unlicensed (§1.l, §5.c).
  - **Scale**: if your products had **more than 1 million monthly active users** in
    the month before the release date (13 June 2025), you need a separate licence
    from Tencent, granted at its discretion (§4).
  - **Outputs** may not be used to improve any other AI model (§5.b).
  - Distribution requires passing on the licence, a "Powered by Tencent Hunyuan"
    style notice file, and a prominent disclosure that Tencent does not endorse
    the product (§3).
  - Within those limits, commercial use is permitted royalty-free.

## Verified versus assumed

Verified on this box: every number above; the SHA-256 of all 15 GGUF files against
the hub's LFS hashes; the trellis.cpp runtime zip against the release's published
digest; the Lab end to end in the browser, all three models, from a real photo
(above); the MCP tool with an image path, and its refusal message when the card
is full; every mesh judged in the Lab's viewer, not from numbers alone; the
*generate* path (with `vllm-small` briefly stopped); Person mode in the browser,
with and without a SAM 3 pick.

Still true: with `vllm-small` resident (19 GB), generating, cutting and meshing do
not all fit at once. The coordinator refuses the step that doesn't fit, and the Lab
shows the remedy.

Assumed or not tested: that Draft-vs-Standard quality trade-offs hold beyond these
four objects; Pixal3D's peak on an empty card; TRELLIS.2 at 1536 (not run — at
1024 the post-processing already dominates); the reference PyTorch TRELLIS.2
(could not be built here, so no parity check against it — trellis.cpp's author
claims parity with the reference post-processing).

## Model landscape, checked 27 September 2026

Hugging Face hub, `image-to-3d` task, sorted by trending and by likes. Download
figures are given as *last 30 days / all-time* (the hub's `downloads` and
`downloadsAllTime`); per `docs/models.md`, adoption is context, not evidence of
quality — the measurements above are the evidence.

- `microsoft/TRELLIS.2-4B` — first by trending score; 1.7M / 8.0M downloads,
  1,249 likes; MIT; released Dec 2025.
- `tencent/Hunyuan3D-2.1` — 54K / 658K downloads, 1,217 likes; community licence above.
  No newer open Hunyuan3D shape/texture model on the hub (`Hunyuan3D-Omni`,
  `-Part` and `HY-World-2.0` are control, part-segmentation and scene models).
- `TencentARC/Pixal3D` — SIGGRAPH 2026, TRELLIS.2 backbone, MIT; 362 likes.
- `stabilityai/TripoSR` (MIT, 2024) and `VAST-AI/TripoSG` (MIT, 1.5B, shape
  only) — the fast feed-forward family; `stabilityai/stable-fast-3d` is gated
  under Stability's community licence.
- trellis.cpp (`pwilkin/trellis.cpp`, MIT, v0.8.1 released 25 Sep 2026) ships
  Windows CUDA binaries — the reason TRELLIS.2 runs here at all.
