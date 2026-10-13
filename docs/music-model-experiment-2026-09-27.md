# Music model experiment — 27 September 2026

## Recommendation

**Keep ACE-Step 1.5 as this box's music model, in the configuration that fits
beside quote-forge:** the XL turbo DiT quantized to int8, the 1.7B planner LM,
both offloaded to the CPU between phases. It is MIT-licensed (commercial use,
no conditions), holds 5 GB of VRAM idle and peaks 9 GB, and makes **30 s of
music in ~14 s, a minute in ~20 s, three minutes in ~42 s** on a card that
quote-forge's `vllm-small` is also using. It follows tempo and genre
instructions well, and it can extend, repaint, restyle and split what it made.

- **Background music for short videos: yes.** Length is exact to the sample,
  fade-out works, and every instrumental prompt landed in its genre. The
  pairing that works is **your cloned narration over an ACE-Step bed, ducked**:
  Whisper read the narration word-perfectly both alone and over the music (WER
  0.0 / 0.0). For brief 04's city videos this is the recipe; `generate_music`
  gives an agent a bed of the exact length the edit needs.
- **Your voice singing: no.** Using your enrolment clip as ACE-Step's timbre
  reference moves the singer measurably toward you (speaker similarity 0.84
  vs 0.73 without it, where your own clone scores 0.94 and unrelated voices
  0.64–0.65), but it is a different singer with some of your colour, not you.
  "Talk-to-song" — your clone *speaking* the lyrics, restyled into a song —
  does not work at all: no intelligible singing came out. Nobody has listened
  to these; the numbers are the evidence, and the tracks are in the gallery
  (listed below) for your ear to overrule them.
- **Sung lyrics are intelligible in English, partial in Arabic.** On the
  isolated vocal stem, a folk ballad transcribed at 10–21 % WER, an indie-pop
  song at 41–50 %. Arabic lyrics came out correctly where sung (one take sang
  the chorus verbatim) but only 10–22 of ~30 words were sung in a minute.
- **The unquantized XL + 4B planner (≈23 GB) is the quality option only when
  quote-forge is paused.** That is your call; it was not measured today
  because `vllm-small` stayed up.
- **It cannot generate while Chatterbox, Whisper, Kokoro and quote-forge are
  all resident** — the coordinator refuses (needs 4 GB, 2.4 free). Music with
  Whisper and Kokoro beside quote-forge is fine; stop Chatterbox first, or
  generate the narration before the music, as the experiment did.
- **Second model, if raw song quality ever matters more than editing:**
  MiniMax Music 3 (fits 32 GB; custom licence with branding and revenue
  conditions; text-to-music only; ~10× slower by a third-party 5090 test).

Nothing here was compared against a cloud model: nothing in the router makes
music, so no cloud call was made and nothing was spent.

## What was chosen, and why the others lost

Checked on 26–27 September 2026 against the Hugging Face hub API, the model
cards and licences, the GitHub repos, and the one published cross-model
benchmark. Download counts are the hub API's `downloads` (last 30 days) and
`downloadsAllTime`, written "30d / all-time".

| Model | Licence (weights) | Commercial use | Fits 32 GB | Vocals | Edit a clip | Stems | Windows | WildSongBench avg |
|---|---|---|---|---|---|---|---|---|
| **ACE-Step 1.5 XL** (`ACE-Step/acestep-v15-xl-turbo`, Apr 2026; main repo 59.5K / 422K) | **MIT** (code MIT too) | **Yes, no conditions** | Yes | 50 languages, 10–600 s | Repaint, extend, cover | Yes (base DiT) | Yes, officially | 6.01 |
| MiniMax Music 3 (`MiniMaxAI/MiniMax-Music3`, Aug 2026; 10.4K / 30.5K) | Custom community licence | Yes, but must show "MiniMax-Music3" in the UI, written permission above $20M/yr revenue, an AUP | Yes (~23 GB, or offload) | Yes, ≤5 min | No | No | Unverified | 6.28 |
| YuE2-3B (`m-a-p/YuE2-3B`, Sep 2026; 24.7K / 24.7K) | **CC BY-NC 4.0** | **No** | Yes | zh + en only | No | No | Linux only | **6.73** |
| HeartMuLa-oss-3B (Feb 2026) | Apache-2.0 | Yes | Unverified | 5 languages | No | No | Pins `torch<2.11` | 6.25 |
| SongGeneration v2 / LeVo 2 | "unknown" on the hub; official repo now 404 | Unclear | Unverified | Yes | Unverified | Unverified | Unverified | 6.32 |
| DiffRhythm 2 (Nov 2025) | Apache-2.0 | Yes | Unverified | Yes | No | No | Pins `torch==2.7` | 5.24 |
| Stable Audio Open 1.0 / 3 small | Stability community licence | Restricted (Open 1.0: non-commercial; 3: free under $1M revenue) | Yes | No full songs with vocals | No | No | — | not benchmarked |
| MusicGen-large | **CC BY-NC 4.0** | **No** | Yes | No vocals, ≤30 s | Continuation only | No | — | not benchmarked |

