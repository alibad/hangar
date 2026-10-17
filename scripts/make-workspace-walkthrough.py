"""Narrated local UI walkthrough. Capture real pages before running this script.

Uses the local Kokoro endpoint and FFmpeg. Captures, speech, and video stay local.
"""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
SCENES = [
    ("home-light-reference.jpg", "Hangar now uses one workspace design across all twenty destinations. Audio, Visual, Chat and Code, and Decisions and Processes organize the tools. The sidebar collapses into a rail of destinations. Machine capacity, service status, and Control K stay in the header."),
    ("effects-general-rendered-light.jpg", "Effects is a general sound workspace. Start a named sound, import a recording with its source note, and shape separate layers. Gain, pan, timing, pitch, fades, and filtering remain available. This variation was rendered locally, saved, played back, and exported as a wave file."),
    ("effects-picker-light.jpg", "The sound menu keeps your own sounds separate from optional examples and saved takes. The tank pilot still supports an external Faction Viewer audition. It is an example project, and does not define Hangar's navigation or general sound workflow."),
    ("voices-light-reference.jpg", "Voices and Speech starts with your own script and voice. The existing model selection, synthesis, and voice tools remain available. The character voice experiment is in an expandable section below, so it does not get in the way of ordinary narration."),
    ("recognition-light-reference.jpg", "Speech Recognition has a source and a transcript review area. Record or upload audio, review the recognized text, correct it, and copy the result. Recognition errors appear separately from transcript text. Generation and recognition retain their own model choices."),
    ("music-light-reference.jpg", "Music keeps its existing engine, prompts, lyrics, reference audio, editing tasks, and saved gallery. The main task sits beside Model and Runtime. The redesign keeps these workflows and files in place while giving them the same workspace structure."),
    ("image-light-reference.jpg", "Image Studio keeps Generate, Edit, Batch, Compare, Evaluation, Jobs, and Activity. Runtime verification is a compact disclosure. Model and service details sit beside the workbench, with the persistent gallery below. No model is started just by opening a page."),
    ("video-lab-light-reference.jpg", "The visual workstream also retains Video Studio, Video Lab, Video Forge, Mask and Segment, and the three D Lab. Media tools use more space for previews and move controls into a contextual panel. On a phone, these sections stack without pushing controls off screen."),
    ("services-light-reference.jpg", "Services adds a searchable list and a selected service inspector. The original card view, lifecycle controls, logs, and memory details remain available. Models, Requests, AI Usage, and Storage keep their existing data and controls under the shared navigation."),
    ("effects-dark.jpg", "Light and dark use the same layouts and existing theme palettes. Expanded pickers use the app's own components, with keyboard selection and focus states. The redesign stays local: your sources, drafts, generated media, and experiment integrations keep their existing storage and execution paths."),
]


def run(*args):
    result = subprocess.run(list(map(str, args)), capture_output=True)
    if result.returncode:
        raise RuntimeError(result.stderr.decode(errors="replace")[-3000:])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--captures", type=Path, default=ROOT / "var/design-qa-20261018")
    parser.add_argument("--output", type=Path, default=ROOT / "public/walkthroughs/hangar-workspace-20261018.mp4")
    parser.add_argument("--reuse-voice", action="store_true", help="Keep existing Michael narration when updating UI captures")
    args = parser.parse_args()
    work = ROOT / "var/workspace-walkthrough"
    work.mkdir(parents=True, exist_ok=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    ffmpeg, ffprobe = shutil.which("ffmpeg"), shutil.which("ffprobe")
    if not ffmpeg or not ffprobe:
        raise RuntimeError("FFmpeg and FFprobe are required")
    for capture, _ in SCENES:
        if not (args.captures / capture).is_file():
            raise FileNotFoundError(args.captures / capture)
    records = []
    for i, (capture, words) in enumerate(SCENES):
        voice = work / f"scene-{i:02}.wav"
        request = urllib.request.Request("http://127.0.0.1:8002/v1/audio/speech", data=json.dumps({"model": "kokoro", "input": words, "voice": "am_michael", "speed": 1.0, "response_format": "wav"}).encode(), headers={"Content-Type": "application/json", "X-Source": "hangar-workspace-walkthrough"}, method="POST")
        if not args.reuse_voice or not voice.is_file():
            with urllib.request.urlopen(request, timeout=180) as response:
                voice.write_bytes(response.read())
        duration = float(subprocess.check_output([ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", voice]).decode().strip()) + .6
        clip = work / f"scene-{i:02}.mp4"
        run(ffmpeg, "-nostdin", "-y", "-threads", "2", "-filter_threads", "2", "-loop", "1", "-framerate", "24", "-i", args.captures / capture, "-i", voice,
            "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0xf6f4f0,setsar=1,format=yuv420p",
            "-af", "loudnorm=I=-18:TP=-1.5:LRA=8,apad=pad_dur=0.6", "-t", f"{duration:.3f}", "-c:v", "libx264", "-threads", "2", "-preset", "fast", "-crf", "19", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2", clip)
        records.append({"capture": capture, "narration": words, "seconds": duration, "voice": "Kokoro am_michael"})
        print(f"Scene {i+1}/{len(SCENES)}: {duration:.1f}s", flush=True)
    concat = work / "concat.txt"
    concat.write_text("\n".join(f"file '{(work/f'scene-{i:02}.mp4').as_posix()}'" for i in range(len(SCENES))), "utf-8")
    run(ffmpeg, "-nostdin", "-y", "-f", "concat", "-safe", "0", "-i", concat, "-c", "copy", "-movflags", "+faststart", "-metadata", "title=Hangar workspace walkthrough", args.output)
    (work / "walkthrough.json").write_text(json.dumps({"video": str(args.output), "format": "Narrated walkthrough of verified local UI captures", "scenes": records}, indent=2), "utf-8")
    print(args.output, flush=True)


if __name__ == "__main__":
    main()
