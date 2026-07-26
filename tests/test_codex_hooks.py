"""Black-box contract tests for the Codex lifecycle hook and sync marker.

These tests intentionally invoke the public command-line interfaces instead of
importing implementation details:

    python hooks/codex/engramory_codex_hook.py \
        --memory-root ROOT --sync-tool TOOL --mode explicit

    python tools/engramory_sync.py mark-synced ROOT --session-id SID

The suite uses only the Python 3.9 standard library and can run either through
unittest directly or through pytest's unittest discovery.
"""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


REPO_ROOT = Path(__file__).resolve().parents[1]
HOOK = REPO_ROOT / "hooks" / "codex" / "engramory_codex_hook.py"
SYNC = REPO_ROOT / "tools" / "engramory_sync.py"


class CodexHookContractTests(unittest.TestCase):
    maxDiff = None

    @classmethod
    def setUpClass(cls):
        if not HOOK.is_file():
            raise AssertionError("missing Codex hook: {0}".format(HOOK))
        if not SYNC.is_file():
            raise AssertionError("missing Engramory sync tool: {0}".format(SYNC))

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.project = Path(self._tmp.name) / "project"
        self.memory_root = self.project / ".engramory-memory"
        self.memory_root.mkdir(parents=True)
        self.state_path = self.memory_root / ".engramory-codex-state.json"
        self._write_store()

    def _write_store(self, detail_body=None):
        if detail_body is None:
            detail_body = (
                "Continue the authentication migration from the serializer tests.\n\n"
                "**Why:** The implementation is unfinished and the next thread must "
                "retain the decision boundary.\n"
                "**How to apply:** Re-check git status, then run the serializer test "
                "before editing.\n"
            )
        (self.memory_root / "project-active-auth.md").write_text(
            "---\n"
            "name: project-active-auth\n"
            "description: Resume the active authentication migration\n"
            "type: project\n"
            "created: 2026-07-26\n"
            "updated: 2026-07-26\n"
            "---\n\n"
            + detail_body,
            encoding="utf-8",
        )
        (self.memory_root / "feedback-verify.md").write_text(
            "---\n"
            "name: feedback-verify\n"
            "description: Verify observable state before reporting completion\n"
            "type: feedback\n"
            "created: 2026-07-26\n"
            "updated: 2026-07-26\n"
            "---\n\n"
            "Verify work before claiming it is complete.\n\n"
            "**Why:** Stale summaries have previously hidden incomplete work.\n"
            "**How to apply:** Inspect the diff and run the focused test.\n",
            encoding="utf-8",
        )
        (self.memory_root / "MEMORY.md").write_text(
            "# Memory Index\n\n"
            "## user\n\n"
            "## feedback\n"
            "- [Verify before done](feedback-verify.md) — verify observable state\n\n"
            "## project\n"
            "- [Active authentication migration](project-active-auth.md) — "
            "unfinished serializer work and next step\n\n"
            "## reference\n",
            encoding="utf-8",
        )

    @staticmethod
    def _base_event(event_name, session_id, cwd, **extra):
        event = {
            "session_id": session_id,
            "transcript_path": None,
            "cwd": str(cwd),
            "hook_event_name": event_name,
            "model": "gpt-test",
        }
        if event_name == "SessionStart":
            event.update(
                {
                    "permission_mode": "default",
                    "source": "startup",
                }
            )
        else:
            event["turn_id"] = "turn-1"
        event.update(extra)
        return event

    def _run(self, argv, input_text=None):
        env = dict(os.environ)
        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONUTF8"] = "1"
        return subprocess.run(
            [sys.executable] + [str(arg) for arg in argv],
            input=input_text,
            capture_output=True,
            text=True,
            cwd=str(REPO_ROOT),
            env=env,
            timeout=15,
        )

    def _run_hook(self, event, mode="explicit"):
        return self._run(
            [
                HOOK,
                "--memory-root",
                self.memory_root,
                "--sync-tool",
                SYNC,
                "--mode",
                mode,
            ],
            input_text=json.dumps(event, ensure_ascii=False),
        )

    def _run_sync(self, *args):
        return self._run([SYNC] + list(args))

    def _hook_json(self, process):
        self.assertEqual(
            process.returncode,
            0,
            "hook failed\nstdout: {0}\nstderr: {1}".format(
                process.stdout, process.stderr
            ),
        )
        text = (process.stdout or "").strip()
        if not text:
            return {}
        try:
            value = json.loads(text)
        except ValueError as exc:
            self.fail(
                "hook stdout is not one JSON object: {0}\nstdout: {1}\nstderr: {2}".format(
                    exc, process.stdout, process.stderr
                )
            )
        self.assertIsInstance(value, dict)
        return value

    @staticmethod
    def _additional_context(output):
        specific = output.get("hookSpecificOutput") or {}
        return specific.get("additionalContext") or ""

    def _read_state(self):
        self.assertTrue(self.state_path.is_file(), "hook did not create session state")
        return json.loads(self.state_path.read_text(encoding="utf-8"))

    def _session_state(self, session_id):
        state = self._read_state()
        self.assertEqual(state.get("schema_version"), 1)
        sessions = state.get("sessions")
        self.assertIsInstance(sessions, dict)
        self.assertIn(session_id, sessions)
        return sessions[session_id]

    def _mark_dirty(self, session_id, prompt="Continue the current implementation"):
        event = self._base_event(
            "UserPromptSubmit",
            session_id,
            self.project,
            permission_mode="default",
            prompt=prompt,
        )
        output = self._hook_json(self._run_hook(event))
        self.assertNotEqual(output.get("continue"), False)

    def test_session_start_recall_is_useful_and_bounded(self):
        huge_detail = (
            "ACTIVE-DETAIL-BEGIN\n"
            + ("large detail that must not be injected without a bound\n" * 5000)
            + "ACTIVE-DETAIL-END\n\n"
            "**Why:** This intentionally exercises the recall bound.\n"
            "**How to apply:** Inject only a bounded prefix or index context.\n"
        )
        self._write_store(detail_body=huge_detail)
        event = self._base_event(
            "SessionStart", "session-bounded", self.project, source="startup"
        )
        output = self._hook_json(self._run_hook(event))

        specific = output.get("hookSpecificOutput") or {}
        self.assertEqual(specific.get("hookEventName"), "SessionStart")
        context = self._additional_context(output)
        self.assertTrue(context, "SessionStart must inject recall context")
        self.assertIn(str(self.memory_root / "MEMORY.md"), context)
        self.assertRegex(context.lower(), r"read|recall|memory")
        # SessionStart injects navigation and protocol guidance, never MEMORY.md or
        # detail bodies themselves. Its public UTF-8 budget is 4 KiB.
        self.assertLessEqual(len(context.encode("utf-8")), 4096)
        self.assertNotIn("Active authentication migration", context)
        self.assertNotIn("project-active-auth.md", context)
        self.assertNotIn("ACTIVE-DETAIL-BEGIN", context)
        self.assertNotIn("ACTIVE-DETAIL-END", context)

    def test_session_start_capture_modes_have_honest_distinct_guidance(self):
        explicit_event = self._base_event(
            "SessionStart", "session-explicit", self.project, source="startup"
        )
        assisted_event = self._base_event(
            "SessionStart", "session-assisted", self.project, source="startup"
        )

        explicit = self._additional_context(
            self._hook_json(self._run_hook(explicit_event, mode="explicit"))
        )
        assisted = self._additional_context(
            self._hook_json(self._run_hook(assisted_event, mode="assisted"))
        )

        self.assertIn("Explicit mode", explicit)
        self.assertIn("continuity boundary", explicit)
        self.assertIn("Assisted mode", assisted)
        self.assertIn("proactively", assisted)
        for context in (explicit, assisted):
            self.assertIn("only records", context)
            self.assertRegex(context.lower(), r"does not summarize|does not.*edit")

    def test_emitted_mark_synced_command_handles_shell_metacharacter_paths(self):
        project = Path(self._tmp.name) / "project & %ENGRAMORY_META% 'quoted'"
        memory_root = project / ".engramory-memory"
        memory_root.mkdir(parents=True)
        (memory_root / "MEMORY.md").write_text(
            "# Memory Index\n", encoding="utf-8")
        event = self._base_event(
            "SessionStart", "session-command", project, source="startup"
        )
        hook = self._run(
            [
                HOOK,
                "--memory-root",
                memory_root,
                "--sync-tool",
                SYNC,
                "--mode",
                "explicit",
            ],
            input_text=json.dumps(event),
        )
        context = self._additional_context(self._hook_json(hook))
        command = context.split("run:\n", 1)[1].splitlines()[0]

        env = dict(os.environ)
        env["ENGRAMORY_META"] = "THIS_MUST_NOT_EXPAND"
        if os.name == "nt":
            self.assertTrue(command.startswith("& "))
            process = subprocess.run(
                [
                    "powershell.exe",
                    "-NoLogo",
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    command,
                ],
                capture_output=True,
                text=True,
                cwd=str(project),
                env=env,
                timeout=20,
            )
        else:
            process = subprocess.run(
                ["/bin/sh", "-lc", command],
                capture_output=True,
                text=True,
                cwd=str(project),
                env=env,
                timeout=20,
            )

        self.assertEqual(
            process.returncode,
            0,
            "emitted command failed\nstdout: {0}\nstderr: {1}".format(
                process.stdout, process.stderr),
        )
        self.assertIn("acknowledgement recorded", process.stdout)
        state = json.loads(
            (memory_root / ".engramory-codex-state.json").read_text(
                encoding="utf-8"))
        record = state["sessions"]["session-command"]
        self.assertIs(record.get("dirty"), False)
        self.assertTrue(record.get("memory_index_sha256"))

    def test_user_prompt_marks_dirty_without_persisting_prompt(self):
        session_id = "session-dirty"
        secret_prompt = (
            "private prompt marker 6f0ad6aa: continue work, but never persist this text"
        )
        self._mark_dirty(session_id, secret_prompt)

        session = self._session_state(session_id)
        self.assertIs(session.get("dirty"), True)
        self.assertGreaterEqual(session.get("dirty_generation", 0), 1)
        state_text = self.state_path.read_text(encoding="utf-8")
        self.assertNotIn(secret_prompt, state_text)
        self.assertNotIn("6f0ad6aa", state_text)

        # The hook owns only bookkeeping state. A prompt must not leak into any
        # other file in the memory root either.
        for path in self.memory_root.rglob("*"):
            if path.is_file():
                self.assertNotIn(
                    secret_prompt,
                    path.read_text(encoding="utf-8", errors="replace"),
                    "prompt leaked to {0}".format(path),
                )

    def test_manual_compact_blocks_until_mark_synced_then_is_idempotent(self):
        session_id = "session-manual"
        self._mark_dirty(session_id)
        precompact = self._base_event(
            "PreCompact",
            session_id,
            self.project,
            model="gpt-test",
            trigger="manual",
        )

        blocked = self._hook_json(self._run_hook(precompact))
        self.assertIs(blocked.get("continue"), False)
        self.assertTrue(blocked.get("stopReason"))
        self.assertRegex(
            blocked.get("stopReason", "").lower(), r"engramory|sync|mark-synced"
        )

        memory_before = {
            path.name: path.read_bytes()
            for path in self.memory_root.iterdir()
            if path.is_file() and path != self.state_path
        }
        first = self._run_sync(
            "mark-synced", self.memory_root, "--session-id", session_id
        )
        self.assertEqual(
            first.returncode,
            0,
            "mark-synced failed\nstdout: {0}\nstderr: {1}".format(
                first.stdout, first.stderr
            ),
        )
        clean_session = self._session_state(session_id)
        self.assertIs(clean_session.get("dirty"), False)
        self.assertIs(clean_session.get("needs_reconcile"), False)
        self.assertEqual(
            {
                path.name: path.read_bytes()
                for path in self.memory_root.iterdir()
                if path.is_file() and path != self.state_path
            },
            memory_before,
            "mark-synced must record validation, not edit memories",
        )

        allowed = self._hook_json(self._run_hook(precompact))
        self.assertNotEqual(allowed.get("continue"), False)

        state_after_first = self.state_path.read_bytes()
        second = self._run_sync(
            "mark-synced", self.memory_root, "--session-id", session_id
        )
        self.assertEqual(
            second.returncode,
            0,
            "repeated mark-synced failed\nstdout: {0}\nstderr: {1}".format(
                second.stdout, second.stderr
            ),
        )
        self.assertEqual(
            self.state_path.read_bytes(),
            state_after_first,
            "mark-synced must be a no-op when the clean state and index are unchanged",
        )

    def test_auto_compact_does_not_block_and_next_start_requires_reconcile(self):
        session_id = "session-auto"
        self._mark_dirty(session_id)
        event = self._base_event(
            "PreCompact",
            session_id,
            self.project,
            model="gpt-test",
            trigger="auto",
        )
        output = self._hook_json(self._run_hook(event))
        self.assertNotEqual(output.get("continue"), False)
        self.assertTrue(output.get("systemMessage"))

        session = self._session_state(session_id)
        self.assertIs(session.get("dirty"), True)
        self.assertIs(session.get("needs_reconcile"), True)

        start = self._base_event(
            "SessionStart", session_id, self.project, source="compact"
        )
        start_output = self._hook_json(self._run_hook(start))
        reminder = (
            self._additional_context(start_output)
            + "\n"
            + (start_output.get("systemMessage") or "")
        ).lower()
        self.assertRegex(reminder, r"reconcile|sync|unsynced|engramory")
        self.assertIs(self._session_state(session_id).get("needs_reconcile"), True)

    def test_unknown_compact_trigger_fails_open_and_marks_reconcile(self):
        session_id = "session-unknown-trigger"
        self._mark_dirty(session_id)
        event = self._base_event(
            "PreCompact",
            session_id,
            self.project,
            model="gpt-test",
            trigger="future-trigger",
        )

        output = self._hook_json(self._run_hook(event))

        self.assertNotEqual(output.get("continue"), False)
        self.assertTrue(output.get("systemMessage"))
        self.assertRegex(
            output.get("systemMessage", "").lower(),
            r"unknown|reconcile|unsynced|engramory",
        )
        session = self._session_state(session_id)
        self.assertIs(session.get("dirty"), True)
        self.assertIs(session.get("needs_reconcile"), True)

    def test_session_pruning_never_discards_dirty_state_silently(self):
        def record(dirty):
            return {
                "dirty": dirty,
                "needs_reconcile": False,
                "dirty_generation": 1 if dirty else 0,
                "synced_generation": 0,
                "updated_at": "2026-07-26T00:00:00Z",
            }

        sessions = {
            "dirty-{0}".format(i): record(True) for i in range(63)
        }
        sessions.update(
            {"clean-{0}".format(i): record(False) for i in range(7)}
        )
        self.state_path.write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "updated_at": "2026-07-26T00:00:00Z",
                    "last_session_id": "clean-6",
                    "sessions": sessions,
                }
            ),
            encoding="utf-8",
        )
        start = self._base_event(
            "SessionStart", "current-clean", self.project, source="startup"
        )
        output = self._hook_json(self._run_hook(start))
        self.assertFalse(output.get("systemMessage"))
        pruned = self._read_state()["sessions"]
        self.assertEqual(len(pruned), 64)
        self.assertIn("current-clean", pruned)
        for i in range(63):
            self.assertIn("dirty-{0}".format(i), pruned)

    def test_session_cap_overflow_leaves_the_current_session_recoverable(self):
        """Overflow must bound the state WITHOUT stranding the current session.

        Regression: the cap used to raise once every slot held unsynced work, so
        the arriving session's own record was never written. The hook then
        blocked manual compaction while naming that unwritten session id, and the
        `mark-synced` command it emitted could only answer "unknown session id" —
        its own recovery instruction was impossible to follow. Eviction now drops
        the OLDEST unsynced records and carries their count forward instead.
        """
        sessions = {}
        for i in range(64):
            record = {
                "dirty": True,
                "needs_reconcile": False,
                "dirty_generation": 1,
                "synced_generation": 0,
                # Distinct ages so eviction order is deterministic.
                "updated_at": "2026-07-26T00:{0:02d}:00Z".format(i),
            }
            sessions["dirty-{0:02d}".format(i)] = record
        self.state_path.write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "updated_at": "2026-07-26T00:00:00Z",
                    "last_session_id": "dirty-63",
                    "sessions": sessions,
                }
            ),
            encoding="utf-8",
        )

        # A 65th session must still be able to record itself.
        prompt = self._base_event(
            "UserPromptSubmit", "current-65", self.project, prompt="do work"
        )
        self.assertIs(self._hook_json(self._run_hook(prompt)).get("continue"), True)
        state = self._read_state()
        self.assertIn("current-65", state["sessions"])
        self.assertLessEqual(len(state["sessions"]), 64)
        # The evicted unsynced work is COUNTED, never silently forgotten...
        self.assertGreaterEqual(state.get("dropped_unsynced_sessions", 0), 1)
        # ...and the oldest record is the one that goes.
        self.assertNotIn("dirty-00", state["sessions"])

        # The gate still holds for the current (dirty) session...
        manual = self._base_event(
            "PreCompact", "current-65", self.project, trigger="manual"
        )
        blocked = self._hook_json(self._run_hook(manual))
        self.assertIs(blocked.get("continue"), False)

        # ...and the recovery the hook points at must actually work now.
        result = self._run_sync(
            "mark-synced", self.memory_root, "--session-id", "current-65"
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIs(self._hook_json(self._run_hook(manual)).get("continue"), True)

    def test_unprovable_state_never_opens_the_manual_gate(self):
        """A record that cannot PROVE it is synced must fail closed.

        The store is user-visible plain text, so an editor, another process, or a
        partial write can leave a record incomplete or self-contradictory. Such a
        record must never read as "clean" and let a manual compaction through.
        """
        manual = self._base_event(
            "PreCompact", "s", self.project, trigger="manual"
        )

        def gate_with(session_record):
            self.state_path.write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "updated_at": "2026-07-26T00:00:00Z",
                        "last_session_id": "s",
                        "sessions": {"s": session_record},
                    }
                ),
                encoding="utf-8",
            )
            return self._hook_json(self._run_hook(manual)).get("continue")

        # Generations prove unsynced work even though the flag claims clean.
        self.assertIs(
            gate_with(
                {
                    "dirty": False,
                    "needs_reconcile": False,
                    "dirty_generation": 2,
                    "synced_generation": 1,
                }
            ),
            False,
        )
        # No safety fields at all.
        self.assertIs(gate_with({}), False)
        # Flag present but not a boolean.
        self.assertIs(
            gate_with(
                {
                    "dirty": "false",
                    "needs_reconcile": False,
                    "dirty_generation": 0,
                    "synced_generation": 0,
                }
            ),
            False,
        )
        # Control: an honest, self-consistent clean record still passes, so the
        # guard tightens the gate without wedging it shut.
        self.assertIs(
            gate_with(
                {
                    "dirty": False,
                    "needs_reconcile": False,
                    "dirty_generation": 3,
                    "synced_generation": 3,
                }
            ),
            True,
        )

    def test_fresh_session_receives_recall_without_prior_state(self):
        self.assertFalse(self.state_path.exists())
        event = self._base_event(
            "SessionStart", "brand-new-session", self.project, source="startup"
        )
        output = self._hook_json(self._run_hook(event))
        context = self._additional_context(output)
        self.assertIn(str(self.memory_root / "MEMORY.md"), context)
        self.assertRegex(context.lower(), r"read|recall|memory")
        # Recall remains selective: the hook points at the index instead of
        # preloading its contents into every fresh session.
        self.assertNotIn("Verify before done", context)
        self.assertNotIn("Active authentication migration", context)
        self.assertNotEqual(output.get("continue"), False)

    def test_corrupt_state_and_malformed_hook_input_are_visible(self):
        self.state_path.write_text("{not valid json", encoding="utf-8")
        event = self._base_event(
            "SessionStart", "session-corrupt", self.project, source="startup"
        )
        corrupt = self._run_hook(event)
        combined = ((corrupt.stdout or "") + "\n" + (corrupt.stderr or "")).strip()
        self.assertTrue(combined, "corrupt state must not fail silently")
        self.assertRegex(combined.lower(), r"error|corrupt|invalid|state|json")
        if corrupt.returncode == 0:
            parsed = self._hook_json(corrupt)
            visible = (
                (parsed.get("systemMessage") or "")
                + "\n"
                + self._additional_context(parsed)
            )
            self.assertTrue(visible.strip(), "recovered corruption needs a visible warning")

        malformed = self._run(
            [
                HOOK,
                "--memory-root",
                self.memory_root,
                "--sync-tool",
                SYNC,
                "--mode",
                "explicit",
            ],
            input_text="{definitely not hook json",
        )
        malformed_text = (
            (malformed.stdout or "") + "\n" + (malformed.stderr or "")
        ).strip()
        self.assertTrue(malformed_text, "hook parse failure must be visible")
        self.assertRegex(malformed_text.lower(), r"error|invalid|json|parse")
        if malformed.returncode == 0:
            parsed = self._hook_json(malformed)
            self.assertTrue(
                (parsed.get("systemMessage") or "").strip(),
                "a zero-exit parse failure must surface through systemMessage",
            )

    def test_mark_synced_rejects_over_cap_index_and_keeps_session_dirty(self):
        session_id = "session-over-cap"
        self._mark_dirty(session_id)
        self.assertIs(self._session_state(session_id).get("dirty"), True)

        # 201 content lines exceed the public 200-line hard limit.
        (self.memory_root / "MEMORY.md").write_text(
            "\n".join("pointer-{0}".format(i) for i in range(201)),
            encoding="utf-8",
        )
        process = self._run_sync(
            "mark-synced", self.memory_root, "--session-id", session_id
        )
        self.assertNotEqual(process.returncode, 0)
        combined = ((process.stdout or "") + "\n" + (process.stderr or "")).lower()
        self.assertRegex(combined, r"over|hard|limit|200|cap")
        session = self._session_state(session_id)
        self.assertIs(session.get("dirty"), True)
        self.assertNotEqual(
            session.get("synced_generation"), session.get("dirty_generation")
        )

    def test_mark_synced_rejects_symlinked_index(self):
        session_id = "session-symlink-index"
        self._mark_dirty(session_id)
        external = self.project / "external-index.md"
        external.write_text("# external index\n", encoding="utf-8")
        index = self.memory_root / "MEMORY.md"
        index.unlink()
        try:
            os.symlink(str(external), str(index))
        except (OSError, NotImplementedError, AttributeError):
            self.skipTest("symlink creation is unavailable on this platform")

        process = self._run_sync(
            "mark-synced", self.memory_root, "--session-id", session_id
        )

        self.assertNotEqual(process.returncode, 0)
        combined = ((process.stdout or "") + "\n" + (process.stderr or "")).lower()
        self.assertIn("symlink", combined)
        self.assertIs(self._session_state(session_id).get("dirty"), True)

    def test_a_session_never_observed_cannot_open_the_manual_gate(self):
        """A compaction that is the FIRST event for a session must fail closed.

        The bookkeeping cannot have seen the prompts that came before, so it has
        no evidence the work is synced. This happens when the hooks are trusted
        mid-session, when the state file is deleted or reset, or when an earlier
        dirty write failed. Synthesizing a blank 'clean' record and letting the
        manual gate open is the exact opposite of the fail-closed contract.
        """
        manual = self._base_event(
            "PreCompact", "never-observed", self.project, trigger="manual"
        )
        blocked = self._hook_json(self._run_hook(manual))
        self.assertIs(blocked.get("continue"), False)

        # A session the hook DID observe, with no prompt submitted, is genuinely
        # clean and must still pass — the guard tightens without wedging.
        self._run_hook(
            self._base_event("SessionStart", "observed", self.project, source="startup")
        )
        allowed = self._hook_json(
            self._run_hook(
                self._base_event(
                    "PreCompact", "observed", self.project, trigger="manual"
                )
            )
        )
        self.assertIs(allowed.get("continue"), True)


if __name__ == "__main__":
    unittest.main()
