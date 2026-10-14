"""Build a local narrated walkthrough from verified UI captures. Requires local Kokoro and FFmpeg.

Screenshots and the resulting video stay gitignored; no service keys or hosted generation are used.
"""
import json
from pathlib import Path
import shutil
import subprocess
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
CAPTURES = ROOT / "design-qa-artifacts"
WORK = ROOT / "var/audio-walkthrough"
OUTPUT = ROOT / "public/walkthroughs/hangar-audio-lab-20261015.mp4"
SCENES = [
    ("home.png", "Hangar now has a persistent workstream sidebar. Audio, Visual, Chat and Code, and Decisions and Processes have clear places. Services, models, requests, usage, and storage remain available below. The existing tools keep their routes and saved work."),
    ("audio-light.png", "Audio Lab starts with the tank pilot. Mechanical attack, blast body, and outdoor tail are separate layers. Select a layer to adjust gain, pan, timing, pitch, fades, and filtering. Render variation creates a new saved file. The original sources stay intact."),
    ("audio-library.png", "The project library keeps effects and crew takes together. Each revision stores its recipe, measured peak, notes, and review status. Loading an older revision creates an editable draft. Approval records your decision; it does not install or publish a sound. The existing sound bake-off is still reachable."),
    ("voices.png", "Voices and Speech adds a tank crew director above the existing speech tools. The pilot uses Kokoro's Michael voice consistently for selection, movement, attack, and taking fire. Delivery speed and a radio low-pass are explicit controls. General speech synthesis and the existing voice-cloning tools remain below."),
    ("speech-recognition.png", "Speech Recognition is a separate destination. Microphone recording, audio-file recognition, and dictation remain available. Here the local recognizer correctly reads the synthetic line: Tank crew ready. Recognition and speech generation still have separate model choices."),
    ("music.png", "Music Lab retains its existing generation and editing workflow, including lyrics, reference audio, extension, repainting, and remixing. Its saved gallery is preserved. The sidebar brings music into Audio without replacing the engine or moving your tracks."),
    ("visual.png", "Visual groups Image Studio, Video Studio, Video Lab, Video Forge, Mask and Segment, and the three D Lab. Their original controls, queues, libraries, and resource checks remain in place. Chat, model comparison, decisions, and process experiments remain separate workstreams."),
    ("viewer.png", "Audition in Faction Viewer opens the actual tank with the exact saved audio revision. The local preview banner identifies the candidate. Hear current game switches back for comparison, and Clear preview restores normal playback. The preview checks the unit and revision before enabling a replacement. The engine loop is a manual audition rather than a native movement integration."),
    ("audio-dark.png", "The same workspace supports light and dark themes. Waveforms come from the real audio, rendered revisions are stored locally, and the game installation is unchanged. The new workflow is ready for iterative sound design: edit, render, compare, audition in context, and review."),
]

def run(*args):
    subprocess.run(list(map(str, args)), check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

WORK.mkdir(parents=True, exist_ok=True)
OUTPUT.parent.mkdir(parents=True, exist_ok=True)
ffmpeg, ffprobe = shutil.which("ffmpeg"), shutil.which("ffprobe")
if not ffmpeg or not ffprobe:
    raise RuntimeError("Install FFmpeg before producing the walkthrough")
records = []
for i, (image, words) in enumerate(SCENES):
    if not (CAPTURES / image).exists():
        raise FileNotFoundError(CAPTURES / image)
    voice = WORK / f"scene-{i:02}.wav"
    request = urllib.request.Request("http://localhost:8002/v1/audio/speech", data=json.dumps({"model": "kokoro", "input": words, "voice": "am_michael", "speed": 1.0, "response_format": "wav"}).encode(), headers={"Content-Type": "application/json", "X-Source": "hangar-walkthrough"}, method="POST")
    with urllib.request.urlopen(request, timeout=120) as response:
        voice.write_bytes(response.read())
    duration = float(subprocess.check_output([ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", str(voice)]).decode().strip()) + .7
    clip = WORK / f"scene-{i:02}.mp4"
    run(ffmpeg, "-nostdin", "-y", "-loop", "1", "-framerate", "30", "-i", CAPTURES / image, "-i", voice,
        "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x151515,setsar=1,format=yuv420p",
        "-af", "loudnorm=I=-18:TP=-1.5:LRA=8,apad=pad_dur=0.7", "-t", f"{duration:.3f}", "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", clip)
    records.append({"capture": image, "narration": words, "seconds": duration, "voice": "Kokoro am_michael"})
    print(f"Scene {i+1}/{len(SCENES)}: {duration:.1f}s", flush=True)
concat = WORK / "concat.txt"
concat.write_text("\n".join(f"file '{(WORK/f'scene-{i:02}.mp4').as_posix()}'" for i in range(len(SCENES))), "utf-8")
run(ffmpeg, "-nostdin", "-y", "-f", "concat", "-safe", "0", "-i", concat, "-c", "copy", "-movflags", "+faststart", "-metadata", "title=Hangar Audio Lab walkthrough", OUTPUT)
(WORK / "walkthrough.json").write_text(json.dumps({"video": str(OUTPUT), "format": "Narrated walkthrough of verified local UI screenshots", "scenes": records}, indent=2), "utf-8")
print(f"Walkthrough: {OUTPUT}", flush=True)
