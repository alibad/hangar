"""Exercise a clean Hangar engine with synthetic data; no other checkout is used."""
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request


class PurposeCategories(unittest.TestCase):
    def test_age_origin_and_status_do_not_define_islands(self):
        from hangar_engine.model import assign_families
        projects = [
            {"id": "old", "name": "older", "kind": "mine", "pushedAt": "2010-01-01T00:00:00Z", "hidden": True},
            {"id": "fork", "name": "borrowed", "kind": "fork"},
            {"id": "local", "name": "offline", "kind": "orphan"},
            {"id": "vendor", "name": "dependency", "kind": "vendor"},
        ]
        overrides = {"old": {"family": "research", "parked": True, "hidden": True}, "local": {"focus": True}}
        assign_families(projects, [{"id": "research", "name": "Research", "match": []}], overrides)
        self.assertEqual(projects[0]["family"], "research")
        self.assertTrue(all(p["family"] == "uncategorized" for p in projects[1:]))
        self.assertTrue(projects[0]["hidden"])


class EngineModules(unittest.TestCase):
    def test_every_internal_import_exists(self):
        # An import of a module that only Atlas has crashed the request that used it (opening a running app).
        import re
        pkg = Path(__file__).resolve().parent / "hangar_engine"
        missing = []
        for f in pkg.glob("*.py"):
            text = f.read_text(encoding="utf-8")
            names = re.findall(r"^\s*from \.([a-z_]+) import", text, re.M)
            for group in re.findall(r"^\s*from \. import ([a-z_, ]+)", text, re.M):
                names += [n.split(" as ")[0].strip() for n in group.split(",")]
            missing += [f"{f.name}: {n}" for n in names if n and not (pkg / f"{n}.py").exists()]
        self.assertEqual(missing, [])

    def test_opening_a_running_app_starts_an_app_window(self):
        from unittest import mock
        from hangar_engine import apps
        with mock.patch.object(apps, "app_browser", return_value="C:/browser.exe"), mock.patch.object(apps.sys, "platform", "win32"), \
                mock.patch.object(apps.subprocess, "Popen") as popen:
            apps.open_window("http://localhost:3939/")
        self.assertEqual(popen.call_args[0][0], ["C:/browser.exe", "--app=http://localhost:3939/", "--new-window"])


