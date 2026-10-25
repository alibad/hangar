"""The local viewer: Hangar's page and its data, on 127.0.0.1 only.

It opens folders, editors and agent sessions for you, so it is strict about who may ask: requests must come from its own origin
(the Host check stops DNS rebinding), actions need a custom header a cross-site form cannot send, and a folder is
only ever resolved from a repo id and site index through this machine's overlay, never taken from the request.
"""
import json
import mimetypes
import os
import time
import sys
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from . import apps, changes, gitops, launch, local, logos, model, scan as scanner
from . import config

TYPES = {".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".html": "text/html",
         ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp",
         ".woff2": "font/woff2", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json"}


class Server(ThreadingHTTPServer):
    """One Hangar per port. On Windows SO_REUSEADDR would let a second copy bind the same port and split requests, so
    the socket is exclusive there instead."""
    daemon_threads = True
    allow_reuse_address = sys.platform != "win32"

    def server_bind(self):
        if sys.platform == "win32":
            import socket
            self.socket.setsockopt(socket.SOL_SOCKET, getattr(socket, "SO_EXCLUSIVEADDRUSE", -5), 1)
        super().server_bind()


class State:
    def __init__(self):
        self.asked = time.time()  # the last time a page or helper asked for anything
        self.lock = threading.Lock()
        self.scanning = False
        self.progress = ""
        self.error = None
        self.doc = None

    def load(self):
        doc = scanner.document()
        doc["apps"] = launch.available()
        self.doc = doc
        return self.doc

    def rescan(self, github=True):
        with self.lock:
            if self.scanning:
                return False
            self.scanning, self.error = True, None

        def run():
            try:
                scanner.run(github=github, progress=lambda m: setattr(self, "progress", m))
                self.load()
            except Exception as e:  # reported to the page, which shows it beside the rescan button
                self.error = str(e)
            finally:
                self.scanning, self.progress = False, ""
        threading.Thread(target=run, daemon=True).start()
        return True


def make_handler(state, port):
    allowed_hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}

    class Handler(BaseHTTPRequestHandler):
        server_version = "Hangar"

        def log_message(self, fmt, *args):
            if os.environ.get("HANGAR_ENGINE_VERBOSE"):
                sys.stderr.write("hangar: " + fmt % args + "\n")

        def _host_ok(self):
            return self.headers.get("Host", "") in allowed_hosts

        def _send(self, code, body, ctype="application/json", cache="no-store"):
            data = body if isinstance(body, bytes) else json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", cache)
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if not self._host_ok():
                return self._send(403, {"error": "wrong host"})
            state.asked = time.time()
            url = urlparse(self.path)
            path = url.path
            if path == "/api/atlas":
                return self._send(200, state.doc or state.load())
            if path == "/api/sessions":
                from . import session_index
                return self._send(200, session_index.timeline(state.doc or state.load(), scanner.overlay(),
                                  (parse_qs(url.query).get("repo") or [None])[0]))
            if path == "/api/sessions/library":
                from . import session_library
                return self._send(200, session_library.snapshot(state.doc or state.load(), scanner.overlay()))
            if path == "/api/work":
                from . import work
                return self._send(200, work.snapshot())
            if path == "/api/workspace":
                from . import workspace
                return self._send(200, workspace.snapshot(state.doc or state.load()))
            if path == "/api/plans":
                from . import plan_links
                return self._send(200, {"links": plan_links.read()})
            if path == "/api/changes":
                return self._changes((parse_qs(url.query).get("repo") or [""])[0])
            if path == "/api/insights":
                from . import insights
                try:
                    return self._send(200, insights.inspect(state.doc or state.load(), scanner.overlay(), (parse_qs(url.query).get("repo") or [""])[0]))
                except ValueError as error:
                    return self._send(400, {"error": str(error)})
            if path == "/api/architecture":
                from . import architecture
                return self._send(200, architecture.status(state.doc or state.load(), scanner.overlay(), (parse_qs(url.query).get("repo") or [""])[0]))
            if path == "/api/architecture/view":
                from . import architecture
                page = architecture.view((parse_qs(url.query).get("repo") or [""])[0])
                return self._send(200, page, "text/html; charset=utf-8") if page else self._send(404, b"no drawing", "text/plain")
            if path == "/api/apps":
                return self._send(200, apps.status(state.doc or state.load(), self._folders(), owner=True))
            if path == "/api/logo":
                return self._logo((parse_qs(url.query).get("repo") or [""])[0])
            if path == "/api/status":
                return self._send(200, {"protocol": "hangar-engine-v1", "scanning": state.scanning, "progress": state.progress, "error": state.error,
                                        "generatedAt": (state.doc or {}).get("generatedAt")})
            return self._static(path)

        def do_POST(self):
            if not self._host_ok() or self.headers.get("X-Hangar") != "1":
                return self._send(403, {"error": "forbidden"})
            origin = self.headers.get("Origin")
            if origin and urlparse(origin).netloc not in allowed_hosts:
                return self._send(403, {"error": "wrong origin"})
            try:
                n = int(self.headers.get("Content-Length") or 0)
                if n < 0 or n > 65536:
                    return self._send(413, {"error": "request too large"})
                body = json.loads(self.rfile.read(n) or b"{}")
                if not isinstance(body, dict):
                    return self._send(400, {"error": "expected a JSON object"})
            except ValueError:
                return self._send(400, {"error": "bad json"})
            path = urlparse(self.path).path
            if path == "/api/workspace":
                from . import workspace
                try:
                    if body.get("action") in ("clone", "pull"):
                        if state.scanning:
                            return self._send(409, {"error": "A scan is running. Try again shortly."})
                        def refresh_workspace():
                            # Share the scanner's single-writer gate with the timer and watcher.
                            while not state.rescan(github=False):
                                time.sleep(0.25)
                            while state.scanning:
                                time.sleep(0.25)
                            if state.error:
                                raise ValueError("The operation finished, but the index refresh failed. Rescan before retrying.")
                        return self._send(202, workspace.start(state.doc or state.load(), scanner.overlay(), body, refresh_workspace))
                    result = workspace.island_action(state.doc or state.load(), body)
                    state.load()
                    return self._send(200, result)
                except (ValueError, OSError) as e:
                    return self._send(400, {"error": str(e)})
            if path == "/api/sessions/library":
                from . import session_library
                try:
                    return self._send(200, session_library.update(state.doc or state.load(), scanner.overlay(), body))
                except (ValueError, OSError) as e:
                    return self._send(400, {"error": str(e)})
            if path == "/api/plans":
                from . import plan_links
                try:
                    return self._send(200, plan_links.save(state.doc or state.load(), body))
                except ValueError as e:
                    return self._send(400, {"error": str(e)})
            if path == "/api/architecture":
                from . import architecture
                try:
                    return self._send(202, architecture.start(state.doc or state.load(), scanner.overlay(), body))
                except (ValueError, OSError) as e:
                    return self._send(400, {"error": str(e)})
            if path == "/api/work":
                from . import work
                try:
                    if body.get("action") == "start":
                        return self._send(202, work.start(state.doc or state.load(), scanner.overlay(), body))
                    if body.get("action") == "stop":
                        return self._send(200, work.stop(body.get("id")))
                    if body.get("action") == "acknowledge":
                        return self._send(200, work.acknowledge(body.get("id")))
                    raise ValueError("Choose start or stop.")
                except (ValueError, OSError) as e:
                    return self._send(400, {"error": str(e)})
            if path == "/api/sessions/resume":
                from . import session_index
                try:
                    return self._send(200, session_index.resume(body.get("provider"), body.get("id")))
                except (ValueError, launch.LaunchError, OSError) as e:
                    return self._send(400, {"error": str(e)})
            if path == "/api/rescan":
                started = state.rescan(github=body.get("github", True))
                return self._send(202 if started else 409, {"started": started})
            if path == "/api/open":
                return self._open(body)
            if path == "/api/notes":
                return self._notes(body)
            if path == "/api/git":
                return self._gitops(body)
            if path == "/api/apps":
                return self._apps(body)
            return self._send(404, {"error": "not found"})

        def _gitops(self, body):
            """Pull or push the repos you chose (fast-forward pulls, plain pushes), then rescan this machine."""
            action, ids = body.get("action"), body.get("repos")
            if action not in ("pull", "push") or not isinstance(ids, list) or not ids or len(ids) > 300:
                return self._send(400, {"error": "Say pull or push, and which repos."})
            if state.scanning:
                return self._send(409, {"error": "A scan is running; try again in a moment."})
            results = gitops.run(state.doc or state.load(), scanner.overlay(), action, [str(i) for i in ids])
            state.rescan(github=False)
            return self._send(200, {"results": results})

        def _notes(self, body):
            """Your words about a repo, saved to spine/spine.json (inside Hangar, never in the repo itself)."""
            doc = state.doc or state.load()
            rid = body.get("repo")
            try:
                model.save_notes(doc, rid, body.get("fields") or {})
            except ValueError as e:
                return self._send(404 if "repo" in str(e) else 400, {"error": str(e)})
            fresh = state.load()
            repo = next((r for r in fresh["repos"] if r["id"] == rid), None)
            return self._send(200, {"saved": True, "repo": repo})

        def _open(self, body):
            doc = state.doc or state.load()
            repo = next((r for r in doc["repos"] if r["id"] == body.get("repo")), None)
            try:
                site = repo["sites"][int(body.get("site", 0))] if repo else None
            except (ValueError, IndexError, TypeError):
                site = None
            overlay = scanner.overlay()
            folder = local.site_path(overlay, site) if site and overlay else None
            if not folder or not folder.is_dir():
                return self._send(404, {"error": "That folder is not on this machine any more."})
            how = body.get("with", "folder")
            if how not in launch.NAMES:
                return self._send(400, {"error": "Unknown app."})
            intent = body.get("intent") if body.get("intent") in launch.INTENTS else None
            try:
                app = launch.open_in(how, folder, intent)
            except launch.LaunchError as e:
                return self._send(404, {"error": str(e)})
            return self._send(200, {"opened": True, "app": app["name"]})

        def _logo(self, rid):
            """A repo's logo, from the path the scan found inside its own folder; nothing else on disk is reachable."""
            repo = next((r for r in (state.doc or state.load())["repos"] if r["id"] == rid), None)
            site = next((s for s in (repo or {}).get("sites", []) if s.get("logo")), None)
            folder = local.site_path(scanner.overlay(), site) if site else None
            if not folder:
                return self._send(404, b"no logo", "text/plain")
            path = (folder / site["logo"]["path"]).resolve()
            kind = logos.KINDS.get(path.suffix.lower())
            if not kind or folder.resolve() not in path.parents or not path.is_file() or path.stat().st_size > logos.MAX_BYTES:
                return self._send(404, b"no logo", "text/plain")
            data = path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "max-age=86400")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:")
            self.end_headers()
            self.wfile.write(data)

        def _folders(self):
            """(normalised folder, repo id) for every folder of every repo on this machine."""
            overlay = scanner.overlay()
            out = []
            for r in (state.doc or state.load())["repos"]:
                for s in r["sites"]:
                    p = local.site_path(overlay, s) if overlay else None
                    if p:
                        out.append((apps._norm(p), r["id"]))
            return out

        def _apps(self, body):
            """Start, stop or open a repo's app. Targets come from the scan; ports and processes from what is running."""
            doc = state.doc or state.load()
            repo = next((r for r in doc["repos"] if r["id"] == body.get("repo")), None)
            if not repo:
                return self._send(404, {"error": "No such repo on the map."})
            action = body.get("action")
            mine = next((x for x in apps.status(doc, self._folders(), owner=True)["apps"] if x["repo"] == repo["id"]), {"running": []})
            if action == "start":
                site = next((s for s in repo["sites"] if s.get("role") in config.MAIN_ROLES), None)
                folder = local.site_path(scanner.overlay(), site) if site else None
                if not folder or not folder.is_dir():
                    return self._send(404, {"error": "This repo's main folder is not on this machine."})
                try:
                    job = apps.start(repo, folder, str(body.get("target")), "tab" if body.get("how") == "tab" else "window")
                except ValueError as e:
                    return self._send(400, {"error": str(e)})
                return self._send(202, {"job": {k: job.get(k) for k in ("state", "message", "url")}})
            if action == "open":
                hit = next((x for x in mine["running"] if x["port"] == body.get("port")), None)
                if not hit:
                    return self._send(404, {"error": "That app is not running any more."})
                apps.open_window(hit["url"], "tab" if body.get("how") == "tab" else "window")
                return self._send(200, {"opened": hit["url"]})
            if action == "stop":
                port = body.get("port") if isinstance(body.get("port"), int) else None
                pid = next((x["pid"] for x in mine["running"] if x["port"] == port), None) if port else None
                return self._send(200, {"stopped": apps.stop(repo["id"], port, pid)})
            return self._send(400, {"error": "Say start, stop or open."})

        def _changes(self, rid):
            """What exactly is waiting on one repo, read live: files, commits to push and to pull, pull requests."""
            doc = state.doc or state.load()
            repo = next((r for r in doc["repos"] if r["id"] == rid), None)
            if not repo:
                return self._send(404, {"error": "No such repo on the map."})
            return self._send(200, changes.live(repo, scanner.overlay()))

        def _static(self, path):
            rel = "index.html" if path in ("", "/") else path.lstrip("/")
            target = (config.VIEWER / rel).resolve()
            if config.VIEWER.resolve() not in target.parents and target != config.VIEWER.resolve() or not target.is_file():
                return self._send(404, b"not found", "text/plain")
            ctype = TYPES.get(target.suffix.lower()) or mimetypes.guess_type(str(target))[0] or "application/octet-stream"
            cache = "no-cache" if target.suffix in (".html", ".js", ".css", ".webmanifest") else "max-age=3600"
            return self._send(200, target.read_bytes(), ctype, cache)

    return Handler


