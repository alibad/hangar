"""
Music model experiment: generate a small fixed set through the Music Lab's own
run route, then score it with automatic proxies. The write-up is
docs/music-model-experiment-2026-09-27.md.

Run with the music service's interpreter (it has librosa, jiwer and a
transformers that can load CLAP):

    C:\\Users\\Admin\\Code\\AI\\music\\.venv\\Scripts\\python.exe scripts\\experiment-music.py gen
    C:\\Users\\Admin\\Code\\AI\\music\\.venv\\Scripts\\python.exe scripts\\experiment-music.py score

`gen` goes through POST /api/labs/music/run, so every output lands in the
gallery (listen to them there) and every run is in the runs record. It is
resumable: a run already in the manifest is skipped.

What the scores are, and are not:
  - tempo: librosa beat tracking vs the BPM asked for. Beat trackers make
    octave errors (half/double time), reported separately rather than hidden.
  - key: Krumhansl-Schmuckler on a chroma average. Relative major/minor
    confusions are common and reported as such.
  - genre / caption adherence: zero-shot CLAP (laion/clap-htsat-unfused): does
    the audio sit closer to its own genre label, and its own caption, than to
    the other five? An automatic proxy, not a listening test.
    (laion/larger_clap_music was the first choice and is broken as published:
    logit scale 0.03 and every audio-text cosine ~0.003, in transformers 4.57
    and 5.4 alike. htsat-unfused was checked on a known case before use.)
  - lyrics: the box's own Whisper large-v3 transcribes the full mix; WER (and
    CER for Arabic) against the lyrics that were asked for. Sung words over a
    band are harder than speech, so this is a floor on intelligibility.
"""
import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

import numpy as np
import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "experiments" / "music"
MANIFEST = OUT / "manifest.json"
SCORES = OUT / "scores.json"
CONSOLE = os.environ.get("CONSOLE_URL", "http://localhost:8003")
WHISPER = os.environ.get("WHISPER_URL", "http://localhost:8001")
MUSIC_DIR = Path(os.environ.get("MUSIC_OUTPUT_DIR", ROOT / "generated-music"))

SEEDS = [11, 22]
CLAP_ID = "laion/clap-htsat-unfused"

# Six prompts across genres. Three sung (two English, one Arabic), three
# instrumental. Every one names a tempo, and four name a key, so "did it do what
# it was told" has something to check against.
PROMPTS = [
    {
        "id": "lofi",
        "genre": "lo-fi hip hop",
        "caption": "lo-fi hip hop beat, dusty boom-bap drums, mellow Rhodes electric piano, warm upright bass, vinyl crackle, relaxed late-night mood",
        "bpm": 80, "key": "F major", "lyrics": None,
    },
    {
        "id": "cinematic",
        "genre": "orchestral cinematic score",
        "caption": "cinematic orchestral score for a city travel montage, soaring strings, french horns, taiko drums, uplifting, builds to a big finish",
        "bpm": 100, "key": "D minor", "lyrics": None,
    },
    {
        "id": "house",
        "genre": "electronic dance music, deep house",
        "caption": "deep house track, four-on-the-floor kick, offbeat open hi-hats, warm sub bass, lush synth pads, club at sunrise",
        "bpm": 124, "key": "A minor", "lyrics": None,
    },
    {
        "id": "indiepop",
        "genre": "indie pop song",
        "caption": "upbeat indie pop, bright jangly electric guitar, handclaps, bouncy bass, female lead vocal, summer road trip",
        "bpm": 120, "key": "G major",
        "language": "en",
        "lyrics": (
            "[verse]\nWindows down on the coastal road\nSun on the dashboard, nowhere we need to go\n"
            "Radio humming a song we both know\nSinging it louder than the traffic below\n\n"
            "[chorus]\nOh, we're driving into the gold\nLeave the maps and the plans at home\n"
            "Every mile is a story told\nOh, we're driving into the gold"
        ),
    },
    {
        "id": "folk",
        "genre": "acoustic folk ballad",
        "caption": "gentle acoustic folk ballad, fingerpicked acoustic guitar, soft male vocal, light cello, intimate and warm",
        "bpm": 90, "key": None,
        "language": "en",
        "lyrics": (
            "[verse]\nThe kettle sings before the dawn\nThe fields are silver, the night is gone\n"
            "I kept your letters in a drawer\nI read them slowly like before\n\n"
            "[chorus]\nAnd I will wait by the river bend\nUntil the winter comes to an end"
        ),
    },
    {
        "id": "arabicpop",
        "genre": "Arabic pop with oud and darbuka",
        "caption": "modern Arabic pop song, oud melody, darbuka and riq percussion, string section, warm male vocal, festive",
        "bpm": 100, "key": None,
        "language": "ar",
        "lyrics": (
            "[verse]\nيا ليل طول واسهر معانا\nالقمر نور على بلدنا\nوالقلب فرحان بلقانا\n\n"
            "[chorus]\nيا حبيبي تعال نغني\nالليلة دي ليلة عمري\nيا حبيبي تعال نغني"
        ),
    },
]