class AgentSignIn(unittest.TestCase):
    def test_signing_in_again_outranks_an_older_failed_job(self):
        from unittest import mock
        from hangar_engine import agents
        from datetime import datetime, timezone
        at = lambda h, m: datetime(2026, 10, 25, h, m, tzinfo=timezone.utc).timestamp()
        with mock.patch.object(agents.work, "sign_in_failures", return_value={"claude": "2026-10-25T19:16:03+00:00"}):
            self.assertTrue(agents._from_jobs("claude", True, since=at(20, 6))["signedIn"])    # signed in after the failed job
            self.assertFalse(agents._from_jobs("claude", True, since=at(18, 0))["signedIn"])   # sign-in file older than the failure
            self.assertFalse(agents._from_jobs("claude", True)["signedIn"])

    def test_sign_in_opens_the_browser_without_a_window_and_falls_back_to_a_terminal(self):
        import subprocess
        from unittest import mock
        from hangar_engine import agents
        slow = mock.Mock(); slow.wait.side_effect = subprocess.TimeoutExpired("claude", 4)
        quick = mock.Mock(); quick.wait.return_value = 1
        with mock.patch.object(agents.launch, "cli", return_value="claude.exe"), mock.patch.object(agents.launch, "_terminal") as terminal, \
                mock.patch.object(agents.threading, "Timer"), mock.patch.object(agents.config, "LOCAL", Path(tempfile.gettempdir())):
            with mock.patch.object(agents.subprocess, "Popen", return_value=slow) as popen:
                self.assertEqual(agents.sign_in("claude")["where"], "browser")
                self.assertEqual(popen.call_args[0][0], ["claude.exe", "auth", "login", "--claudeai"])
                terminal.assert_not_called()
            with mock.patch.object(agents.subprocess, "Popen", return_value=quick):
                self.assertEqual(agents.sign_in("claude")["where"], "terminal")
                terminal.assert_called_once()

    def test_claude_app_sessions_open_in_the_app_and_others_in_a_terminal(self):
        from unittest import mock
        from hangar_engine import desktop_sessions
        with tempfile.TemporaryDirectory() as d:
            folder = Path(d) / "org" / "account"
            folder.mkdir(parents=True)
            (folder / "local_abc.json").write_text(json.dumps({"sessionId": "local_abc", "cliSessionId": "cli-123", "cwd": "C:/x", "isArchived": False, "big": "x" * 9000}), encoding="utf-8")
            (folder / "local_old.json").write_text(json.dumps({"sessionId": "local_old", "cliSessionId": "cli-old", "isArchived": True}), encoding="utf-8")
            desktop_sessions._cache["at"] = 0
            with mock.patch.object(desktop_sessions, "_roots", return_value=[Path(d)]), mock.patch.object(desktop_sessions, "app_ready", return_value=True):
                self.assertEqual(desktop_sessions.claude_app_ids(), {"cli-123": "local_abc"})
                self.assertEqual(desktop_sessions.opens_in("claude", "cli-123"), "app")
                self.assertEqual(desktop_sessions.opens_in("claude", "cli-old"), "terminal")
                self.assertEqual(desktop_sessions.app_link("claude", "cli-123"), "claude://code/continue?session=local_abc")
                self.assertEqual(desktop_sessions.opens_in("codex", "anything"), "app")
            desktop_sessions._cache["at"] = 0


class ArchitectureDrawings(unittest.TestCase):
    def test_reply_parsing_keeps_only_an_architecture_candidate(self):
        from hangar_engine.architecture import candidate
        reply = 'Notes first.\n```json\n{"diagram_type": "workflow", "meta": {}}\n```\nFinal:\n```json\n{"schema_version": 1, "diagram_type": "architecture", "meta": {"title": "T"}}\n```'
        self.assertEqual(candidate(reply)["meta"]["title"], "T")
        with self.assertRaises(ValueError):
            candidate("I could not draw it.")

    def test_hangar_pins_output_and_repository(self):
        from hangar_engine.architecture import github_url, prepare
        data = prepare({"diagram_type": "architecture", "meta": {"output": "../../elsewhere.html", "repository": {"url": "x"}}},
                       "https://github.com/owner/name", "a" * 40)
        self.assertEqual(data["meta"]["output"], "diagram.html")
        self.assertEqual(data["meta"]["repository"], {"url": "https://github.com/owner/name", "revision": "a" * 40, "provider": "github", "link_mode": "web"})
        self.assertEqual(data["meta"]["quality_profile"], "showcase")
        self.assertNotIn("repository", prepare({"meta": {"repository": {"url": "x"}}}, None, None)["meta"])
        # A project with no GitHub repository keeps its components but loses the file links Archify cannot pin.
        local = prepare({"meta": {}, "components": [{"id": "api", "sources": [{"path": "src/api.py", "line": 1}]}]}, None, None)
        self.assertEqual(local["components"], [{"id": "api"}])
        self.assertIsNone(github_url({"url": "https://example.com/owner/name"}))

    def test_drawing_agents_get_reading_tools_only(self):
        from hangar_engine import launch, work
        original = launch.cli
        launch.cli = lambda name: name
        try:
            claude = work.command("claude", Path("project"), "task", read_dirs=[Path("skill")])
            codex = work.command("codex", Path("project"), "task", read_dirs=[Path("skill")])
        finally:
            launch.cli = original
        tools = claude[claude.index("--tools") + 1:claude.index("--add-dir")]
        self.assertEqual(tools, ["Read", "Grep", "Glob"])
        self.assertIn("--no-session-persistence", claude)
        self.assertEqual(codex[codex.index("--sandbox") + 1], "read-only")
        self.assertIn("--ephemeral", codex)

    def test_expired_agent_sign_in_gets_a_plain_next_step(self):
        from hangar_engine.work import sign_in_hint
        self.assertIn("sign in", sign_in_hint("Failed to authenticate. API Error: 401 OAuth access token is invalid."))
        self.assertIsNone(sign_in_hint("All tests passed."))
        from hangar_engine.work import failure_hint
        self.assertIn("too old", failure_hint("error: unknown option '--no-session-persistence'"))
        self.assertIn("sign in", failure_hint("Please run /login"))

    def test_agents_use_their_own_sign_in_not_api_keys(self):
        from hangar_engine import config
        saved = {k: os.environ.get(k) for k in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "HANGAR_SELFTEST_KEEP")}
        os.environ.update({"ANTHROPIC_API_KEY": "sk-test", "OPENAI_API_KEY": "sk-test", "HANGAR_SELFTEST_KEEP": "1"})
        try:
            agent = config.child_env(agent=True)
            self.assertNotIn("ANTHROPIC_API_KEY", agent)
            self.assertNotIn("OPENAI_API_KEY", agent)
            self.assertEqual(agent["HANGAR_SELFTEST_KEEP"], "1")
            self.assertEqual(config.child_env(extra={"CI": ""})["CI"], "")
        finally:
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v


