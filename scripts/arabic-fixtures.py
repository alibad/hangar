"""Render the OCR fixtures for the Arabic model comparison.

    python scripts/arabic-fixtures.py

Reads `config/arabic-eval.json`, writes PNG/JPEG fixtures plus a manifest to
`var/arabic-eval/fixtures/`. Deterministic: same corpus in, byte-identical
images out, so a re-run of the experiment compares models rather than noise.

── Why render at all, instead of collecting real Arabic documents ────────────
Because CER needs ground truth, and ground truth for a found document has to be
typed by hand — which is both laborious and itself error-prone, and the errors
land in the denominator of every model's score. Rendering inverts that: the
ground truth is the input. The cost is that clean renders flatter every model,
which is exactly why `ocr-degraded` and the two real Wikimedia specimens are in
the corpus alongside them.

── Why arabic-reshaper and python-bidi ───────────────────────────────────────
Pillow on this box has no Raqm/HarfBuzz (`PIL.features.check("raqm")` is False),
so it cannot shape complex scripts: drawing Arabic directly produces isolated,
left-to-right, unjoined letters — legible to nobody and unfair to every model.

So the shaping is done before drawing:
  1. `arabic_reshaper` substitutes each letter's contextual form (initial /
     medial / final / isolated) from the Unicode presentation-forms block.
  2. `python-bidi` applies the UAX#9 bidirectional algorithm to put the shaped
     glyphs in visual order, which is what a dumb LTR renderer needs.

The consequence for scoring is important enough to be stated twice: the GROUND
TRUTH stays the original logical string, never the reshaped one. The reshaped
form exists only inside this file. `normalizeArabic()` in src/lib/text-scoring.ts
folds presentation forms back to base letters so a model typing ordinary Arabic
matches the fixture — see the ligature note there.
"""
from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path

import arabic_reshaper
from bidi.algorithm import get_display
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
CORPUS = ROOT / "config" / "arabic-eval.json"
OUT = ROOT / "var" / "arabic-eval" / "fixtures"
# The Wikimedia specimen corpus lives in the sibling magic-redact repo. It is
# gitignored there (re-fetchable via samples/fetch_specimens.py), so a missing
# file is a skip with a reason, never a crash.
SPECIMENS = ROOT.parent / "magic-redact" / "samples" / "images"
FONT_DIR = Path("C:/Windows/Fonts")

WIDTH = 1240
MARGIN = 48
BG = (255, 255, 255)
FG = (17, 17, 17)

# Reshaper config: keep the harakat, because `ocr-tashkeel` exists precisely to
# test whether a model reproduces them. The default drops them.
RESHAPER = arabic_reshaper.ArabicReshaper(
    configuration={"delete_harakat": False, "support_ligatures": True}
)


def shape(text: str) -> str:
    """Logical Arabic -> visually ordered, contextually shaped glyphs."""
    return get_display(RESHAPER.reshape(text))


def load_font(name: str, size: int) -> ImageFont.FreeTypeFont:
    path = FONT_DIR / name
    if not path.exists():
        raise SystemExit(f"font not found: {path}")
    return ImageFont.truetype(str(path), size)


def text_width(draw: ImageDraw.ImageDraw, s: str, font: ImageFont.FreeTypeFont) -> int:
    return int(draw.textlength(s, font=font))


def wrap_rtl(draw, logical: str, font, max_width: int) -> list[str]:
    """Greedy word wrap measured on the SHAPED form, returned as shaped lines.

    Wrapping has to happen in logical order (words are appended right-to-left in
    reading order) but measured after shaping, because shaping changes width:
    joined letterforms are narrower than isolated ones, sometimes by a lot. Wrap
    on the unshaped string and lines overflow the canvas.
    """
    lines: list[str] = []
    for paragraph in logical.split("\n"):
        if not paragraph.strip():
            lines.append("")
            continue
        current: list[str] = []
        for word in paragraph.split(" "):
            trial = current + [word]
            if current and text_width(draw, shape(" ".join(trial)), font) > max_width:
                lines.append(shape(" ".join(current)))
                current = [word]
            else:
                current = trial
        if current:
            lines.append(shape(" ".join(current)))
    return lines


def render_paragraph(logical: str, font_name: str, size: int) -> Image.Image:
    font = load_font(font_name, size)
    probe = Image.new("RGB", (WIDTH, 10), BG)
    draw = ImageDraw.Draw(probe)
    lines = wrap_rtl(draw, logical, font, WIDTH - 2 * MARGIN)

    line_h = int(size * 1.85)  # generous: Arabic ascenders/descenders and harakat
    height = MARGIN * 2 + max(1, len(lines)) * line_h
    img = Image.new("RGB", (WIDTH, height), BG)
    draw = ImageDraw.Draw(img)
    y = MARGIN
    for line in lines:
        # Right-aligned, because that is where Arabic starts. Rendering it
        # left-aligned would be a layout a reader never sees.
        x = WIDTH - MARGIN - text_width(draw, line, font)
        draw.text((x, y), line, font=font, fill=FG)
        y += line_h
    return img