WildSongBench (192 prompts, automatic metrics, run by the YuE2 team,
<https://huggingface.co/datasets/m-a-p/WildSongBench>) is the only benchmark
covering all of these. On it ACE-Step is mid-table for raw song quality but
among the best open models for prompt adherence and phoneme error rate, which
is what "follow the instructions" means here. Its cover task keeps almost none
of a source song's identity (CLEWS mAP 0.024), so "cover" is a restyle, not a
faithful cover — the Lab labels it "Remix / restyle".

Why the others lost:

- **YuE2** sounds best on the benchmark, but its weights are non-commercial and
  it is Linux-only.
- **MiniMax Music 3** is the strongest runner-up and the one to add second if raw
  song quality matters more than editing. It does text-to-music only (no repaint,
  extend, cover or stems), a third-party 5090 test put it at 4–5 min per song
  against ACE-Step's ~25 s, and its licence carries branding, revenue and AUP
  conditions.
- **HeartMuLa**: good quality and Apache, but no reference audio, editing or
  stems yet, and it pins torch below this box's 2.11.
- **SongGeneration / LeVo 2**: licence unclear, repository gone.
- **DiffRhythm 2, YuE 1**: weaker, and superseded.
- **Stable Audio, MusicGen**: licence-restricted, and neither makes a full song
  with vocals.

The brief's figure of "four minutes in about twenty seconds on an A100" was not
found in ACE-Step's own material. Its README claims under 2 s per song on an
A100 and under 10 s on an RTX 3090. What this box actually does is measured
below.

## What was built

- **Service** `C:\Users\Admin\Code\AI\music\server.py` on `127.0.0.1:8014`,
  loopback-only, its own venv. Registered as `music` in
  `config/hosts/betenshi.json` (`serves: { music: "ace-step-1.5" }`) and
  `scripts/service-commands.json`. Footprint in `config/model-meta.json`
  (`local-ace-step-1.5`); the workload `music-generate` in
  `config/resource-policy.json` holds the `gpu-heavy` slot, so a song and an
  image never render at once.
- **Music Lab** (`#lab-music`): text prompt, optional lyrics, length, seed, BPM,
  key, fade-out, an optional timbre reference, and the audio-in tasks the engine
  reports — extend, repaint, remix/restyle, and on the base DiT extract-a-stem /
  add-an-instrument / complete. Output is a player with a clickable waveform,
  latency, card-wide and per-process peak VRAM, and what the LM planner decided.
  Every track is kept in a gallery (`generated-music/`, audio + JSON sidecar),
  and every run is in the runs record.
- **MCP tool** `generate_music`: the agent use is a background bed of an exact
  length for a video an agent is assembling (brief 04).

### Install notes (the trap, again)

ACE-Step pins `torch==2.7.1+cu128` and `transformers<4.58` on Windows. The venv
is built with `--system-site-packages` to inherit the shared torch
`2.11.0+cu128` (Blackwell-capable) and gets its own transformers 4.57 so the
shared 5.4 under Whisper and Kokoro is untouched. ACE-Step is an editable
`--no-deps` install of the clone at `C:\Users\Admin\Code\AI\acestep`, pinned to
`ca1e85f` (2026-08-29; the last tag, v0.1.8, is from May).

Two things bit during the install and are worth knowing:

- `uv pip install` of ACE-Step's dependencies pulled **torch 2.14.0+cpu** into
  the venv as a transitive dependency (via `vector-quantize-pytorch`/`peft`),
  shadowing the CUDA torch. It had to be uninstalled from the venv afterwards.
  Check `torch.cuda.is_available()` after any install into this venv.
- Downloads use `HF_HUB_DISABLE_XET=1`: hf_xet buffers a whole 5 GB shard in RAM
  before writing it, on a box other services share.

Port 8012 was the first choice; the Daniel Soccer app (`C:\Users\Admin\Code\db`)
hard-codes an always-on SAM3 server there, and its 404 JSON crashed the Lab
before the engine route learned to check that the thing answering is the music
engine.

## Measurements

Raw data, all committed: `experiments/music/profiles.json` (footprints),
`manifest.json` (every run), `scores.json` (every score),
`voice/results.json` (the voice experiment). Scripts:
`scripts/experiment-music-profiles.py`, `experiment-music.py`
(`gen` / `stems` / `score`), `experiment-music-voice.py`. Every run went
through the Music Lab's own route, so every track is in the gallery and every
run is in the runs record.

### Which configuration fits the card

BeTenshi's 32 GB is not free. `vllm-small` (quote-forge, the user's app) sits
in the Docker/WSL VM at 14–19 GB, and on this day the card started each
profile at 21–22 GB used. Each profile was started, measured, and stopped;
"Δ" is card-wide (nvidia-smi) over that starting point.

