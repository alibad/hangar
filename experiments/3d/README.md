# 3D experiment data — 27 September 2026

Raw data behind `docs/3d-model-experiment-2026-09-27.md`.

- `2026-09-27-inputs.png` — the fixed set: four Z-Image Turbo images (top) and their SAM 3 cutouts (bottom).
- `results/2026-09-27-mesh-runs.jsonl` — one line per mesh request from `trellis3d/bench.py`: model, object,
  wall-clock, nvidia-smi card-wide VRAM before/peak/after, and (for the re-measure) the
  `trellis-server.exe` process's own dedicated GPU memory from the Windows counters.
- `results/2026-09-27-topology.jsonl` — `trellis3d/meshstats.py` per GLB.

The meshes themselves are in the console's gallery folder (`generated/3d/20260927-19*-bench-*`),
reopened from the 3D Lab's *Earlier objects*. The scripts are in `C:\Users\Admin\Code\AI\trellis3d`.
