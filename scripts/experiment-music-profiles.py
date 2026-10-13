"""
Which ACE-Step configuration can live on this card next to what is always on?

BeTenshi's 32 GB is shared: quote-forge's vllm-small (13 GB) is resident, and
Laya, Whisper, Kokoro and Chatterbox come and go. So "the footprint" is a
choice, not a number. This starts the music service once per profile, records
what it holds resident, runs the same two generations, samples the card-wide
peak with nvidia-smi, and stops it again.

    C:\\Users\\Admin\\Code\\AI\\music\\.venv\\Scripts\\python.exe scripts\\experiment-music-profiles.py [profile ...]

Writes experiments/music/profiles.json. Talks to the service directly (not the
console), and launches it itself, so nothing else may hold :8014.
"""
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "experiments" / "music" / "profiles.json"
MUSIC = Path(r"C:\Users\Admin\Code\AI\music")
PY = MUSIC / ".venv" / "Scripts" / "python.exe"
URL = "http://127.0.0.1:8014"

PROFILES = {
    "xl+1.7b": {"MUSIC_LM": "acestep-5Hz-lm-1.7B"},
    "xl+1.7b offload": {"MUSIC_LM": "acestep-5Hz-lm-1.7B", "MUSIC_OFFLOAD": "1"},
    "xl+4b offload+lm-offload": {"MUSIC_LM": "acestep-5Hz-lm-4B", "MUSIC_OFFLOAD": "1", "MUSIC_OFFLOAD_LM": "1"},
    "xl+1.7b offload+lm-offload": {"MUSIC_LM": "acestep-5Hz-lm-1.7B", "MUSIC_OFFLOAD": "1", "MUSIC_OFFLOAD_LM": "1"},
    "xl+4b": {"MUSIC_LM": "acestep-5Hz-lm-4B"},
    # The 2B turbo DiT from the main pack: the one that fits beside vllm-small.
    "2b+1.7b offload+lm-offload": {"MUSIC_DIT": "acestep-v15-turbo", "MUSIC_LM": "acestep-5Hz-lm-1.7B",
                                   "MUSIC_OFFLOAD": "1", "MUSIC_OFFLOAD_LM": "1"},
    "2b+1.7b": {"MUSIC_DIT": "acestep-v15-turbo", "MUSIC_LM": "acestep-5Hz-lm-1.7B"},
    # XL quality in the space beside vllm-small, if int8 holds up.
    "xl-int8+1.7b offload+lm-offload": {"MUSIC_LM": "acestep-5Hz-lm-1.7B", "MUSIC_OFFLOAD": "1",
                                        "MUSIC_OFFLOAD_LM": "1", "MUSIC_QUANT": "int8_weight_only"},
    "xl-int8+4b offload+lm-offload": {"MUSIC_LM": "acestep-5Hz-lm-4B", "MUSIC_OFFLOAD": "1",
                                      "MUSIC_OFFLOAD_LM": "1", "MUSIC_QUANT": "int8_weight_only"},
}
# Free VRAM a profile needs before it is tried at all (GB, generous). A profile
# that cannot fit is skipped and recorded as such, rather than OOM-ing into the
# allocations of services that share the card.
NEEDS_FREE_GB = {"xl+1.7b": 20, "xl+1.7b offload": 19, "xl+4b offload+lm-offload": 14,
                 "xl+1.7b offload+lm-offload": 13, "xl+4b": 26,
                 "2b+1.7b offload+lm-offload": 8, "2b+1.7b": 12,
                 "xl-int8+1.7b offload+lm-offload": 9, "xl-int8+4b offload+lm-offload": 9.5}
TOTAL_GB = 31.84

JOBS = [
    {"name": "30s instrumental", "task": "text2music", "caption": "lo-fi hip hop beat, dusty drums, mellow Rhodes piano, vinyl crackle",
     "instrumental": "true", "duration": "30", "seed": "11", "bpm": "80"},
    {"name": "60s sung", "task": "text2music",
     "caption": "upbeat indie pop, bright jangly electric guitar, handclaps, female lead vocal",
     "instrumental": "false", "lyrics": "[verse]\nWindows down on the coastal road\nSun on the dashboard, nowhere we need to go\n\n[chorus]\nOh, we're driving into the gold",
     "vocal_language": "en", "duration": "60", "seed": "11", "bpm": "120"},
]