| Configuration | Load | Resident Δ | Peak Δ (60 s sung) | torch peak | 30 s | 60 s sung | Beside quote-forge? |
|---|---|---|---|---|---|---|---|
| XL bf16 + 1.7B, nothing offloaded (smoke test, card free) | 67 s | 18.6 GB (torch) | — | 18.6 GB | 20.5 s* | — | No |
| 2B turbo + 1.7B, offloaded | 59 s | +5.0 GB | +8.5 GB | 8.3 GB | 17.5 s | 20.9 s | Yes |
| **XL int8 + 1.7B, offloaded (chosen)** | 46 s | **+4.8 GB** | **+8.8 GB** | 9.3 GB | 17.0 s | 21.1 s | **Yes** |
| XL int8 + 4B, offloaded | 49 s | +5.1 GB | +9.6 GB | 13.7 GB | 28.6 s | 30.7 s | Spilled — see below |
| XL bf16 + 4B, nothing offloaded | — | — | — | — | — | — | Not tried: needs ~24 GB free |

\*first generation after load, not comparable.

- The 4B planner's torch peak (13.7 GB) exceeded the ~11 GB actually free.
  Windows' driver did not fail the allocation; it spilled into shared system
  memory, which is slower and invisible to CUDA's own free-memory figure. CUDA
  inside Windows cannot see the WSL VM's allocation at all — `mem_get_info`
  reported 1.6 GB used while nvidia-smi showed 15.5 GB — so a process's own
  view of "free" is wrong on this box; only nvidia-smi and the coordinator are
  trustworthy.
- XL int8 and the 2B DiT cost the same here, so the bigger model wins.
- **Host RAM is the price of offload:** the chosen service holds 12.9 GB of
  RAM idle (22.9 GB committed) and 15.4 GB while generating. Loading the fp32
  XL checkpoint briefly adds ~27 GB of commit charge; the first attempt, at
  97 of 121 GB committed, crashed with an access violation at the limit. The
  coordinator now refuses a start with too little RAM, which it did twice
  today (correctly).

### Speed (chosen configuration, 26 runs)

| Audio | Time | of which LM planner | of which DiT |
|---|---|---|---|
| 30 s | 14.2 / 14.3 s | 9.1–9.2 s | 1.9–2.0 s |
| 60 s | 19.5 s mean (19.0–20.1, n = 12) | ~14 s | ~2 s |
| 180 s | 41.9 / 41.6 s | 34.5–34.8 s | 3.4–3.5 s |

- The planner is 64–83 % of the time. **Planner off: 60 s in 7.9–8.1 s.**
- Letting the planner rewrite the caption: +3.5 s (21.8–23.5 s for 60 s).
- Extend 30 s → 60 s: 7.2 s. Stem extraction (base DiT) of a 45–60 s clip:
  10.6–12.6 s. Swapping turbo ↔ base: ~40 s.
