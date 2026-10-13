"""
Music x cloned voice: is anything useful, or only technically possible?

Run with the music service's interpreter, with the music (ACE-Step), voice
(Chatterbox) and whisper services up:

    C:\\Users\\Admin\\Code\\AI\\music\\.venv\\Scripts\\python.exe scripts\\experiment-music-voice.py

Three ways to combine them, each scored rather than described:

  1. Voice-over on a bed. Chatterbox reads a script in the enrolled voice;
     ACE-Step makes an instrumental bed of the right length with a fade; ffmpeg
     ducks the bed under the voice. Score: Whisper WER on the mix vs on the
     narration alone. (Is the voice still intelligible over the music?)
  2. Singing "in your voice" via ACE-Step's reference_audio (a timbre latent).
     Same lyrics and seeds with and without the reference. Vocals are pulled out
     with the base DiT's stem extraction, then scored with Chatterbox's own
     speaker encoder against the enrolment clip.
  3. Talk-to-song: the clone SPEAKS the lyrics, and ACE-Step's cover task
     restyles that recording as a song.

Speaker similarity is cosine between Chatterbox VoiceEncoder embeddings (the
same encoder the clone is conditioned on). Controls: the clone's own speech
(ceiling: what "sounds like you" scores) and two of Kokoro's preset voices
(floor: a different person).
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "experiments" / "music" / "voice"
CONSOLE = os.environ.get("CONSOLE_URL", "http://localhost:8003")
VOICE = os.environ.get("VOICE_URL", "http://localhost:8004")
WHISPER = os.environ.get("WHISPER_URL", "http://localhost:8001")
MANAGER = os.environ.get("MANAGER_URL", "http://localhost:8099")
KOKORO = os.environ.get("KOKORO_URL", "http://localhost:8002")
MUSIC_DIR = Path(os.environ.get("MUSIC_OUTPUT_DIR", ROOT / "generated-music"))
AI = Path(r"C:\Users\Admin\Code\AI")
ENROLLED = AI / "chatterbox" / "voices" / "ali-b.wav"
CHATTERBOX_PY = AI / "chatterbox" / ".venv" / "Scripts" / "python.exe"
VOICE_ID = "ali-b"

SCRIPT = (
    "Old Jeddah wakes up slowly. The call to prayer drifts over coral stone houses, "
    "and the sea breeze carries the smell of coffee and cardamom through the market."
)
LYRICS = (
    "[verse]\nThe kettle sings before the dawn\nThe fields are silver, the night is gone\n"
    "I kept your letters in a drawer\nI read them slowly like before"
)
SONG_CAPTION = "gentle acoustic folk song, fingerpicked acoustic guitar, soft male vocal, warm and intimate, 90 bpm"
BED_CAPTION = "cinematic ambient bed for a city documentary, soft pads, gentle piano, light percussion, calm and warm, no vocals"


def log(*a):
    print(*a, flush=True)


def speak(text, voice, dst: Path):
    r = requests.post(f"{VOICE}/v1/audio/speech", json={"input": text, "voice": voice, "language": "en"}, timeout=300)
    r.raise_for_status()
    dst.write_bytes(r.content)
    return dst


def kokoro(text, voice, dst: Path):
    r = requests.post(f"{KOKORO}/v1/audio/speech", json={"input": text, "voice": voice, "response_format": "wav"}, timeout=120)
    r.raise_for_status()
    dst.write_bytes(r.content)
    return dst


def music(fields: dict, files: dict | None = None):
    """One run through the Music Lab's route, so the output is in the gallery."""
    data = {k: (None, str(v)) for k, v in fields.items()}
    for k, p in (files or {}).items():
        data[k] = (Path(p).name, open(p, "rb"), "audio/wav")
    j = requests.post(f"{CONSOLE}/api/labs/music/run", files=data, timeout=1200).json()
    if not j.get("ok"):
        raise RuntimeError(j.get("error"))
    t = j["output"]["track"]
    log(f"  {fields.get('task')}: {t['meta']['audio_seconds']}s in {t['meta']['latency_ms']}ms -> {t['file']}")
    return t


def swap(dit):
    r = requests.post(f"{CONSOLE}/api/music/engine", json={"dit": dit}, timeout=600)
    j = r.json()
    if not r.ok:
        raise RuntimeError(j.get("error"))
    log(f"  swapped to {dit}")


def transcribe(path: Path, lang="en"):
    with open(path, "rb") as fh:
        r = requests.post(f"{WHISPER}/v1/audio/transcriptions", files={"file": (path.name, fh)},
                          data={"model": "whisper-1", "language": lang}, timeout=600)
    return r.json().get("text", "") if r.ok else ""


def wer(ref, hyp):
    import re
    import jiwer
    c = lambda s: " ".join(re.sub(r"[^\w\s']", " ", re.sub(r"\[[^\]]*\]", " ", s.lower())).split())
    return round(jiwer.wer(c(ref), c(hyp)), 3) if c(hyp) else 1.0


def probe_seconds(p: Path) -> float:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(p)],
                         capture_output=True, text=True)
    return float(out.stdout.strip())


SIM_CODE = r"""
import sys, json, numpy as np, librosa, torch
from pathlib import Path
from chatterbox.models.voice_encoder import VoiceEncoder
from huggingface_hub import hf_hub_download
ve = VoiceEncoder(); ve.load_state_dict(torch.load(hf_hub_download("ResembleAI/chatterbox", "ve.pt"), map_location="cpu", weights_only=True)); ve.eval()
paths = json.loads(sys.argv[1])
embs = {}
for k, p in paths.items():
    w, _ = librosa.load(p, sr=16000, mono=True)
    embs[k] = ve.embeds_from_wavs([w], sample_rate=16000, as_spk=True)
ref = embs.pop("enrolled")
ref = ref / np.linalg.norm(ref)
print(json.dumps({k: round(float(np.dot(ref, e / np.linalg.norm(e))), 3) for k, e in embs.items()}))
"""


