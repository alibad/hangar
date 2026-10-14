"""Prepare redistributable CC0 pilot stems using the existing local sound renderer.

Usage: <sound-stack-python> scripts/build-audio-pilot.py <rtsai-sound-root> <RTSAI-Web-root>
The source library and generation environments stay outside this repository.
"""
import copy
import hashlib
import json
from pathlib import Path
import sys

sound_root, web_root = map(Path, sys.argv[1:3])
sys.path.insert(0, str(sound_root / "scripts"))
import sfxlib as S
from design_cc0 import RECIPES

out = Path(__file__).resolve().parent.parent / "public/audio-lab/pilot"
out.mkdir(parents=True, exist_ok=True)
catalog = json.loads((web_root / "data/art-lab.json").read_text("utf-8"))
actor = catalog["actors"]["r2m1a2s"]
source_index = json.loads((sound_root / "sources/SOURCES.json").read_text("utf-8"))
events, provenance = [], []
specs = [
    ("main-gun", "Tank main gun", "weapon:report", "tank_main_gun", [[0, 1, 4], [2, 3], [5]], ["Mechanical attack", "Blast body", "Outdoor tail"]),
    ("impact", "Armour impact", "weapon:impact", "armour_impact", [[0, 2], [1], [3]], ["Metal body", "Bright impact", "Ricochet tail"]),
    ("destruction", "Tank destruction", "death:explosion", "large_explosion", [[0, 1], [2, 3], [4, 5, 6, 7, 8]], ["Initial crack", "Explosion body", "Debris tail"]),
]
engine = next((k for k in RECIPES if "engine" in k), None)
if engine:
    count = len(RECIPES[engine]["layers"])
    specs.append(("engine", "Engine loop", "movement", engine, [list(range(count))], ["Tracked engine"]))
for event, title, kind, key, groups, names in specs:
    original = RECIPES[key]
    length = original["bus"].get("loop", {}).get("length", original["bus"].get("length", 5))
    layers = []
    for i, indexes in enumerate(groups):
        recipe = {"layers": [copy.deepcopy(original["layers"][j]) for j in indexes], "bus": {"length": length, "fade_out": .06}}
        rendered = S.render(recipe)
        filename = f"{event}-{i}.wav"
        S.write(out / filename, rendered)
        layers.append({"id": f"{event}-{i}", "name": names[i], "url": f"/audio-lab/pilot/{filename}", "duration": len(rendered)/S.SR, "start": 0, "end": len(rendered)/S.SR, "offset": 0, "gainDb": 0 if i == 0 else -6, "pitch": 0, "fadeIn": 0, "fadeOut": .03, "lowpass": 20000, "pan": 0, "muted": False, "solo": False})
        public_layers = []
        for layer in recipe["layers"]:
            local = str((S.SOURCES / layer["src"]).resolve())
            match = next((s for s in source_index if str(Path(s.get("local_path", "")).resolve()) == local), None)
            if not match or "CC0" not in match.get("licence", ""):
                raise ValueError(f"Unresolved CC0 source: {layer['src']}")
            public_layers.append({**layer, "src": Path(layer["src"]).name, "sha256": S.sha256(layer["src"]), "author": match.get("author"), "license": match["licence"], "source": match.get("page") or match.get("archive_url") or match.get("url")})
        provenance.append({"file": filename, "sha256": hashlib.sha256((out/filename).read_bytes()).hexdigest(), "sources": public_layers, "processing": recipe["bus"]})
    baseline = S.render(original)
    S.write(out / f"{event}-reference.wav", baseline)
    # CC0 design reference, explicitly not labelled the current installed game sound.
    events.append({"id": event, "label": title, "kind": kind, "currentUrl": f"/audio-lab/pilot/{event}-reference.wav", "recipe": {"layers": layers, "length": length, "loop": event == "engine", "notes": "Heavy metallic punch. Short outdoor tail." if event == "main-gun" else original["note"]}, "note": "Engine loop is a browser audition; native movement binding must be verified separately." if event == "engine" else None})
pilot = {"name": "RTS AI / Tank pilot", "actor": actor["id"], "faction": "saudi-arabia", "actorName": actor["name"], "viewerOrigin": "http://127.0.0.1:3462", "events": events, "provenance": {"license": "CC0 1.0", "sources": provenance, "recipeSource": "RTS AI sound bake-off / design_cc0.py; prepared as independent editable stems"}}
(out / "project.json").write_text(json.dumps(pilot, ensure_ascii=False, indent=2), "utf-8")
print(f"Prepared {len(events)} events and {len(provenance)} licensed stems for {actor['name']}")