- Card-wide peak during the batch: 25.4–25.7 GB, from 22.2–22.4 GB.

### Does it follow instructions? (six prompts × two seeds, 60 s)

Automatic proxies, not a listening test. Tempo: librosa beat tracking. Key:
Krumhansl-Schmuckler on averaged chroma. Genre and caption: zero-shot CLAP
(`laion/clap-htsat-unfused`) — is the track closer to its own genre label and
its own caption than to the other five?

| Measure | Result |
|---|---|
| Planner adopted the requested BPM | 12 / 12 |
| Measured tempo = requested | 10 / 12 exact; the two misses are the 80 bpm lo-fi, heard at 161.5 (double time — a beat-tracker octave error, reported rather than counted) |
| Measured key = requested (4 prompts named one) | 6 / 8 exact, 7 / 8 counting a relative major/minor |
| Genre top-1 (CLAP, 6-way) | 10 / 12 — both misses are Arabic pop, read as "acoustic folk ballad" |
| Own caption ranked first of six | 10 / 12 — both misses are the folk ballad, ranked second |

- **Caption rewrite A/B** (same six prompts, seed 11): no measurable
  difference — genre 5/6 vs 5/6, tempo 4/6 vs 5/6, key 3/4 vs 3/4 — for 3.5 s
  more, and it replaces your words. Off by default. (An early smoke test
  suggested it dropped named instruments; the controlled run did not bear that
  out.)
- **No planner** (three instrumental prompts): genre 2/3 against 3/3 with it
  (deep house read as indie pop), tempo the same. Worth it when speed matters
  more than the last bit of adherence.
- Named instrumentation is only covered indirectly, via caption rank. A CLAP
  check of stems (below) shows the vocal stem is clean; that is the one
  instrument measured on its own.

### Are the sung lyrics intelligible?

Transcribed with this box's Whisper large-v3. **On the full mix, Whisper
heard nothing** for the indie-pop songs: the service runs with
`vad_filter=True`, and Silero VAD discards singing over a band as non-speech.
So the lyrics were measured on the **vocal stem** — ACE-Step's own base-DiT
extraction, which CLAP scores 92 % "a cappella voice" — with two numbers:
WER against the sung portion, and *word precision* (of the words heard, the
share that align to the lyrics — robust to a take that sings the chorus first).

| Song (60 s) | Seed | WER (stem) | Word precision | Words heard |
|---|---|---|---|---|
| English folk ballad | 11 / 22 | 0.21 / **0.10** | 0.87 / 0.91 | 39 / 43 |
| English indie pop | 11 / 22 | 0.41 / 0.50 | 0.68 / 0.55 | 34 / 40 |
| Arabic pop (Egyptian dialect lyrics) | 11 / 22 | — | 0.83 / 0.50 | 12 / 10 |

The Arabic seed-11 take sang the chorus verbatim ("يا حبيبي تعالي نغني الليلة دي
ليلة عمري"); both Arabic takes sang only a third of the lyric in a minute, and
CLAP did not recognise the genre. Arabic works, less reliably than English.

### Stems

Vocal extraction is clean (CLAP: 92 % "a cappella voice"). An instrument stem
is partial: the guitar stem pulled from a folk song had the voice removed (1 %)
but CLAP still reads it as 66 % "full band", 33 % "solo guitar". Useful for
removing vocals; not a clean multitrack.

### Sharing the card with the speech services

With quote-forge, music, Whisper (2.3 GB), Kokoro (0.9 GB) and Chatterbox
(3.6 GB) all resident: 29.7 of 31.8 GB. The coordinator **refused** a music
generation (needs 4 GB more, 2.4 free) — correctly; the driver would otherwise
have spilled. Without Chatterbox, music generated normally beside Whisper and
Kokoro (the voice experiment ran that way).

### Music × your cloned voice

Scored with Chatterbox's own speaker encoder (the one the clone is conditioned
on), as cosine similarity to your 16.4 s enrolment clip:

| What | Similarity to you |
|---|---|
| Your Chatterbox clone, speaking (ceiling) | **0.94** |
| Two unrelated Kokoro voices (floor) | 0.64 / 0.65 |
| ACE-Step singing, your clip as timbre reference (vocal stem) | 0.83 / 0.85 |
| ACE-Step singing, no reference (vocal stem) | 0.74 / 0.72 |
| Talk-to-song: your clone speaking the lyrics, restyled (vocal stem) | 0.41 / 0.47 |