# Timing: the same two prompts (one instrumental, one sung) at each length.
TIMING = [("lofi", d) for d in (30, 60, 180)] + [("indiepop", d) for d in (30, 60, 180)]
QUALITY_SECONDS = 60


def runs_plan():
    plan = [{"key": "warmup", "prompt": "lofi", "seconds": 30, "seed": 1, "warmup": True}]
    for p in PROMPTS:
        for s in SEEDS:
            plan.append({"key": f"{p['id']}-{QUALITY_SECONDS}s-seed{s}", "prompt": p["id"], "seconds": QUALITY_SECONDS, "seed": s})
    # A/B: the same prompt and seed with the planner allowed to rewrite the caption.
    for p in PROMPTS:
        plan.append({"key": f"{p['id']}-{QUALITY_SECONDS}s-seed{SEEDS[0]}-rewrite", "prompt": p["id"],
                     "seconds": QUALITY_SECONDS, "seed": SEEDS[0], "rewrite": True})
    # A/B: no LM planner at all — the DiT works from the caption alone. The
    # speed lever for video beds; this is what it costs in adherence.
    for p in PROMPTS:
        if not p["lyrics"]:
            plan.append({"key": f"{p['id']}-{QUALITY_SECONDS}s-seed{SEEDS[0]}-noplan", "prompt": p["id"],
                         "seconds": QUALITY_SECONDS, "seed": SEEDS[0], "noplan": True})
    for pid, d in TIMING:
        k = f"{pid}-{d}s-seed{SEEDS[0]}"
        if not any(r["key"] == k for r in plan):
            plan.append({"key": k, "prompt": pid, "seconds": d, "seed": SEEDS[0]})
    return plan


def load_json(p: Path, default):
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else default


def gen(args):
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = load_json(MANIFEST, {})
    by_id = {p["id"]: p for p in PROMPTS}
    for r in runs_plan():
        if r["key"] in manifest and manifest[r["key"]].get("ok"):
            continue
        if args.only and args.only not in r["key"]:
            continue
        p = by_id[r["prompt"]]
        form = {
            "task": "text2music",
            "caption": p["caption"],
            "instrumental": "false" if p["lyrics"] else "true",
            "lyrics": p["lyrics"] or "",
            "vocal_language": p.get("language", "en"),
            "duration": str(r["seconds"]),
            "seed": str(r["seed"]),
            "bpm": str(p["bpm"]),
            "keyscale": p["key"] or "",
            "thinking": "false" if r.get("noplan") else "true",
            "rewrite_caption": "true" if r.get("rewrite") else "false",
            "format": "flac",
        }
        t0 = time.time()
        res = requests.post(f"{CONSOLE}/api/labs/music/run", files={k: (None, v) for k, v in form.items()}, timeout=1200)
        wall = time.time() - t0
        j = res.json()
        entry = {**r, "ok": bool(j.get("ok")), "wall_s": round(wall, 2), "error": j.get("error"),
                 "latency_ms": j.get("latencyMs"), "peak_vram_gb": j.get("peakVramGb"), "baseline_vram_gb": j.get("baselineVramGb")}
        if j.get("ok"):
            t = j["output"]["track"]
            entry.update({"track_id": t["id"], "file": t["file"], "meta": t["meta"]})
        manifest[r["key"]] = entry
        MANIFEST.write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")
        m = entry.get("meta") or {}
        print(f"{r['key']:28s} ok={entry['ok']} {m.get('audio_seconds')}s in {m.get('latency_ms')}ms "
              f"torch_peak={m.get('peak_reserved_gb')}GB card_peak={entry['peak_vram_gb']} {entry['error'] or ''}", flush=True)


