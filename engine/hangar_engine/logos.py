"""Each repo's own logo, found in its files: the app icon a framework uses, else a logo file. Only a path is kept;
the server sends the image when the page asks for it. A picture that turns up in several repos is a template's
default (create-next-app's favicon, Vite's logo) and is dropped, so the map never shows the same stock icon everywhere."""
import hashlib
import json
from pathlib import Path

KINDS = {".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
         ".webp": "image/webp"}
MAX_BYTES = 1_000_000
STOCK_NAMES = {"vite.svg", "react.svg", "next.svg", "vercel.svg", "file.svg", "globe.svg", "window.svg", "turborepo.svg",
               "placeholder.svg", "placeholder-logo.svg", "placeholder-logo.png", "placeholder.png"}
# Where projects keep their icon, best first. Paths are relative to the app's folder.
PLACES = [
    "app/icon.svg", "app/icon.png", "src/app/icon.svg", "src/app/icon.png", "app/apple-icon.png", "src/app/apple-icon.png",
    "public/icon.svg", "public/logo.svg", "public/icon.png", "public/logo.png", "public/icon-512.png", "public/icon-192.png",
    "public/android-chrome-512x512.png", "public/android-chrome-192x192.png", "public/apple-touch-icon.png",
    "public/favicon.svg", "public/favicon.png", "assets/icon.png", "assets/images/icon.png", "assets/logo.png",
    "assets/icon/icon.png", "web/icons/Icon-512.png", "web/icons/Icon-192.png", "web/favicon.png",
    "logo.svg", "logo.png", "icon.svg", "icon.png", "docs/logo.svg", "docs/logo.png", ".github/logo.svg", ".github/logo.png",
    "app/favicon.ico", "src/app/favicon.ico", "public/favicon.ico", "favicon.ico",
]


def _ok(path):
    try:
        return path.is_file() and path.suffix.lower() in KINDS and 0 < path.stat().st_size <= MAX_BYTES \
            and path.name.lower() not in STOCK_NAMES
    except OSError:
        return False


def _expo_icon(d):
    try:
        cfg = json.loads((d / "app.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    icon = ((cfg.get("expo") or cfg) if isinstance(cfg, dict) else {}).get("icon")
    return (d / icon) if isinstance(icon, str) else None


SKIP = {"node_modules", ".git", "build", "dist", "Pods", "DerivedData", "android", "web", "windows", "linux", ".next", "vendor"}


def _dirs(d):
    try:
        return [p for p in d.iterdir() if p.is_dir() and p.name not in SKIP and not p.name.startswith(".")]
    except OSError:
        return []


def _xcode_icon(d):
    best = None
    sets = []
    for one in _dirs(d)[:60]:
        sets.append(one / "Assets.xcassets" / "AppIcon.appiconset")
        sets += [two / "Assets.xcassets" / "AppIcon.appiconset" for two in _dirs(one)[:60]]
    pngs = [p for s in sets if s.is_dir() for p in sorted(s.glob("*.png"))[:40]]
    for p in pngs:
        if _ok(p) and (best is None or p.stat().st_size > best.stat().st_size):
            best = p
    return best


def find(folder, app_dirs=()):
    """{"path": relative path, "hash": short content hash} for the repo's logo, or None."""
    root = Path(folder)
    for d in [root / a for a in app_dirs if a] + [root]:
        candidates = [_expo_icon(d)] + [d / rel for rel in PLACES] + [_xcode_icon(d)]
        for p in candidates:
            if p is not None and _ok(p):
                try:
                    p.resolve().relative_to(root.resolve())
                except ValueError:
                    continue
                digest = hashlib.sha1(p.read_bytes()).hexdigest()[:12]
                return {"path": p.relative_to(root).as_posix(), "hash": digest}
    return None


def drop_stock(sites, repeats=3):
    """Remove logos whose picture appears in `repeats` or more different folders: a template's default, not a logo."""
    count = {}
    for s in sites:
        h = (s.get("logo") or {}).get("hash")
        if h:
            count[h] = count.get(h, 0) + 1
    for s in sites:
        if (s.get("logo") or {}).get("hash") and count[s["logo"]["hash"]] >= repeats:
            s["logo"] = None
