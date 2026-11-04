"""Exercise a clean Hangar engine with synthetic data; no other checkout is used."""
from datetime import datetime
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


class SessionCleanup(unittest.TestCase):
    def test_the_claude_app_record_gives_title_unread_reply_and_status(self):
        from unittest import mock
        from hangar_engine import desktop_sessions
        summary = lambda turn: {"status_category": "blocked", "status_detail": "Fix ready, not pushed", "needs_action": "Approve the push", "summarizes_uuid": turn}
        with tempfile.TemporaryDirectory() as d:
            folder = Path(d) / "org" / "account"
            folder.mkdir(parents=True)
            records = {
                "local_new": {"sessionId": "local_new", "cliSessionId": "cli-new", "lastFocusedAt": 100, "title": "Fix the \"login\" bug", "lastTurnEdgeAt": 200, "isArchived": False,
                              "tools": "x" * 20000, "postTurnSummary": summary("u1"), "postTurnSummaryFor": "u1", "lastAssistantUuid": "u1"},
                "local_seen": {"sessionId": "local_seen", "cliSessionId": "cli-seen", "lastFocusedAt": 300, "lastTurnEdgeAt": 200, "isArchived": False,
                               "postTurnSummary": summary("u1"), "lastAssistantUuid": "u2"},
                "local_old": {"sessionId": "local_old", "cliSessionId": "cli-old", "isArchived": True},
            }
            for name, record in records.items():
                (folder / f"{name}.json").write_text(json.dumps(record), encoding="utf-8")
            desktop_sessions._cache["at"] = 0
            with mock.patch.object(desktop_sessions, "_roots", return_value=[Path(d)]):
                found = desktop_sessions.claude_app_records()
                self.assertEqual(found["cli-new"]["title"], 'Fix the "login" bug')
                self.assertTrue(found["cli-new"]["unread"])                     # its last turn ended after you last opened it
                self.assertEqual(found["cli-new"]["status"], {"category": "blocked", "detail": "Fix ready, not pushed", "needsAction": "Approve the push"})
                self.assertFalse(found["cli-seen"]["unread"])
                self.assertIsNone(found["cli-seen"]["status"])                  # it summarizes an earlier turn
                self.assertIsNone(found["cli-old"]["unread"])                   # an old record: unknown, not read
                self.assertTrue(found["cli-old"]["archived"])
                self.assertEqual(desktop_sessions.claude_app_ids(), {"cli-new": "local_new", "cli-seen": "local_seen"})
            desktop_sessions._cache["at"] = 0

    def test_a_whole_age_group_archives_at_once_but_never_an_unread_session(self):
        from unittest import mock
        from hangar_engine import session_library
        row = lambda key, **kw: {"key": key, "title": key, "provider": "claude", "id": key, "activityAt": "2026-08-01T00:00:00+00:00",
                                 "protected": False, "pinned": False, "unread": None, "nativeKnown": False, "archived": False, "appId": None, **kw}
        rows = {"a": row("a"), "b": row("b"), "c": row("c", unread=True)}
        activity = {k: r["activityAt"] for k, r in rows.items()}
        with tempfile.TemporaryDirectory() as d, mock.patch.object(session_library.config, "LOCAL", Path(d)):
            saved = session_library.read()
            with self.assertRaisesRegex(ValueError, "unread"):
                session_library._archive(saved, rows, ["a", "b", "c"], {"scope": "hangar", "activity": activity})
            self.assertEqual(saved["sessions"], {})                             # nothing changed before the refusal
            with self.assertRaisesRegex(ValueError, "changed since"):
                session_library._archive(saved, rows, ["a"], {"scope": "hangar", "activity": {"a": "2026-09-01T00:00:00+00:00"}})
            done = session_library._archive(saved, rows, ["a", "b"], {"scope": "hangar", "activity": activity})
            self.assertEqual(done["archived"], 2)
            self.assertEqual(set(session_library.read()["sessions"]), {"a", "b"})

    def test_a_check_in_reads_the_first_request_and_the_last_reply(self):
        from hangar_engine import checkin
        lines = [{"type": "user", "message": {"role": "user", "content": "<system-reminder>ignore me</system-reminder>Add Clean up by age"}},
                 {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "Working on it."}]}},
                 {"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "content": "ok"}]}},
                 {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "Done and pushed."}, {"type": "tool_use", "name": "Bash"}]}},
                 {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "tool_use", "name": "Read"}]}}]
        with tempfile.TemporaryDirectory() as d:
            file = Path(d) / "s.jsonl"
            file.write_text("\n".join(json.dumps(l) for l in lines), encoding="utf-8")
            self.assertEqual(checkin.conversation(file), {"asked": "Add Clean up by age", "answer": "Done and pushed."})
        # A reply is Markdown: its lines survive, and a long one is cut at a line, not mid-word.
        reply = "## Done\n\n- **one**   \n- two\n\n\n\n" + "word " * 400
        kept = checkin._clean(reply, 300, lines=True)
        self.assertTrue(kept.startswith("## Done\n\n- **one**\n- two\n\nword"))
        self.assertTrue(kept.endswith("word …") and len(kept) <= 302)

    def test_a_check_in_says_done_left_or_finished_elsewhere(self):
        from hangar_engine import checkin
        row = lambda **kw: {"key": "claude:s", "provider": "claude", "activityAt": "2026-10-01T00:00:00+00:00", "state": "completed", "working": False, "status": None,
                            "projects": [{"id": "R", "name": "app", "evidence": "edit-tool", "files": ["src/a.ts"]}], **kw}
        talk = {"asked": "Fix it", "answer": "Fixed."}
        mine = [{"sha": "abc1234", "repoId": "R"}]
        state = lambda **kw: {"R": {"dirty": set(), "unpushed": set(), "tracked": {"src/a.ts"}, **kw}}
        later = {"R": {"commits": [{"sha": "f" * 40, "short": "fffffff", "at": 1791500000, "subject": "Finish a.ts", "files": ["src/a.ts"]}]}}
        none = {"R": {"commits": []}}
        check = lambda r, own, st, hist: checkin.verdict(r, None, talk, own, {"R": "x"}, st, hist, {"R": {}}, {"R": []}, {})["verdict"]
        self.assertEqual(check(row(), mine, state(), none), "done")
        self.assertEqual(check(row(), mine, state(unpushed={"abc1234" + "0" * 33}), none), "left")          # a commit never pushed
        self.assertEqual(check(row(), mine, state(dirty={"src/a.ts"}), none), "left")                       # its edits still uncommitted
        self.assertEqual(check(row(status={"category": "blocked", "needsAction": "Pick one"}), mine, state(), later), "left")  # waiting on you
        self.assertEqual(check(row(state="interrupted"), [], state(), later), "elsewhere")                  # stopped, finished by later work
        self.assertEqual(check(row(state="interrupted"), [], state(), none), "unclear")
        self.assertEqual(check(row(projects=[]), [], state(), none), "done")                                 # answered, edited nothing

    def test_archive_happens_in_the_app_that_holds_the_session(self):
        from unittest import mock
        from hangar_engine import session_library
        row = lambda key, **kw: {"key": key, "title": key, "provider": "claude", "id": key, "activityAt": "2026-08-01T00:00:00+00:00",
                                 "protected": False, "pinned": False, "unread": None, "nativeKnown": False, "archived": False, "appId": None, **kw}
        rows = {"app": row("app", appId="local_app"), "codex": row("codex", provider="codex", nativeKnown=True), "terminal": row("terminal")}
        activity = {k: r["activityAt"] for k, r in rows.items()}
        with tempfile.TemporaryDirectory() as d, mock.patch.object(session_library.config, "LOCAL", Path(d)), \
                mock.patch.object(session_library.codex_library, "call_many", return_value=[{}]) as codex, mock.patch.object(session_library.session_index, "invalidate"):
            done = session_library._archive(session_library.read(), rows, list(rows), {"activity": activity})
            codex.assert_called_once_with("thread/archive", [{"threadId": "codex"}])   # archived in Codex itself
            saved = session_library.read()["sessions"]
            self.assertIn("appArchiveAt", saved["app"])                                    # queued for a Claude session in the app
            self.assertNotIn("archivedAt", saved["app"])
            self.assertIn("archivedAt", saved["terminal"])                                 # no app shows it, so Hangar is its only list
            self.assertNotIn("codex", saved)
            self.assertEqual((done["codexArchived"], done["claudeQueued"], done["hangarOnly"]), (1, 1, 1))