def speaker_sims(paths: dict) -> dict:
    env = {**os.environ, "HF_HOME": r"D:\AI Models\huggingface", "HF_HUB_OFFLINE": "1"}
    out = subprocess.run([str(CHATTERBOX_PY), "-c", SIM_CODE, json.dumps({"enrolled": str(ENROLLED), **{k: str(v) for k, v in paths.items()}})],
                         capture_output=True, text=True, env=env)
    if out.returncode != 0:
        raise RuntimeError(out.stderr[-1500:])
    return json.loads(out.stdout.strip().splitlines()[-1])


def manager(action, service):
    r = requests.post(f"{MANAGER}/services/{service}/{action}", timeout=300)
    log(f"  manager {action} {service}: {r.text[:120]}")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    res = {}

    # All speech first. Beside quote-forge's resident vllm-small, Chatterbox
    # (3.6 GB) and a music generation do not fit on the card together — the
    # coordinator refuses the generation — so the voice is used, then stopped.
    log("0. speech (Chatterbox)")
    narr = speak(SCRIPT, VOICE_ID, OUT / "narration-clone.wav")
    # Floor: a different person. NOT Chatterbox's "default" voice — the server
    # caches the last reference on the model, so "default" right after a clone
    # speaks in the clone's voice (0.97 similar to it, measured). Kokoro's
    # preset voices are unrelated speakers.
    kokoro(SCRIPT, "echo", OUT / "narration-kokoro-echo.wav")
    kokoro(SCRIPT, "nova", OUT / "narration-kokoro-nova.wav")
    spoken = speak(LYRICS.replace("[verse]\n", "").replace("\n", ". "), VOICE_ID, OUT / "lyrics-spoken-clone.wav")
    manager("stop", "voice")
    time.sleep(5)

    # 1. voice-over on a bed ---------------------------------------------------
    log("1. voice-over")
    n_sec = probe_seconds(narr)
    bed = music({"task": "text2music", "caption": BED_CAPTION, "instrumental": "true", "duration": max(10, round(n_sec + 6)),
                 "seed": 7, "fade_out": 3, "format": "wav"})
    bed_path = MUSIC_DIR / bed["file"]
    mix = OUT / "voiceover-mix.wav"
    # Narration enters at 2 s; the bed is ducked ~9 dB under it (sidechain).
    subprocess.run([
        "ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", str(bed_path), "-i", str(narr),
        "-filter_complex",
        "[1:a]adelay=2000|2000,aresample=48000,aformat=channel_layouts=stereo,asplit=2[v][sc];"
        "[0:a][sc]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[duck];"
        "[duck][v]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[out]",
        "-map", "[out]", str(mix)], check=True)
    res["voiceover"] = {
        "narration_seconds": round(n_sec, 1),
        "bed_seconds": bed["meta"]["audio_seconds"],
        "bed_latency_ms": bed["meta"]["latency_ms"],
        "wer_narration_alone": wer(SCRIPT, transcribe(narr)),
        "wer_mixed": wer(SCRIPT, transcribe(mix)),
        "bed_track": bed["id"],
        "mix_file": str(mix),
    }
    log(" ", res["voiceover"])

    # 2. singing with the voice as a timbre reference --------------------------
    log("2. reference-audio singing")
    songs = {}
    for seed in (11, 22):
        for ref in (True, False):
            key = f"sing-{'ref' if ref else 'noref'}-{seed}"
            songs[key] = music(
                {"task": "text2music", "caption": SONG_CAPTION, "lyrics": LYRICS, "instrumental": "false",
                 "vocal_language": "en", "duration": 45, "seed": seed, "bpm": 90, "format": "wav"},
                {"reference_audio": ENROLLED} if ref else None,
            )

    # 3. talk-to-song ------------------------------------------------------------
    log("3. talk-to-song")
    for strength in (0.3, 0.6):
        songs[f"talk2song-{strength}"] = music(
            {"task": "cover", "caption": SONG_CAPTION, "lyrics": LYRICS, "instrumental": "false", "vocal_language": "en",
             "cover_strength": strength, "seed": 11, "format": "wav"},
            {"src_audio": spoken},
        )

    # stems: the vocals, so the speaker encoder hears the singer, not the band
    log("stems")
    swap("acestep-v15-xl-base")
    stems = {}
    try:
        for key, t in songs.items():
            stems[key] = music({"task": "extract", "track": "vocals", "caption": SONG_CAPTION, "seed": 1, "format": "wav"},
                               {"src_audio": MUSIC_DIR / t["file"]})
    finally:
        swap("acestep-v15-xl-turbo")

    sims = speaker_sims({
        "clone_speech (ceiling)": narr,
        "kokoro_echo (floor)": OUT / "narration-kokoro-echo.wav",
        "kokoro_nova (floor)": OUT / "narration-kokoro-nova.wav",
        **{f"{k} vocals": MUSIC_DIR / s["file"] for k, s in stems.items()},
    })
    res["speaker_similarity_to_enrolled"] = sims
    res["sung_wer"] = {k: wer(LYRICS, transcribe(MUSIC_DIR / s["file"])) for k, s in stems.items()}
    res["tracks"] = {k: t["id"] for k, t in songs.items()} | {f"{k}-vocals": s["id"] for k, s in stems.items()}
    (OUT / "results.json").write_text(json.dumps(res, indent=2), encoding="utf-8")
    log(json.dumps(res, indent=2))


if __name__ == "__main__":
    main()
