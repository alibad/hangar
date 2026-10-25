"""Apps: what each repo is (web, mobile, desktop), what this computer can run, and starting, stopping and opening it.

The scan records what a folder *is* (its framework, scripts, platforms): `detect`. What *this machine* can run and
what is running right now are worked out live: `targets_for` and `status`. Starting runs the repo's own dev command
in the background with its output in var/engine/logs/, waits for the address it prints, and opens it in its own window.
Commands always come from the repo's files, chosen by repo id and target id, never from a request.
"""
import json
import os
import re
import shlex
import shutil
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from pathlib import Path

from . import config

NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
WEB = [  # dependency, kind, label, default port
    ("next", "next", "Next.js web app", 3000),
    ("astro", "astro", "Astro site", 4321),
    ("vite", "vite", "Vite web app", 5173),
    ("react-scripts", "cra", "React web app", 3000),
]
URL_RE = re.compile(r"https?://(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})[^\s'\"]*")
STATE_FILE = config.LOCAL / "apps.json"
_starting = set()  # job keys this process is starting right now
LOGS = config.LOCAL / "logs"
_lock = threading.Lock()


# ---------- what a folder is (at scan time) ----------
def _json(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _pm(folder, root):
    for d in (folder, root):
        for lock, pm in (("pnpm-lock.yaml", "pnpm"), ("yarn.lock", "yarn"), ("bun.lockb", "bun"), ("bun.lock", "bun")):
            if (d / lock).is_file():
                return pm
    return "npm"


def _port_in(text):
    m = re.search(r"(?:-p|--port)[ =](\d{2,5})|PORT=(\d{2,5})", text or "")
    return int(m.group(1) or m.group(2)) if m else None


def _node_app(d, root):
    pkg = _json(d / "package.json")
    if not isinstance(pkg, dict):
        return None
    deps = {**(pkg.get("dependencies") or {}), **(pkg.get("devDependencies") or {})}
    scripts = {k: str(v) for k, v in (pkg.get("scripts") or {}).items()}
    pm, rel = _pm(d, root), d.relative_to(root).as_posix() if d != root else ""
    run = lambda script: [pm, "run", script]  # noqa: E731
    targets = []
    if "expo" in deps:
        if "react-native-web" in deps:
            targets.append({"id": "web", "label": "Web", "type": "server", "run": ["npx", "expo", "start", "--web"], "port": 8081, "needs": ["node"]})
        targets.append({"id": "android", "label": "Android", "type": "terminal", "run": ["npx", "expo", "start", "--android"], "needs": ["node", "android"]})
        targets.append({"id": "ios", "label": "iPhone", "type": "terminal", "run": ["npx", "expo", "start", "--ios"], "needs": ["node", "mac", "xcode"]})
        return {"kind": "expo", "label": "Expo mobile app", "dir": rel, "pm": pm, "targets": targets}
    for dep, kind, label, port in WEB:
        if dep in deps:
            script = next((s for s in ("dev", "start") if s in scripts and (s == "dev" or kind == "cra")), None) \
                or next((s for s, c in scripts.items() if dep in c and ("dev" in c or "start" in c)), None)
            if script:
                targets.append({"id": "web", "label": "Web", "type": "server", "run": run(script),
                                "port": _port_in(scripts[script]) or port, "needs": ["node"]})
            studio = next((s for s, c in scripts.items() if "remotion studio" in c or c.strip().startswith("remotion preview")), None)
            if studio:
                targets.append({"id": "studio", "label": "Video studio", "type": "server", "run": run(studio),
                                "port": _port_in(scripts[studio]) or 3000, "needs": ["node"]})
            return {"kind": kind, "label": label, "dir": rel, "pm": pm, "targets": targets} if targets else None
    studio = next((s for s, c in scripts.items() if "remotion studio" in c or "remotion preview" in c), None)
    if studio or "@remotion/cli" in deps and "studio" in scripts:
        studio = studio or "studio"
        return {"kind": "remotion", "label": "Remotion video studio", "dir": rel, "pm": pm,
                "targets": [{"id": "studio", "label": "Video studio", "type": "server", "run": run(studio), "port": 3000, "needs": ["node"]}]}
    if "electron" in deps and "start" in scripts:
        return {"kind": "electron", "label": "Electron desktop app", "dir": rel, "pm": pm,
                "targets": [{"id": "desktop", "label": "Desktop", "type": "desktop", "run": run("start"), "needs": ["node"]}]}
    return None


def _flutter_app(d, root):
    try:
        spec = (d / "pubspec.yaml").read_text(encoding="utf-8")
    except OSError:
        return None
    if "sdk: flutter" not in spec:
        return None
    plats = {p for p in ("web", "android", "ios", "windows", "macos", "linux") if (d / p).is_dir()}
    targets = []
    if "web" in plats:
        targets.append({"id": "web", "label": "Web", "type": "server", "run": ["flutter", "run", "-d", "web-server", "--web-port", "8090"], "port": 8090, "needs": ["flutter"]})
    if "android" in plats:
        targets.append({"id": "android", "label": "Android", "type": "terminal", "run": ["flutter", "run", "-d", "emulator"], "needs": ["flutter", "android"]})
    if "ios" in plats:
        targets.append({"id": "ios", "label": "iPhone", "type": "terminal", "run": ["flutter", "run", "-d", "iPhone"], "needs": ["flutter", "mac", "xcode"]})
    if "windows" in plats:
        targets.append({"id": "windows", "label": "Windows", "type": "terminal", "run": ["flutter", "run", "-d", "windows"], "needs": ["flutter", "windows"]})
    if "macos" in plats:
        targets.append({"id": "macos", "label": "Mac", "type": "terminal", "run": ["flutter", "run", "-d", "macos"], "needs": ["flutter", "mac", "xcode"]})
    rel = d.relative_to(root).as_posix() if d != root else ""
    return {"kind": "flutter", "label": "Flutter app", "dir": rel, "targets": targets} if targets else None


def _xcode_app(d, root):
    proj = next(iter(sorted(d.glob("*.xcworkspace"))), None) or next(iter(sorted(d.glob("*.xcodeproj"))), None)
    if not proj or (d / "pubspec.yaml").is_file() or (d / "ios" / proj.name).exists():
        return None
    rel = d.relative_to(root).as_posix() if d != root else ""
    return {"kind": "xcode", "label": "iPhone app (Xcode)", "dir": rel,
            "targets": [{"id": "ios", "label": "iPhone", "type": "xcode", "run": ["open", proj.name], "needs": ["mac", "xcode"]}]}


def _outside(arg, root):
    """True for an argument naming another project: an absolute path outside this repo, or a nested repo inside it."""
    a = arg.strip('"')
    if not (re.match(r"^[A-Za-z]:[\\/]", a) or a.startswith("/")):
        sub = root / a.split("/")[0].split("\\")[0] if a and not a.startswith("-") else None
        return bool(sub and sub != root and sub.is_dir() and (sub / ".git").exists())  # a nested repo of its own
    try:
        p, top = Path(a).resolve(), root.resolve()
    except (OSError, ValueError):
        return True
    if top not in [p, *p.parents]:
        return True
    return any((d / ".git").exists() for d in [p, *p.parents] if d != top and top in d.parents)


def _launch_apps(root):
    cfg = _json(root / ".claude" / "launch.json")
    targets = []
    for c in (cfg or {}).get("configurations", []) if isinstance(cfg, dict) else []:
        exe, args = str(c.get("runtimeExecutable") or ""), [str(a) for a in c.get("runtimeArgs") or []]
        if not exe or not isinstance(c.get("port"), int) or any(_outside(a, root) for a in args) or _outside(str(c.get("cwd") or ""), root):
            continue
        name = str(c.get("name") or "app")[:40]
        targets.append({"id": f"launch:{name}", "label": name, "type": "server", "run": [exe, *args], "port": c["port"],
                        "cwd": str(c.get("cwd") or ""), "needs": []})
    return {"kind": "launch", "label": "Run configurations", "dir": "", "targets": targets[:8]} if targets else None


def detect(folder):
    """The apps in a repo's folder: its own run configurations, then web, mobile and desktop apps at the top level
    or one folder down (not inside a folder that is a repo of its own)."""
    root = Path(folder)
    out = []
    launch = _launch_apps(root)
    if launch:
        out.append(launch)
    dirs = [root] + sorted(p for p in root.iterdir() if p.is_dir() and not p.name.startswith((".", "_"))
                           and p.name not in ("node_modules", "dist", "build", "vendor") and not (p / ".git").exists()) \
        if root.is_dir() else []
    platforms = {"ios", "macos", "android", "web", "windows", "linux"}
    for d in dirs:
        if d != root and d.name in platforms and any(a["dir"] == "" and a["kind"] != "launch" for a in out):
            continue  # a mobile app's own platform folders are part of it, not apps of their own
        for probe in (_node_app, _flutter_app, _xcode_app):
            try:
                app = probe(d, root)
            except OSError:
                app = None
            if app:
                out.append(app)
                break
        if len(out) >= 6:
            break
    # A run configuration that starts the same command as a detected app is that app: keep one, with the configured port.
    if launch:
        for a in out:
            if a is launch:
                continue
            for t in a["targets"]:
                twin = next((x for x in launch["targets"] if x["run"] == t["run"] and not x.get("cwd") and a["dir"] == ""), None)
                if twin:
                    t["port"] = twin["port"]
                    launch["targets"].remove(twin)
        if not launch["targets"]:
            out.remove(launch)
    return out


# ---------- what this machine can run ----------
_machine = {"at": 0, "value": None}
_found = {}  # program -> (when looked up, path or None)


def _which(name):
    """shutil.which, remembered for a minute: a poll checks dozens of targets and each lookup walks PATH."""
    at, path = _found.get(name, (0, None))
    if time.time() - at > 60:
        path = shutil.which(name) or (shutil.which(f"{name}.cmd") if sys.platform == "win32" else None)
        _found[name] = (time.time(), path)
    return path


def machine():
    if time.time() - _machine["at"] < 60 and _machine["value"]:
        return _machine["value"]
    home, local = Path.home(), Path(os.environ.get("LOCALAPPDATA", ""))
    sdk = next((Path(p) for p in (os.environ.get("ANDROID_HOME"), os.environ.get("ANDROID_SDK_ROOT"),
                                  local / "Android" / "Sdk", home / "Library" / "Android" / "sdk", home / "Android" / "Sdk")
                if p and Path(p).is_dir()), None)
    avd = home / ".android" / "avd"
    value = {"os": {"win32": "windows", "darwin": "mac"}.get(sys.platform, "linux"),
             "node": bool(_which("npm")), "flutter": bool(_which("flutter")), "androidSdk": bool(sdk),
             "emulators": sorted(p.stem for p in avd.glob("*.avd")) if avd.is_dir() else [],
             "xcode": sys.platform == "darwin" and bool(_which("xcodebuild"))}
    _machine.update(at=time.time(), value=value)
    return value


def check(target, m=None):
    """(can run here, why not) for one target on this machine."""
    m = m or machine()
    order = ("mac", "windows", "xcode", "android", "flutter", "node")  # the platform first: "needs a Mac" beats "no Flutter"
    for need in sorted(target.get("needs", []), key=lambda n: order.index(n) if n in order else len(order)):
        if need == "node" and not m["node"]:
            return False, "Node.js isn't installed on this computer"
        if need == "flutter" and not m["flutter"]:
            return False, "Flutter isn't installed on this computer"
        if need == "android" and not m["androidSdk"]:
            return False, "The Android SDK isn't installed here (it comes with Android Studio)"
        if need == "android" and not m["emulators"]:
            return False, "No Android emulator set up yet (Android Studio, Device Manager)"
        if need == "mac" and m["os"] != "mac":
            return False, "Needs a Mac"
        if need == "xcode" and not m["xcode"]:
            return False, "Needs Xcode"
        if need == "windows" and m["os"] != "windows":
            return False, "Needs Windows"
    run = target.get("run") or []
    if run and target.get("type") in ("server", "desktop") and not _which(run[0]) and run[0] != "npx" \
            and not (run[0] in ("pnpm", "yarn") and _which("corepack")):
        return False, f"{run[0]} isn't installed on this computer"
    return True, ""


# ---------- what is running ----------
_listen = {"at": 0, "value": []}
_cmdlines = {}  # pid -> command line; a process's command line never changes


def listening():
    """[(port, pid, command line)] for every TCP port a local process is listening on. Cached for a few seconds.
    On Windows this asks the OS directly (about a millisecond); PowerShell is only the fallback."""
    if time.time() - _listen["at"] < 6:
        return _listen["value"]
    out = []
    try:
        if sys.platform == "win32":
            try:
                from . import winproc
                pairs = winproc.listening()
                live = {pid for _, pid in pairs}
                for pid in list(_cmdlines):
                    if pid not in live:
                        del _cmdlines[pid]
                for _, pid in pairs:
                    if pid not in _cmdlines:
                        _cmdlines[pid] = winproc.command_line(pid)
                out = [(port, pid, _cmdlines[pid]) for port, pid in pairs]
                _listen.update(at=time.time(), value=out)
                return out
            except (OSError, AttributeError, ValueError):
                pass
            ps = ("$p=@{}; Get-CimInstance Win32_Process | % { $p[[int]$_.ProcessId]=$_.CommandLine };"
                  "Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Sort-Object LocalPort -Unique |"
                  " % { [pscustomobject]@{port=$_.LocalPort; pid=$_.OwningProcess; cmd=$p[[int]$_.OwningProcess]} } | ConvertTo-Json -Compress")
            r = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps], capture_output=True, text=True,
                               encoding="utf-8", errors="replace", timeout=20, creationflags=NO_WINDOW)
            rows = json.loads(r.stdout or "[]")
            rows = [rows] if isinstance(rows, dict) else rows
            out = [(int(x["port"]), int(x["pid"]), x.get("cmd") or "") for x in rows]
        else:
            r = subprocess.run(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"], capture_output=True, text=True, timeout=20)
            pid = None
            pairs = []
            for line in r.stdout.splitlines():
                if line.startswith("p"):
                    pid = int(line[1:])
                elif line.startswith("n") and pid:
                    m = re.search(r":(\d+)$", line)
                    if m:
                        pairs.append((int(m.group(1)), pid))
            cmds = {}
            for _, p in pairs:
                if p not in cmds:
                    c = subprocess.run(["ps", "-o", "command=", "-p", str(p)], capture_output=True, text=True, timeout=5)
                    cmds[p] = c.stdout.strip()
            out = sorted({(port, p, cmds.get(p, "")) for port, p in pairs})
    except (OSError, ValueError, subprocess.TimeoutExpired):
        out = []
    _listen.update(at=time.time(), value=out)
    return out


def _norm(path):
    return str(path).replace("/", "\\").lower().rstrip("\\") if sys.platform == "win32" else str(path).rstrip("/")


def _load():
    return config.read_json(STATE_FILE, {}) or {}


def _save(state):
    config.LOCAL.mkdir(parents=True, exist_ok=True)
    config.write_json(STATE_FILE, state)


def _identity(pid):
    """Something that tells this process apart from a later one given the same pid (Windows reuses them)."""
    try:
        if sys.platform == "win32":
            from . import winproc
            return winproc.created(pid)
        r = subprocess.run(["ps", "-o", "lstart=", "-p", str(pid)], capture_output=True, text=True, timeout=5)
        return r.stdout.strip() or None
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None


def _alive(pid, created):
    """True only while pid is still the very process Hangar started: same pid and same start time. A job saved
    without a start time is never trusted, so Hangar can never stop a stranger that inherited the number."""
    if not pid or created is None:
        return False
    return _identity(pid) == created


def _within(cmd, folder):
    """Is folder in this command line as a whole path (not as the start of a longer folder name)?"""
    i = cmd.find(folder)
    while i >= 0:
        after = cmd[i + len(folder): i + len(folder) + 1]
        if after in ("", "\\", "/", '"', "'", " "):
            return True
        i = cmd.find(folder, i + 1)
    return False


def status(doc, folders, owner=False):
    """Every repo with an app or a running server: its targets (and whether this machine can run each) and what runs.
    folders: [(normalised folder path, repo id)] for every folder of every repo on this machine.
    owner: the Hangar server itself, the only process allowed to settle jobs it was starting (MCP helpers only read)."""
    folders = sorted(folders, key=lambda x: -len(x[0]))
    m, state = machine(), _load()
    running = {}
    me = os.getpid()
    for port, pid, cmd in listening():
        if port >= 49152 or pid == me:  # helpers in the ephemeral range, and Hangar's own server: nothing to open or stop
            continue
        c = _norm(cmd)
        rid = next((r for f, r in folders if f and _within(c, f)), None)
        if rid:
            running.setdefault(rid, []).append({"port": port, "pid": pid, "url": f"http://localhost:{port}/"})
    out = []
    for r in doc["repos"]:
        apps = [a for s in r["sites"] if s.get("role") in config.MAIN_ROLES for a in s.get("apps") or []]
        mine = {k: v for k, v in state.items() if k.split("|")[0] == r["id"]}
        if not apps and r["id"] not in running and not mine:
            continue
        for k, v in mine.items():
            change = None
            if v.get("state") in ("running", "starting") and v.get("pid") and not _alive(v.get("pid"), v.get("created")):
                change = {"state": "stopped", "message": "It stopped."}
            elif v.get("state") == "starting" and owner and (k not in _starting or time.time() - (v.get("started") or 0) > 1200):
                change = {"state": "failed", "message": "It did not finish starting (Hangar restarted, or it took over 20 minutes). Press Run again."}
            if change:
                v.update(change)
                with _lock:
                    s = _load()
                    if k in s:
                        s[k].update(change)
                        _save(s)
        started = {v.get("port") for v in mine.values() if v.get("state") == "running"}
        live = [{**x, "by": "atlas" if x["port"] in started else "elsewhere"} for x in running.get(r["id"], [])]
        out.append({"repo": r["id"], "name": r["name"], "running": live,
                    "jobs": {k.split("|", 1)[1]: {kk: v.get(kk) for kk in ("state", "message", "url", "port", "log")} for k, v in mine.items()},
                    "apps": [{**{k: a[k] for k in ("kind", "label", "dir")},
                              "targets": [{"id": t["id"], "label": t["label"], "type": t["type"], "port": t.get("port"),
                                           **dict(zip(("ok", "why"), check(t, m)))} for t in a["targets"]]} for a in apps]})
    return {"machine": m, "apps": out, "running": sum(1 for x in out if x["running"])}


# ---------- start, stop, open ----------
def _resolve(argv):
    """The command with its program found on PATH; pnpm and yarn run through Node's own corepack when not installed."""
    exe = shutil.which(argv[0])
    if not exe and argv[0] in ("pnpm", "yarn") and shutil.which("corepack"):
        return [shutil.which("corepack"), *argv]
    return [exe or argv[0], *argv[1:]]


def app_browser():
    """Chrome or Edge, which can open a page as its own app window."""
    base = [os.environ.get("ProgramFiles", r"C:\Program Files"), os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"),
            os.environ.get("LOCALAPPDATA", "")]
    for rel in (r"Google\Chrome\Application\chrome.exe", r"Microsoft\Edge\Application\msedge.exe"):
        for b in base:
            p = Path(b) / rel
            if b and p.exists():
                return str(p)
    return None


def open_window(url, how="window"):
    """Open a local page in its own app window (Chrome or Edge), or as a tab."""
    browser = app_browser() if sys.platform == "win32" else None
    if how == "window" and browser:
        subprocess.Popen([browser, f"--app={url}", "--new-window"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, creationflags=NO_WINDOW)
    elif how == "window" and sys.platform == "darwin" and Path("/Applications/Google Chrome.app").exists():
        subprocess.Popen(["open", "-na", "Google Chrome", "--args", f"--app={url}", "--new-window"])
    else:
        webbrowser.open(url)


def start(repo, folder, target_id, open_how="window"):
    """Start one target of a repo's app. Returns at once; the job's progress is in apps.json (see status)."""
    folder = Path(folder)
    app, target = None, None
    for a in [a for s in repo["sites"] if s.get("role") in config.MAIN_ROLES for a in s.get("apps") or []]:
        target = next((t for t in a["targets"] if t["id"] == target_id), None)
        if target:
            app = a
            break
    if not target:
        raise ValueError("That app is not in this repo.")
    ok, why = check(target)
    if not ok:
        raise ValueError(why)
    cwd = folder / app["dir"] if app.get("dir") else folder
    if target.get("cwd"):
        cwd = (folder / target["cwd"]).resolve()
        if folder.resolve() not in [cwd, *cwd.parents]:
            raise ValueError("That run configuration points outside the repo.")
    key = f"{repo['id']}|{app['dir']}:{target_id}"
    with _lock:
        state = _load()
        job = state.get(key) or {}
        if key in _starting:
            return job
        if job.get("state") in ("starting", "running") and _alive(job.get("pid"), job.get("created")):
            if job.get("url"):
                open_window(job["url"], open_how)
            return job
        LOGS.mkdir(parents=True, exist_ok=True)
        log = LOGS / f"{re.sub(r'[^A-Za-z0-9_.-]+', '-', repo['name'] + '-' + target_id)}.log"
        state[key] = {"state": "starting", "message": "Starting...", "log": log.name, "started": time.time(), "label": target["label"]}
        _save(state)
        _starting.add(key)

    def update(**kw):
        with _lock:
            s = _load()
            s[key] = {**s.get(key, {}), **kw}
            _save(s)

    def run():
        try:
            # The project reads its own .env; Hangar's settings and keys stay out of it.
            env = config.child_env(extra={"BROWSER": "none", "FORCE_COLOR": "0", "CI": "", "COREPACK_ENABLE_DOWNLOAD_PROMPT": "0"})
            if target["type"] == "terminal":
                cmd = _resolve(target["run"])
                if sys.platform == "win32":
                    # One string, quoted once: cmd strips the outer quotes and keeps "C:\Program Files\..." intact.
                    subprocess.Popen(terminal_line(cmd), cwd=cwd, creationflags=subprocess.CREATE_NEW_CONSOLE, env=config.child_env())
                elif sys.platform == "darwin":
                    line = f"cd {shlex.quote(str(cwd))} && {shlex.join(target['run'])}".replace("\\", "\\\\").replace('"', '\\"')
                    subprocess.Popen(["osascript", "-e", f'tell application "Terminal" to do script "{line}"'])
                return update(state="terminal", message=f"Started in a terminal window: {' '.join(target['run'])}")
            if target["type"] == "xcode":
                subprocess.Popen(["open", target["run"][1]], cwd=cwd)
                return update(state="terminal", message="Opened in Xcode: pick a simulator and press Run.")
            with open(log, "w", encoding="utf-8", errors="replace") as out:
                if app.get("pm") and not (cwd / "node_modules").is_dir() and target["type"] in ("server", "desktop"):
                    update(message="Installing its packages first (one time)...")
                    out.write(f"$ {app['pm']} install\n")
                    out.flush()
                    r = subprocess.run(_resolve([app["pm"], "install"]), cwd=cwd, stdout=out, stderr=subprocess.STDOUT,
                                       stdin=subprocess.DEVNULL, env=env, creationflags=NO_WINDOW, timeout=900)
                    if r.returncode:
                        return update(state="failed", message=f"{app['pm']} install failed: see {log.name}")
                out.write(f"$ {' '.join(target['run'])}\n")
                out.flush()
                flags = NO_WINDOW | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
                p = subprocess.Popen(_resolve(target["run"]), cwd=cwd, stdout=out, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                     env=env, creationflags=flags, start_new_session=sys.platform != "win32")
            update(pid=p.pid, created=_identity(p.pid), message="Waiting for it to start...")
            if target["type"] == "desktop":
                return update(state="running", message="Running as a desktop window.")
            deadline = time.time() + 240
            while time.time() < deadline:
                time.sleep(1)
                text = log.read_text(encoding="utf-8", errors="replace")
                m = URL_RE.search(text[-20000:])
                port = int(m.group(1)) if m else None
                if not port and target.get("port") and not busy_before and _port_open(target["port"]) and time.time() - p_start > 8:
                    port = target["port"]
                if port and _port_open(port):
                    url = f"http://localhost:{port}/"
                    update(state="running", port=port, url=url, message=f"Running at {url}")
                    if open_how:
                        open_window(url, open_how)
                    return
                if p.poll() is not None:
                    tail = [ln for ln in text.strip().splitlines() if ln.strip()][-3:]
                    return update(state="failed", message="It stopped while starting: " + " / ".join(tail)[:300])
            update(state="failed", message=f"No address after 4 minutes: see {log.name}")
        except Exception as e:  # reported on the card
            update(state="failed", message=str(e)[:300])
        finally:
            _starting.discard(key)

    p_start = time.time()
    busy_before = bool(target.get("port")) and _port_open(target["port"])
    threading.Thread(target=run, daemon=True).start()
    return state[key]


def terminal_line(cmd):
    """The command line for a new Windows console that runs cmd and stays open."""
    return f'cmd /k "{subprocess.list2cmdline(cmd)}"'


def _port_open(port):
    with socket.socket() as s:
        s.settimeout(0.4)
        return s.connect_ex(("127.0.0.1", int(port))) == 0


def _kill(pid):
    if sys.platform == "win32":
        r = subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True, text=True, creationflags=NO_WINDOW)
        return r.returncode == 0
    try:
        os.killpg(os.getpgid(pid), 15)
        return True
    except OSError:
        return False


def stop(repo_id, port=None, pid=None):
    """Stop what Hangar started for a repo, only while it is still that same process; with port, only that one.
    pid: a server the map found on that port for this repo just now (started elsewhere), stopped when Hangar has none."""
    with _lock:
        state = _load()
        stopped, handled = 0, False
        for k, v in state.items():
            if k.split("|")[0] != repo_id or v.get("state") not in ("starting", "running"):
                continue
            if port is not None and v.get("port") != port:
                continue
            if _alive(v.get("pid"), v.get("created")):
                stopped += _kill(v["pid"])
                handled = True
            v.update(state="stopped", message="Stopped.")
        if pid and not handled and pid != os.getpid():
            stopped += _kill(pid)
        _save(state)
    _listen["at"] = 0
    return stopped