def render_invoice(logical: str, font_name: str, size: int) -> Image.Image:
    """Lay the invoice out as an actual document: header block, ruled table, total.

    A table rendered as flowing text would test reading, not document
    understanding — and document understanding is the whole reason this item is
    in the corpus. Columns are placed right-to-left so the first column sits on
    the right, as it does on a real Arabic invoice.
    """
    font = load_font(font_name, size)
    bold = load_font("arialbd.ttf" if font_name == "arial.ttf" else font_name, size)
    title_font = load_font("arialbd.ttf" if font_name == "arial.ttf" else font_name, int(size * 1.5))

    header: list[str] = []
    rows: list[list[str]] = []
    footer: list[str] = []
    title = ""
    for raw in logical.split("\n"):
        line = raw.strip()
        if not line:
            continue
        if "|" in line:
            rows.append([c.strip() for c in line.split("|")])
        elif not title:
            title = line
        elif rows:
            footer.append(line)
        else:
            header.append(line)

    line_h = int(size * 1.9)
    height = MARGIN * 2 + int(size * 2.4) + (len(header) + len(rows) + len(footer) + 3) * line_h
    img = Image.new("RGB", (WIDTH, height), BG)
    draw = ImageDraw.Draw(img)

    right = WIDTH - MARGIN
    y = MARGIN
    if title:
        s = shape(title)
        draw.text((right - text_width(draw, s, title_font), y), s, font=title_font, fill=FG)
        y += int(size * 2.4)

    for line in header:
        s = shape(line)
        draw.text((right - text_width(draw, s, font), y), s, font=font, fill=FG)
        y += line_h

    y += int(line_h * 0.4)
    # Column anchors, right-to-left: item description, quantity, price.
    anchors = [right, right - 620, right - 820]
    for idx, row in enumerate(rows):
        f = bold if idx == 0 else font
        for cell, anchor in zip(row, anchors):
            s = shape(cell)
            draw.text((anchor - text_width(draw, s, f), y), s, font=f, fill=FG)
        y += line_h
        if idx == 0:
            draw.line([(MARGIN, y - int(line_h * 0.25)), (right, y - int(line_h * 0.25))], fill=(120, 120, 120), width=2)

    y += int(line_h * 0.3)
    draw.line([(MARGIN, y), (right, y)], fill=(120, 120, 120), width=2)
    y += int(line_h * 0.35)
    for line in footer:
        s = shape(line)
        draw.text((right - text_width(draw, s, bold), y), s, font=bold, fill=FG)
        y += line_h
    return img


def degrade(img: Image.Image, level: str = "mild") -> Image.Image:
    """Approximate a photo of a printed page: skew, softness, noise, JPEG.

    Two tiers, both fixed-seed and reproducible:

    `mild` is a good phone capture — the original intent, kept because it is the
    realistic common case.

    `heavy` exists because `mild` turned out not to discriminate: on the first
    run Gemma 4 read it at 0% CER, same as the clean render, so the item was
    measuring nothing. This tier halves the resolution (the single most punishing
    transform for Arabic, whose letters differ by dot count and position),
    skews further, adds an uneven lighting gradient, and compresses harder.

    The point is still a page a person could squint at, not an unreadable one:
    an item nobody can read separates models no better than one everybody aces.
    """
    import io
    import random

    heavy = level == "heavy"
    out = img
    if heavy:
        # Downscale first, then let JPEG work on the smaller image: that is the
        # order a real camera-and-upload pipeline applies them in.
        out = out.resize((out.width // 2, out.height // 2), Image.BICUBIC)

    out = out.rotate(3.5 if heavy else 1.5, resample=Image.BICUBIC, expand=True, fillcolor=BG)
    out = out.filter(ImageFilter.GaussianBlur(0.9 if heavy else 0.6))

    rng = random.Random(20260914)  # fixed seed: the fixture must be reproducible
    px = out.load()
    w, h = out.size
    amp = 26 if heavy else 16
    step = 1 if heavy else 2
    for yy in range(0, h, step):
        for xx in range(0, w, step):
            r, g, b = px[xx, yy]
            # Lighting gradient: one corner falls into shadow, as when a hand or
            # the phone itself shades the page.
            shade = 1.0 - 0.28 * ((xx / w) * 0.6 + (yy / h) * 0.4) if heavy else 1.0
            n = rng.randint(-amp, amp)
            px[xx, yy] = tuple(max(0, min(255, int(c * shade) + n)) for c in (r, g, b))

    buf = io.BytesIO()
    out.save(buf, format="JPEG", quality=18 if heavy else 30)
    buf.seek(0)
    return Image.open(buf).convert("RGB")


def main() -> None:
    corpus = json.loads(CORPUS.read_text(encoding="utf-8"))
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = []

    for item in corpus["ocr"]:
        item_id = item["id"]
        if item["kind"] == "specimen":
            src = SPECIMENS / item["file"]
            if not src.exists():
                print(f"SKIP {item_id}: specimen missing at {src}")
                print("     re-fetch with: python samples/fetch_specimens.py --limit 100")
                continue
            dst = OUT / (item_id + src.suffix)
            shutil.copyfile(src, dst)
        else:
            if item.get("layout") == "invoice":
                img = render_invoice(item["text"], item["font"], item["size"])
            else:
                img = render_paragraph(item["text"], item["font"], item["size"])
            if item.get("degrade"):
                level = item["degrade"] if isinstance(item["degrade"], str) else "mild"
                img = degrade(img, level)
                dst = OUT / f"{item_id}.jpg"
                img.save(dst, format="JPEG", quality=18 if level == "heavy" else 30)
            else:
                dst = OUT / f"{item_id}.png"
                img.save(dst, format="PNG", optimize=True)

        data = dst.read_bytes()
        manifest.append({
            "id": item_id,
            "title": item["title"],
            "kind": item["kind"],
            "file": dst.name,
            "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest()[:16],
            "size": list(Image.open(dst).size),
            # Ground truth is the ORIGINAL logical text, never the reshaped form.
            "groundTruth": item.get("text"),
            "font": item.get("font"),
            "fontSize": item.get("size"),
        })
        print(f"{item_id:26} {dst.name:34} {Image.open(dst).size} {len(data):>8} B")

    (OUT / "manifest.json").write_text(
        json.dumps({"version": corpus["version"], "fixtures": manifest}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"\n{len(manifest)} fixtures -> {OUT}")


if __name__ == "__main__":
    main()