def datetime_min():
    from datetime import datetime, timezone
    return datetime(2000, 1, 1, tzinfo=timezone.utc)


def already_running(port):
    """True when an Hangar (not some other program) already answers on this port."""
    import urllib.request
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/status", timeout=2) as r:
            return json.loads(r.read() or b"{}").get("protocol") == "hangar-engine-v1"
    except (OSError, ValueError):
        return False


def refresher(state):
    """Keep the map fresh: this machine every 15 minutes and GitHub every hour while someone uses Hangar (the page, or
    an agent through MCP, in the last hour); only hourly when nobody does. HANGAR_ENGINE_REFRESH_MIN changes the 15; 0 turns
    timed scans off. New clones are caught by the watcher either way."""
    every = float(os.environ.get("HANGAR_ENGINE_REFRESH_MIN", "15"))
    if every <= 0:
        return
    last_github, last_local = time.time(), time.time()

    def loop():
        nonlocal last_github, last_local
        while True:
            time.sleep(every * 60)
            busy = time.time() - state.asked < 3600
            if not busy and time.time() - last_local < 3600:
                continue
            github = time.time() - last_github >= (3600 if busy else 3 * 3600)
            if state.rescan(github=github):
                last_local = time.time()
                if github:
                    last_github = time.time()
    threading.Thread(target=loop, daemon=True).start()


