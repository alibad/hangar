# Local effects

Effects can start from a text description or an imported recording. A source file
is not required for generation. Imported recordings can carry an optional source
or license note; an omitted note is recorded as “Source not specified”.

The creation form exposes the description, duration and reproducible seed.
Generating into an empty sound saves a playable revision. Generating into an
existing sound adds a layer without replacing the current layers or changing the
mix length. Render a variation to save the resulting mix. Saved revisions remain
immutable; reviews change only their review sidecar.

## Existing offline runtime

Copy `config/effects-runtime.example.json` to
`config/effects-runtime.<host-id>.local.json`. Set `python` to an existing Python
environment with `stable_audio_3`, PyTorch, NumPy, SciPy and SoundFile installed,
and `hfHome` to its existing Hugging Face cache. The runtime file is ignored by
Git. Host selection comes from Hangar’s resolved host profile.

The cached `stabilityai/stable-audio-3-small-sfx` model and its T5Gemma encoder
must already be present. This feature does not install packages, download weights
or call a remote provider. Hosts without a configured runtime still expose Effects
with an explanation and retain recording import and editing.

`scripts/effects-worker.py` runs one generation on CPU with four threads, eight
steps and the requested seed. It uses offline mode and hides CUDA. The server
allows one worker at a time, requires 12 GB free RAM including headroom, limits
generation to 0.1–30 seconds, and terminates the worker tree after four minutes.
No resident AI service is started or stopped. The process exits after every run.

Audio is saved as 48 kHz stereo PCM16 WAV, with gain reduction when needed to
keep the sample peak at or below −2 dBFS. The generated asset’s sidecar records
model, prompt, seed and steps. Assets and revisions remain in the existing local
Audio Lab library under `var/audio-lab` (or `AUDIO_LAB_DIR`). Existing recording
mixes still support up to 60 seconds and all original layer controls.

Worker failures are reported in `var/console.log`; drafts are retained. A failed
generation never falls back to a different model or a cloud provider.