def card_used_gb() -> float:
    out = subprocess.run(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
                         capture_output=True, text=True).stdout
    return round(int(out.strip().splitlines()[0]) / 1024, 2)


class Peak:
    def __init__(self):
        self.value = 0.0
        self._stop = threading.Event()
        self._t = threading.Thread(target=self._run, daemon=True)

    def _run(self):
        while not self._stop.is_set():
            self.value = max(self.value, card_used_gb())
            time.sleep(0.25)

    def __enter__(self):
        self._t.start()
        return self

    def __exit__(self, *a):
        self._stop.set()
        self._t.join()


def run_profile(name, env_extra):
    env = {**os.environ, "ACESTEP_CHECKPOINTS_DIR": r"D:\AI Models\acestep", "HF_HOME": r"D:\AI Models\huggingface",
           "HF_HUB_DISABLE_XET": "1", "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1", **env_extra}
    before = card_used_gb()
    if TOTAL_GB - before < NEEDS_FREE_GB[name]:
        print(f"  {name}: skipped, {TOTAL_GB - before:.1f} GB free < {NEEDS_FREE_GB[name]} GB", flush=True)
        return {"profile": name, "env": env_extra, "card_before_gb": before,
                "skipped": f"{TOTAL_GB - before:.1f} GB free, needs ~{NEEDS_FREE_GB[name]} GB"}
    log = open(ROOT / "experiments" / "music" / f"profile-{name.replace(' ', '_').replace('+', 'p')}.log", "w", encoding="utf-8")
    proc = subprocess.Popen([str(PY), "-m", "uvicorn", "server:app", "--host", "127.0.0.1", "--port", "8014"],
                            cwd=str(MUSIC), env=env, stdout=log, stderr=subprocess.STDOUT)
    res = {"profile": name, "env": env_extra, "card_before_gb": before}
    try:
        t0 = time.time()
        with Peak() as load_peak:
            while True:
                if proc.poll() is not None:
                    raise RuntimeError(f"service exited during load (code {proc.returncode}); see the profile log")
                try:
                    st = requests.get(f"{URL}/status", timeout=2).json()
                    if st.get("phase") == "ready":
                        break
                    if st.get("phase") == "error":
                        raise RuntimeError(st.get("error"))
                except requests.RequestException:
                    pass
                if time.time() - t0 > 600:
                    raise RuntimeError("load timed out")
                time.sleep(1)
        time.sleep(3)
        res.update({
            "load_s": round(time.time() - t0, 1),
            "load_peak_card_gb": load_peak.value,
            "resident_card_gb": card_used_gb(),
            "resident_delta_gb": round(card_used_gb() - before, 2),
            "resident_torch": st.get("vram"),
        })
        res["jobs"] = []
        for job in JOBS:
            with Peak() as p:
                t1 = time.time()
                r = requests.post(f"{URL}/v1/music/generate", files={k: (None, v) for k, v in job.items() if k != "name"}, timeout=1200)
                wall = time.time() - t1
            if not r.ok:
                res["jobs"].append({"name": job["name"], "error": r.text[:300]})
                continue
            import base64
            meta = json.loads(base64.b64decode(r.headers["x-music-meta"]))
            res["jobs"].append({
                "name": job["name"], "wall_s": round(wall, 2), "audio_s": meta["audio_seconds"],
                "peak_card_gb": p.value, "peak_delta_gb": round(p.value - before, 2),
                "torch_peak_reserved_gb": meta.get("peak_reserved_gb"),
                "lm_s": meta["time_costs"].get("lm_total_time"), "dit_s": meta["time_costs"].get("dit_total_time_cost"),
            })
            print(f"  {name}: {res['jobs'][-1]}", flush=True)
    except Exception as e:
        res["error"] = str(e)
        print(f"  {name}: ERROR {e}", flush=True)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            proc.kill()
        log.close()
        time.sleep(5)
    return res


def main():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    wanted = sys.argv[1:] or list(PROFILES)
    results = json.loads(OUT.read_text()) if OUT.exists() else {}
    for name in wanted:
        print(f"profile {name}", flush=True)
        results[name] = run_profile(name, PROFILES[name])
        OUT.write_text(json.dumps(results, indent=2))
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