def shallow_repos(roots):
    """Git folders in the first two levels of each root: where a fresh clone lands. About a tenth of a second."""
    out = set()
    for base in roots.values():
        try:
            level1 = [e for e in os.scandir(base) if e.is_dir(follow_symlinks=False) and not e.name.startswith((".", "$"))]
        except OSError:
            continue
        for e in level1:
            if os.path.exists(os.path.join(e.path, ".git")):
                out.add(os.path.normcase(e.path))
                continue
            try:
                level2 = [x for x in os.scandir(e.path) if x.is_dir(follow_symlinks=False) and not x.name.startswith(".")]
            except OSError:
                continue
            for x in level2[:400]:
                if os.path.exists(os.path.join(x.path, ".git")):
                    out.add(os.path.normcase(x.path))
    return out


def watcher(state):
    """Notice a new clone (or a deleted one) within a minute and rescan, GitHub included so a brand-new repo shows
    up too. HANGAR_ENGINE_WATCH=0 turns it off."""
    import time
    if os.environ.get("HANGAR_ENGINE_WATCH", "1") == "0":
        return

    def loop():
        seen, last_github = None, 0
        while True:
            try:
                now = shallow_repos(config.load_roots()["roots"])
                if seen is not None and now != seen:
                    github = bool(now - seen) and time.time() - last_github > 600  # GitHub at most every 10 minutes
                    if state.rescan(github=github):
                        print(f"hangar: folders changed ({len(now - seen)} new, {len(seen - now)} gone): rescanning")
                        last_github = time.time() if github else last_github
                        seen = now  # only once a scan has really started; otherwise try again next minute
                else:
                    seen = now
            except Exception as e:  # a root on a drive that went away: try again next minute
                print("hangar: watch:", e)
            time.sleep(60)
    threading.Thread(target=loop, daemon=True).start()


def serve(port=7789, open_browser=False, log=False):
    if log:
        config.LOCAL.mkdir(parents=True, exist_ok=True)
        sys.stdout = sys.stderr = open(config.LOCAL / "server.log", "a", encoding="utf-8", buffering=1)
        print(f"--- hangar starting {__import__('datetime').datetime.now().isoformat(timespec='seconds')} on port {port}")
    url = f"http://127.0.0.1:{port}/"
    if already_running(port):
        print(f"hangar: already running at {url}")
        if open_browser:
            webbrowser.open(url)
        return 0
    state = State()
    first_run = not scanner.overlay()
    state.load()
    refresher(state)
    watcher(state)
    # After a reboot the saved map can be hours old: refresh it in the background straight away.
    age = time.time() - (model.parse_time((scanner.overlay() or {}).get("scannedAt")) or datetime_min()).timestamp()
    if first_run or age > 1800:
        state.rescan(github=age > 3 * 3600)
    try:
        httpd = Server(("127.0.0.1", port), make_handler(state, port))
    except OSError:
        raise SystemExit(f"Port {port} is in use by another program. Start Hangar on another one: python engine/main.py serve --port PORT")
    print(f"hangar: {url}  (Ctrl+C to stop)")
    if open_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