def stems(args):
    """Pull the vocals out of every sung track with the base DiT's extract task.

    Whisper on the full mix is not a fair test of sung lyrics here: the box's
    Whisper service runs with vad_filter=True, and Silero VAD drops singing
    over a band as non-speech — the indie-pop mixes came back as empty
    transcripts. Transcribing the isolated vocal stem measures the lyrics.
    """
    manifest = load_json(MANIFEST, {})
    by_id = {p["id"]: p for p in PROMPTS}
    todo = [e for e in manifest.values() if e.get("ok") and by_id[e["prompt"]]["lyrics"] and not e.get("stem_file")
            and e["seconds"] == QUALITY_SECONDS]
    if not todo:
        return
    swap = lambda d: requests.post(f"{CONSOLE}/api/music/engine", json={"dit": d}, timeout=600).raise_for_status()
    swap("acestep-v15-xl-base")
    try:
        for e in todo:
            src = MUSIC_DIR / e["file"]
            with open(src, "rb") as fh:
                j = requests.post(f"{CONSOLE}/api/labs/music/run", files={
                    "task": (None, "extract"), "track": (None, "vocals"), "seed": (None, "1"), "format": (None, "wav"),
                    "caption": (None, by_id[e["prompt"]]["caption"]),
                    "src_audio": (src.name, fh, "audio/flac")}, timeout=600).json()
            if j.get("ok"):
                e["stem_file"] = j["output"]["track"]["file"]
                e["stem_latency_ms"] = j["output"]["track"]["meta"]["latency_ms"]
            print(f"{e['key']:28s} stem ok={j.get('ok')} {j.get('error') or ''}", flush=True)
            MANIFEST.write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")
    finally:
        swap("acestep-v15-xl-turbo")


# ── scoring ──────────────────────────────────────────────────────────────────

KEYS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
ENHARMONIC = {"Db": "C#", "Eb": "D#", "Gb": "F#", "Ab": "G#", "Bb": "A#"}


def estimate_key(chroma_mean):
    best = None
    for i in range(12):
        for mode, prof in (("major", MAJOR), ("minor", MINOR)):
            c = np.corrcoef(np.roll(prof, i), chroma_mean)[0, 1]
            if best is None or c > best[0]:
                best = (c, f"{KEYS[i]} {mode}")
    return best[1]


def norm_key(k):
    if not k:
        return None
    k = k.strip().replace("♯", "#").replace("♭", "b")
    parts = k.split()
    root = parts[0][0].upper() + parts[0][1:]
    root = ENHARMONIC.get(root, root)
    mode = (parts[1] if len(parts) > 1 else "major").lower()
    return f"{root} {'minor' if mode.startswith('min') else 'major'}"


def relative(k):
    root, mode = k.split()
    i = KEYS.index(root)
    return f"{KEYS[(i + 3) % 12]} major" if mode == "minor" else f"{KEYS[(i - 3) % 12]} minor"


def clean_lyrics(s):
    s = re.sub(r"\[[^\]]*\]", " ", s)
    s = re.sub(r"[\u064B-\u0652\u0640]", "", s)  # Arabic diacritics and tatweel
    s = re.sub(r"[^\w\s']", " ", s.lower())
    return " ".join(s.split())