class OpenWith(unittest.TestCase):
    def test_github_desktop_opens_the_folder_as_a_repository(self):
        from unittest import mock
        from hangar_engine import launch
        with tempfile.TemporaryDirectory() as d, mock.patch.object(launch, "available", return_value=[{"id": "github", "name": "GitHub Desktop", "kind": "editor", "how": "app"}]), \
                mock.patch.object(launch, "_open_os") as opened:
            launch.open_in("github", d)
        self.assertTrue(opened.call_args[0][0].startswith("x-github-client://openLocalRepo/"))
        self.assertNotIn("\\", opened.call_args[0][0])


class WhoChangedWhat(unittest.TestCase):
    T = 1793011958  # 26 Oct 2026 10:52:38 UTC

    def session(self, provider, sid, records):
        from hangar_engine import session_index
        state = session_index.fresh(provider, Path(sid + ".jsonl"))
        for record in records:
            session_index.ingest(state, record)
        return state

    def at(self, seconds):
        from hangar_engine.activity import iso
        return iso(self.T + seconds).replace("+00:00", "Z")

    def test_commit_hashes_and_edit_times_come_only_from_git_output_and_confirmed_edits(self):
        claude = self.session("claude", "c1", [
            {"type": "assistant", "cwd": "C:/work/game", "timestamp": self.at(-60), "entrypoint": "claude-desktop", "message": {"content": [
                {"type": "tool_use", "id": "e1", "name": "Edit", "input": {"file_path": "C:/work/game/a.yaml"}},
                {"type": "tool_use", "id": "b1", "name": "Bash", "input": {"command": "git commit -q -m x && git log --oneline -1"}}]}},
            {"type": "user", "timestamp": self.at(-50), "message": {"content": [{"type": "tool_result", "tool_use_id": "e1", "content": "ok"}]}},
            {"type": "user", "timestamp": self.at(1), "message": {"content": [{"type": "tool_result", "tool_use_id": "b1", "content": "0/0\n1bde6ba Revert the depth change"}]}},
            {"type": "user", "timestamp": self.at(2), "message": {"content": [{"type": "tool_result", "tool_use_id": "b2", "content": "\n".join(f"{i}abcdef{i} subject" for i in range(5))}]}},
            {"type": "user", "timestamp": self.at(3), "message": {"content": [{"type": "tool_result", "tool_use_id": "b3", "content": "To https://github.com/a/b.git\n   1bde6ba..6a5bbff  main -> main"}]}},
            {"type": "user", "timestamp": self.at(4), "message": {"content": [{"type": "tool_result", "tool_use_id": "b4", "content": "From https://github.com/a/b\n   6a5bbff..f8c728b  main       -> origin/main"}]}},
        ])
        self.assertEqual(claude["origin"], "claude-desktop")
        self.assertEqual(claude["commits"]["1bde6ba"], [self.T + 1, 0, ""])
        # A five-line log lists only its newest three; a push names the commit it moved main to; a fetch is not a push.
        self.assertEqual({sha: v[1] for sha, v in claude["commits"].items() if sha != "1bde6ba"},
                         {"0abcdef0": -1, "1abcdef1": -1, "2abcdef2": -1, "6a5bbff": -2})
        self.assertEqual([p.rsplit("/", 1)[-1] for p in claude["edits"]], ["a.yaml"])
        self.assertEqual(len(next(iter(claude["edits"].values()))), 1)
        codex = self.session("codex", "x1", [
            {"type": "session_meta", "timestamp": self.at(-900), "payload": {"id": "x1", "cwd": "C:/work/game", "originator": "Codex Desktop"}},
            {"type": "response_item", "timestamp": self.at(500), "payload": {"type": "custom_tool_call_output", "call_id": "c",
             "output": "{\"output\":\"warning: CRLF\\n[main d53955d] Load compact rocket art\\n 4 files changed\"}"}},
        ])
        self.assertEqual(codex["origin"], "Codex Desktop")
        self.assertEqual(codex["commits"]["d53955d"], [self.T + 500, 1, "Load compact rocket art"])

    def test_commits_join_the_session_that_made_them_and_overlaps_are_flagged(self):
        from hangar_engine import activity
        prefix = "c:/work/game"
        claude = {"provider": "claude", "id": "c1", "edits": {}, "commits": {"1bde6ba": [self.T + 1, 0, ""], "aaaa111": [self.T + 1900, 0, ""]}}
        codex = {"provider": "codex", "id": "x1", "edits": {prefix + "/rockets.yaml": [self.T + 400]},
                 "commits": {"d53955d": [self.T + 513, 1, "Load"], "1bde6ba": [self.T + 470, 0, ""]}}
        late = {"provider": "codex", "id": "x2", "edits": {prefix + "/allied.yaml": [self.T - 2 * 3600]}, "commits": {}}
        commit = lambda sha, dt, files, trailer=None: {"sha": sha + "0" * (40 - len(sha)), "at": self.T + dt, "files": files, "trailer": trailer}
        commits = [commit("1bde6ba", 0, ["allied.yaml"], "claude"), commit("d53955d", 513, ["mod.yaml"]),
                   commit("bbbb222", 1200, ["rockets.yaml"]), commit("aaaa111", 0, ["x"]), commit("cccc333", 600, ["allied.yaml"], "claude")]
        claims = activity.attribute(commits, [claude, codex, late], [prefix])
        self.assertEqual(claims[commits[0]["sha"]], {"session": "claude:c1", "evidence": "seen", "why": "printed this commit's hash 1 s after it was made"})
        self.assertEqual(claims[commits[1]["sha"]]["evidence"], "printed")
        self.assertEqual(claims[commits[1]["sha"]]["session"], "codex:x1")
        self.assertEqual(claims[commits[2]["sha"]], {"session": "codex:x1", "evidence": "files", "why": "edited 1 of its 1 files, the last 13 min before it"})
        self.assertNotIn(commits[3]["sha"], claims)  # printed 32 minutes later: looking at history, not making it
        self.assertNotIn(commits[4]["sha"], claims)  # Claude's trailer rules out the Codex session that edited the file
        sessions = [{"key": "claude:c1", "provider": "claude", "_spans": [[self.T, self.T + 900]], "_first": self.T, "_touches": [("a", self.T)]},
                    {"key": "codex:x1", "provider": "codex", "_spans": [[self.T + 6000, self.T + 7000]], "_first": self.T + 6000, "_touches": [("a", self.T + 6000)]},
                    {"key": "codex:x2", "provider": "codex", "_spans": [[self.T + 20 * 3600, self.T + 21 * 3600]], "_first": self.T + 20 * 3600, "_touches": []}]
        bands = activity.overlaps(sessions)
        self.assertEqual(len(bands), 1)
        self.assertEqual(bands[0]["sessions"], ["claude:c1", "codex:x1"])
        self.assertTrue(bands[0]["crossAgent"])
        self.assertEqual(bands[0]["sharedFiles"], ["a"])
        self.assertEqual(activity.spans([10, 20, 20 + 3601]), [[10, 20], [3621, 3621]])

    def test_a_longer_log_or_a_push_counts_only_just_after_the_commit(self):
        from hangar_engine import activity, session_index as si
        maker = {"provider": "claude", "id": "c1", "edits": {}, "commits": {
            "cdfe21e": [self.T + 1, si.LISTED, ""], "16a872b": [self.T + 13, si.PUSHED, ""],
            "45c250f": [self.T + 200, si.LISTED, ""], "aaaa111": [self.T + 1, si.LISTED, ""]}}
        viewer = {"provider": "codex", "id": "x1", "edits": {}, "commits": {"cdfe21e": [self.T + 30, si.SEEN, ""], "16a872b": [self.T + 6 * 86400, si.MADE, "Merge"]}}
        commits = [{"sha": sha + "0" * 33, "at": self.T, "files": [], "trailer": None} for sha in ("cdfe21e", "16a872b", "45c250f", "aaaa111")]
        claims = activity.attribute(commits, [maker, viewer], ["c:/work/game"])
        self.assertEqual(claims[commits[0]["sha"]]["session"], "codex:x1")  # a short reply outranks a longer log
        # Git's own commit line read six days later (a log, a test file) is history: the push still names the maker.
        self.assertEqual(claims[commits[1]["sha"]], {"session": "claude:c1", "evidence": "pushed", "why": "pushed this commit 13 s after it was made"})
        self.assertNotIn(commits[2]["sha"], claims)  # a longer log 200 s later is looking at history
        self.assertEqual(claims[commits[3]["sha"]], {"session": "claude:c1", "evidence": "listed", "why": "listed this commit in a git log 1 s after it was made"})
        # Folding helper agents keeps the first sighting, unless a later one shows the commit was made there.
        self.assertFalse(si.counts_over([self.T + 5, si.SEEN, ""], [self.T + 1, si.LISTED, ""]))
        self.assertTrue(si.counts_over([self.T + 9, si.MADE, "x"], [self.T + 1, si.LISTED, ""]))

    def test_helper_agents_work_counts_for_the_session_that_started_them(self):
        from unittest import mock
        from hangar_engine import config, session_index
        line = lambda record: json.dumps(record) + "\n"
        helper = lambda at, content: {"type": "user", "sessionId": "s1", "isSidechain": True, "cwd": "C:/work/game", "timestamp": self.at(at), "message": {"content": content}}
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            folder = root / ".claude/projects/C--work-game"
            (folder / "s1/subagents/workflows/wf_1").mkdir(parents=True)
            (folder / "gone/subagents").mkdir(parents=True)
            (folder / "s1.jsonl").write_text(line({"type": "user", "sessionId": "s1", "cwd": "C:/work/game", "timestamp": self.at(0), "message": {"content": "go"}}))
            (folder / "s1/subagents/agent-a1.jsonl").write_text(line(helper(60, [{"type": "tool_use", "id": "e1", "name": "Edit", "input": {"file_path": "C:/work/game/a.yaml"}}]))
                                                                + line(helper(70, [{"type": "tool_result", "tool_use_id": "e1", "content": "ok"}])))
            made = helper(900, [{"type": "tool_result", "tool_use_id": "b1", "content": "[main 1bde6ba] Revert the depth change"}])
            (folder / "s1/subagents/workflows/wf_1/agent-a2.jsonl").write_text(line(made))
            (folder / "gone/subagents/agent-a3.jsonl").write_text(line(made))  # its session's transcript is gone
            session_index._view = None
            try:
                with mock.patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": str(root / ".claude"), "CODEX_HOME": str(root / ".codex")}), \
                     mock.patch.object(config, "LOCAL", root / "engine"):
                    index = session_index.collect()
                    self.assertEqual(list(index["files"]), [str(folder / "s1.jsonl")])  # helpers are not sessions of their own
                    entry = index["files"][str(folder / "s1.jsonl")]
                    self.assertEqual((entry["id"], entry["helpers"], entry["lastEvent"]), ("s1", 2, self.at(900)))
                    self.assertEqual({p.rsplit("/", 1)[-1]: t for p, t in entry["edits"].items()}, {"a.yaml": [self.T + 70]})
                    self.assertEqual(entry["commits"], {"1bde6ba": [self.T + 900, 1, "Revert the depth change"]})
                    saved = json.loads((root / "engine/session-index.json").read_text(encoding="utf-8"))
                    self.assertEqual(saved["files"][str(folder / "s1.jsonl")]["commits"], {})  # each transcript keeps its own state
                    self.assertEqual(len(saved["helpers"]), 2)
                    with (folder / "s1/subagents/agent-a1.jsonl").open("a") as f:
                        f.write(line(helper(2000, [{"type": "tool_result", "tool_use_id": "b2", "content": "[main 6a5bbff] Keep the depth"}])))
                    session_index.invalidate()
                    entry = session_index.collect()["files"][str(folder / "s1.jsonl")]
                    self.assertEqual(sorted(entry["commits"]), ["1bde6ba", "6a5bbff"])
                    self.assertEqual(list(entry["edits"].values()), [[self.T + 70]])  # read once, not again on the next pass
            finally:
                session_index._view = None
                session_index._checked = 0.0

    def test_scratch_folder_runs_are_test_runs(self):
        from hangar_engine import session_index
        folders = session_index.temp_folders()
        self.assertTrue(session_index.in_temp(str(Path(tempfile.gettempdir()) / "claude" / "probe"), folders))
        self.assertTrue(session_index.in_temp("\\\\?\\" + str(Path(tempfile.gettempdir()) / "x"), folders))
        self.assertFalse(session_index.in_temp(str(Path.home() / "Code" / "game"), folders))
        self.assertFalse(session_index.in_temp("", folders))


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

    def test_activity_joins_main_branch_commits_with_sessions(self):
        rid = self.project()["id"]
        result = self.read(f"/api/activity?repo={rid}&days=7")
        self.assertTrue(result["available"])
        self.assertIn(result["branch"], ("main", "master"))
        self.assertEqual(result["commits"], [])  # the sample's commits are from 2025
        self.assertEqual(result["overlaps"], [])
        week = self.read(f"/api/activity?repo={rid}&days=7&until=1739318399")  # an earlier week, ending 11 Feb 2025
        self.assertEqual([c["subject"] for c in week["commits"]], ["fix: correct core value"])
        self.assertEqual((week["from"], week["to"]), ("2025-02-04T23:59:59+00:00", "2025-02-11T23:59:59+00:00"))
        self.assertEqual(len(self.read("/api/activity/all?days=7&until=1739318399")["projects"]), 1)
        later = self.read(f"/api/activity?repo={rid}&days=7&until=99999999999")  # never past the present
        self.assertLessEqual(datetime.fromisoformat(later["to"]).timestamp(), time.time() + 1)
        for bad in ("yesterday", "-5", "1739318399.5"):
            with self.assertRaises(urllib.error.HTTPError) as error:
                self.read(f"/api/activity?repo={rid}&days=7&until={bad}")
            self.assertEqual(error.exception.code, 400)
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.read(f"/api/activity?repo={rid}&days=90")
        self.assertEqual(error.exception.code, 400)
        sha = subprocess.run(["git", "-C", str(self.repo), "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
        commit = self.read(f"/api/commit?repo={rid}&sha={sha[:9]}")
        self.assertEqual(commit["subject"], "fix: correct core value")
        self.assertEqual([(f["path"], f["added"], f["removed"]) for f in commit["files"]], [("src/core/value.ts", 1, 1)])
        self.assertIn("+export const value = 2;", commit["files"][0]["patch"])
        first = subprocess.run(["git", "-C", str(self.repo), "rev-list", "--max-parents=0", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
        self.assertEqual(self.read(f"/api/commit?repo={rid}&sha={first}")["fileCount"], 4)  # a first commit, against nothing
        for bad in ("zzzzzzz", "--all", "1234567"):
            with self.assertRaises(urllib.error.HTTPError) as error:
                self.read(f"/api/commit?repo={rid}&sha={bad}")
            self.assertEqual(error.exception.code, 400)
        every = self.read("/api/activity/all?days=7")
        self.assertTrue(every["available"])
        self.assertEqual(every["projects"], [])  # a quiet week leaves no project on the board
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.read("/api/activity/all?days=0")
        self.assertEqual(error.exception.code, 400)

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
