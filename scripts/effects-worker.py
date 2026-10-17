"""One offline CPU generation. The parent owns serialization, timeout and persistence.

Use an existing stable-audio-3 environment; never installs or downloads anything.
Request JSON arrives on stdin. Only output.wav is written in the supplied scratch dir.
"""
import json
import os
import sys
from pathlib import Path

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["CUDA_VISIBLE_DEVICES"] = ""
os.environ["TOKENIZERS_PARALLELISM"] = "false"


def main():
    request = json.load(sys.stdin)
    import numpy as np
    import soundfile as sf
    import torch
    from scipy.signal import resample_poly
    from stable_audio_3 import StableAudioModel

    torch.set_num_threads(4)
    model = StableAudioModel.from_pretrained("small-sfx", device="cpu", model_half=False)
    audio = model.generate(prompt=request["prompt"], duration=request["length"], seed=request["seed"], steps=8, cfg_scale=1.0)
    samples = audio[0].float().cpu().numpy().T
    sr = model.model.sample_rate
    if sr != 48000:
        from math import gcd
        divisor = gcd(sr, 48000)
        samples = resample_poly(samples, 48000 // divisor, sr // divisor, axis=0)
    count = round(request["length"] * 48000)
    samples = samples[:count]
    if samples.shape != (count, 2) or not np.isfinite(samples).all():
        raise ValueError("The generator returned invalid audio")
    peak = float(np.max(np.abs(samples)))
    if peak < 1e-6:
        raise ValueError("The generator returned silence; try another description or seed")
    samples *= min(1.0, 10 ** (-2 / 20) / peak)
    sf.write(Path(sys.argv[1]) / "output.wav", samples, 48000, subtype="PCM_16")


if __name__ == "__main__":
    main()