class IndependentEngine(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="hangar-engine-test-")
        cls.root = Path(cls.temp.name)
        cls.bundle = cls.root / "hangar"
        shutil.copytree(Path(__file__).parent, cls.bundle / "engine", ignore=shutil.ignore_patterns("__pycache__"))
        cls.repo = cls.root / "projects" / "sample"
        (cls.repo / "src" / "ui").mkdir(parents=True)
        (cls.repo / "src" / "core").mkdir()
        (cls.repo / "src/ui/main.ts").write_text('import { value } from "../core/value";\nexport const result = value;\n')
        (cls.repo / "src/core/value.ts").write_text('export const value = 1;\n')
        (cls.repo / "package.json").write_text(json.dumps({"name": "sample", "dependencies": {"react": "*"}}))
        (cls.repo / ".env.example").write_text("EXAMPLE_ONLY=placeholder\n")
        cls.env = {**os.environ, "HANGAR_ENGINE_DATA_DIR": str(cls.bundle / "var/engine"),
                   "HANGAR_ENGINE_REFRESH_MIN": "0", "HANGAR_ENGINE_WATCH": "0", "PYTHONUTF8": "1",
                   "HOME": str(cls.root / "home"), "USERPROFILE": str(cls.root / "home"),
                   "CODEX_HOME": str(cls.root / "home/.codex"), "CLAUDE_CONFIG_DIR": str(cls.root / "home/.claude"),
                   "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}
        (cls.root / "home").mkdir()
        def git(*args, date=None):
            env = {**cls.env, **({"GIT_AUTHOR_DATE": date, "GIT_COMMITTER_DATE": date} if date else {})}
            subprocess.run(["git", "-C", str(cls.repo), *args], check=True, capture_output=True, env=env)
        git("init")
        git("config", "user.name", "Test")
        git("config", "user.email", "test@example.invalid")
        git("add", ".")
        git("commit", "-m", "feat: introduce core and interface", date="2025-01-10T12:00:00Z")
        git("tag", "v0.1")
        (cls.repo / "src/core/value.ts").write_text('export const value = 2;\n')
        git("commit", "-am", "fix: correct core value", date="2025-02-10T12:00:00Z")
        storage = cls.bundle / "var/engine"
        storage.mkdir(parents=True)
        (storage / "roots.json").write_text(json.dumps({"roots": {"TEST": str(cls.repo.parent)}, "canonical": ["TEST"], "maxDepth": 3, "owners": []}))
        subprocess.run([sys.executable, str(cls.bundle / "engine/main.py"), "scan", "--local"], check=True,
                       env=cls.env, cwd=cls.bundle, capture_output=True, timeout=60)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            cls.port = sock.getsockname()[1]
        cls.base = f"http://127.0.0.1:{cls.port}"
        cls.log = open(cls.root / "engine.log", "w", encoding="utf-8")
        cls.process = subprocess.Popen([sys.executable, str(cls.bundle / "engine/main.py"), "serve", "--port", str(cls.port)],
                                       env=cls.env, cwd=cls.bundle, stdout=cls.log, stderr=cls.log,
                                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        for _ in range(80):
            try:
                cls.read("/api/status")
                break
            except OSError:
                time.sleep(.1)
        else:
            cls.tearDownClass()
            raise RuntimeError("Isolated engine did not start")

    @classmethod
    def tearDownClass(cls):
        cls.process.terminate()
        cls.process.wait(timeout=10)
        cls.log.close()
        cls.temp.cleanup()

    @classmethod
    def read(cls, path):
        with urllib.request.urlopen(cls.base + path, timeout=30) as response:
            return json.load(response)

    def project(self):
        doc = self.read("/api/atlas")
        self.assertEqual(len(doc["repos"]), 1)
        return doc["repos"][0]

    def test_independent_discovery_and_storage(self):
        self.assertEqual(self.read("/api/status")["protocol"], "hangar-engine-v1")
        self.assertEqual(self.project()["name"], "sample")
        self.assertTrue(list((self.bundle / "var/engine/machines").glob("*.json")))
        self.assertFalse((self.bundle / "engine/world/atlas.json").exists())

    def test_world_assets_are_bundled(self):
        for path in ("/index.html", "/js/main.js", "/js/project-pane.js", "/css/atlas.css", "/vendor/three/build/three.module.min.js"):
            with urllib.request.urlopen(self.base + path) as response:
                self.assertEqual(response.status, 200)
                self.assertGreater(len(response.read()), 100)

    def test_architecture_and_complete_small_history(self):
        result = self.read("/api/insights?repo=" + self.project()["id"])
        self.assertTrue(result["available"])
        graph = result["architecture"]
        self.assertIn("react", graph["frameworks"])
        self.assertTrue(any(e["from"] == "src/ui" and e["to"] == "src/core" for e in graph["edges"]))
        self.assertNotIn(".env.example", json.dumps(graph))
        history = result["timeline"]
        self.assertEqual(history["commits"], 2)
        self.assertEqual([c["month"] for c in history["chapters"]], ["2025-02", "2025-01"])
        self.assertEqual(history["tags"][0]["name"], "v0.1")
        self.assertFalse(history["truncated"])

    def test_architecture_drawing_needs_archify(self):
        rid = self.project()["id"]
        status = self.read("/api/architecture?repo=" + rid)
        self.assertFalse(status["archify"])
        self.assertIn("archify", status["install"])
        self.assertIsNone(status["diagram"])
        request = urllib.request.Request(self.base + "/api/architecture", data=json.dumps({"repo": rid, "provider": "codex"}).encode(),
                                         headers={"X-Hangar": "1", "Content-Type": "application/json"})
        with self.assertRaises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(request)
        self.assertEqual(error.exception.code, 400)
        self.assertIn("Archify is not installed", json.loads(error.exception.read())["error"])
        with self.assertRaises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(self.base + "/api/architecture/view?repo=" + rid)
        self.assertEqual(error.exception.code, 404)

    def test_unknown_projects_and_cross_origin_writes_rejected(self):
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.read("/api/insights?repo=unknown")
        self.assertEqual(error.exception.code, 400)
        request = urllib.request.Request(self.base + "/api/notes", data=b"{}", headers={"X-Hangar": "1", "Origin": "https://outside.example"})
        with self.assertRaises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(request)
        self.assertEqual(error.exception.code, 403)


if __name__ == "__main__":
    unittest.main(verbosity=2)