def score(args):
    import librosa
    import jiwer
    import torch
    from transformers import ClapModel, ClapProcessor

    manifest = load_json(MANIFEST, {})
    by_id = {p["id"]: p for p in PROMPTS}
    done = [e for e in manifest.values() if e.get("ok") and not e.get("warmup")]
    print(f"scoring {len(done)} tracks", flush=True)

    os.environ.setdefault("HF_HOME", r"D:\AI Models\huggingface")
    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
    # CPU: a 600 MB model is fast enough there, and the card is shared.
    dev = os.environ.get("SCORE_DEVICE", "cpu")
    clap = ClapModel.from_pretrained(CLAP_ID).to(dev).eval()
    proc = ClapProcessor.from_pretrained(CLAP_ID)
    genres = [p["genre"] for p in PROMPTS]
    captions = [p["caption"] for p in PROMPTS]
    with torch.no_grad():
        t_in = proc(text=[f"This is a {g} track." for g in genres] + captions, return_tensors="pt", padding=True).to(dev)
        temb = clap.get_text_features(**t_in)
        temb = temb / temb.norm(dim=-1, keepdim=True)
    g_emb, c_emb = temb[: len(genres)], temb[len(genres):]

    scores = {}
    for e in done:
        p = by_id[e["prompt"]]
        path = MUSIC_DIR / e["file"]
        y48, _ = librosa.load(str(path), sr=48000, mono=True)
        y22 = librosa.resample(y48, orig_sr=48000, target_sr=22050)
        s = {"key": e["key"], "prompt": e["prompt"], "seconds": e["seconds"], "seed": e["seed"], "rewrite": bool(e.get("rewrite")), "noplan": bool(e.get("noplan"))}

        # tempo
        tempo, _ = librosa.beat.beat_track(y=y22, sr=22050)
        est = float(np.atleast_1d(tempo)[0])
        want = p["bpm"]
        ratio = est / want
        s["bpm_asked"], s["bpm_planner"], s["bpm_measured"] = want, (e["meta"].get("resolved") or {}).get("bpm"), round(est, 1)
        s["bpm_ok"] = abs(ratio - 1) <= 0.04
        s["bpm_octave"] = not s["bpm_ok"] and any(abs(ratio * f - 1) <= 0.04 for f in (2, 0.5))

        # key
        chroma = librosa.feature.chroma_cqt(y=y22, sr=22050).mean(axis=1)
        k_est = estimate_key(chroma)
        s["key_asked"], s["key_measured"] = norm_key(p["key"]), k_est
        if p["key"]:
            s["key_ok"] = k_est == norm_key(p["key"])
            s["key_relative"] = not s["key_ok"] and k_est == relative(norm_key(p["key"]))

        # CLAP: 10 s windows averaged, since the model sees ~10 s at a time
        win = 48000 * 10
        chunks = [y48[i: i + win] for i in range(0, max(1, len(y48) - win + 1), win)][:6]
        with torch.no_grad():
            a_in = proc(audio=chunks, sampling_rate=48000, return_tensors="pt").to(dev)
            aemb = clap.get_audio_features(**a_in).mean(dim=0, keepdim=True)
            aemb = aemb / aemb.norm(dim=-1, keepdim=True)
        gi = PROMPTS.index(p)
        g_sim = (aemb @ g_emb.T)[0].cpu().numpy()
        c_sim = (aemb @ c_emb.T)[0].cpu().numpy()
        s["genre_top1"] = genres[int(g_sim.argmax())]
        s["genre_ok"] = int(g_sim.argmax()) == gi
        s["caption_rank"] = int((c_sim > c_sim[gi]).sum()) + 1
        s["caption_sim"] = round(float(c_sim[gi]), 3)

        # lyrics
        if p["lyrics"]:
            with open(path, "rb") as fh:
                r = requests.post(
                    f"{WHISPER}/v1/audio/transcriptions",
                    files={"file": (path.name, fh, "audio/flac")},
                    data={"model": "whisper-1", "language": p.get("language", "en")},
                    timeout=600,
                )
            hyp = r.json().get("text", "") if r.ok else ""
            # The prompt's lyrics are for the whole song; a 60 s clip may sing
            # only part of them. Score against the sung portion's length: the
            # reference prefix with as many words as Whisper heard (min: first
            # section), and also report the whole-reference WER.
            ref = clean_lyrics(p["lyrics"])
            h = clean_lyrics(hyp)
            s["transcript"] = hyp.strip()
            if e.get("stem_file"):
                with open(MUSIC_DIR / e["stem_file"], "rb") as fh:
                    r2 = requests.post(f"{WHISPER}/v1/audio/transcriptions", files={"file": (e["stem_file"], fh, "audio/wav")},
                                       data={"model": "whisper-1", "language": p.get("language", "en")}, timeout=600)
                s["stem_transcript"] = (r2.json().get("text", "") if r2.ok else "").strip()
            s["wer_full"] = round(jiwer.wer(ref, h), 3) if h else 1.0
            ref_words = ref.split()
            n = max(len(h.split()), len(clean_lyrics(p["lyrics"].split("\n\n")[0]).split()))
            s["wer_sung"] = round(jiwer.wer(" ".join(ref_words[:n]), h), 3) if h else 1.0
            if p.get("language") == "ar":
                s["cer_sung"] = round(jiwer.cer(" ".join(ref_words[:n]), h), 3) if h else 1.0
            if "stem_transcript" in s:
                hs = clean_lyrics(s["stem_transcript"])
                ns = max(len(hs.split()), len(clean_lyrics(p["lyrics"].split(chr(10) * 2)[0]).split()))
                s["wer_stem"] = round(jiwer.wer(" ".join(ref_words[:ns]), hs), 3) if hs else 1.0
                # Order-robust: of the words heard, how many align to the lyrics
                # at all. A clip that sings the chorus first scores badly on the
                # prefix WER above but well here, which is the truer reading.
                if hs:
                    o = jiwer.process_words(ref, hs)
                    s["word_precision_stem"] = round(o.hits / max(1, o.hits + o.substitutions + o.insertions), 3)
                    s["words_heard_stem"] = len(hs.split())
                if p.get("language") == "ar":
                    s["cer_stem"] = round(jiwer.cer(" ".join(ref_words[:ns]), hs), 3) if hs else 1.0

        scores[e["key"]] = s
        print(json.dumps({k: v for k, v in s.items() if k != "transcript"}, ensure_ascii=False), flush=True)

    SCORES.write_text(json.dumps(scores, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {SCORES}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("phase", choices=["gen", "stems", "score"])
    ap.add_argument("--only", help="substring filter on run keys")
    a = ap.parse_args()
    {"gen": gen, "stems": stems, "score": score}[a.phase](a)