- **Voice-over on a bed** is the useful combination: a 15 s bed made in
  12–14 s with a 3 s fade, your 9 s narration ducked ~9 dB under it by an
  ffmpeg sidechain. Whisper WER 0.0 on the narration alone and 0.0 on the mix.
- **Singing with your clip as reference** gets two-thirds of the way from a
  stranger to your clone on this encoder, and the lyrics stay intelligible
  (stem WER 0.04–0.19). It is a singer with some of your timbre, not you.
  Caveat: this encoder was trained on speech, and even a real recording of you
  singing would score below 0.94 — there is no sung reference of you to
  calibrate against.
- **Talk-to-song fails:** the output is closer to noise than to you, and no
  words were recognised (WER 1.0).
- Side finding: Chatterbox's `default` voice requested right after a clone
  speaks *in the clone's voice* (0.97 similar to it) — the service reuses the
  last cached reference. The floor above was re-measured with Kokoro; the bug
  is filed separately.

### Listen to these

In the Music Lab gallery (`generated-music/`):

- Beds: `20260927-203731-text2music-11-cinematic-orchestral-score-for-a-city-tr`,
  `20260927-203651-text2music-11-lo-fi-hip-hop-beat-dusty-boom-bap-drums-`,
  `20260927-203830-text2music-22-deep-house-track-four-on-the-floor-kick-`,
  three minutes: `20260927-204408-text2music-11-lo-fi-hip-hop-beat-dusty-boom-bap-drums-`
- Sung: `20260927-203948-text2music-22-gentle-acoustic-folk-ballad-fingerpicked`
  (best WER), `20260927-203849-text2music-11-upbeat-indie-pop-bright-jangly-electric-`,
  `20260927-204008-text2music-11-modern-arabic-pop-song-oud-melody-darbuk`
- Your timbre: `20260927-210649-text2music-22-gentle-acoustic-folk-song-fingerpicked-a`
  (with your clip) against `20260927-210705-…` (same seed, without)
- Voice-over mix: `experiments/music/voice/voiceover-mix.wav` (not committed —
  it is your voice)

## Things that broke, and what was fixed

- **DiT swap leaked the old model.** `dit.model = None` + re-initialise left
  the previous DiT, VAE and text encoder referenced: one turbo → base → turbo
  round trip took the process from 5.5 to 13.3 GB VRAM and 23 to 39 GB
  committed RAM, leaving the box 2 GB free. Fixed by replacing the whole
  handler and collecting; four round trips then held VRAM flat at 5.5 GB.
- **Port 8012** was taken by another project (above).
- **`laion/larger_clap_music` is broken as published** — logit scale 0.03,
  every audio-text cosine ≈ 0.003, in transformers 4.57 and 5.4 alike.
  `clap-htsat-unfused` was validated on a known case before use.
- **Two sessions overwrote each other's `gpu-claim.txt` line** (this one
  included). Append and re-read, don't overwrite.

## Verified vs assumed

Verified on this box today: every number in *Measurements*; that the Lab
starts the service through the manager and coordinator, runs text → music,
extend, stem extraction and model swaps from the browser, keeps tracks in the
gallery and records runs, and that a refused lease shows as a capacity block
in place; that the MCP server lists `generate_music`; the licences, from the
model cards and licence files.

Assumed or not measured:

- **Quality by ear.** No one listened. Genre, tempo, key and caption scores
  are automatic proxies; "sounds good" is not claimed.
- **The unquantized XL + 4B planner** — the configuration ACE-Step recommends
  for a 32 GB card — was not measured beside quote-forge (it cannot fit) and
  quote-forge was not paused.
- **Whether int8 costs quality** against bf16. Not A/B'd.
- **Commercial safety of the output.** The weights are MIT, but nothing checks
  whether a generated track resembles an existing song.
- **ACE-Step's own speed claims** (≤2 s per song on an A100) are theirs; the
  numbers above are this box's, with its neighbours.
- Third-party figures in the comparison table (MiniMax speed, benchmark
  scores) were read, not reproduced.
